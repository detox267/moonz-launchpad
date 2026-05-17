import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  MINT_SIZE,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";

import { AapedLaunch } from "../target/types/aaped_launch";

/**
 * AAPED / Moonz localnet full launch + trade test.
 *
 * This file can:
 * 1. Create a fresh mint.
 * 2. Fund launch escrow.
 * 3. Initialize launch.
 * 4. Initialize immutable metadata.
 * 5. Finalize mint/freeze authorities.
 * 6. Execute dev buy from escrow.
 * 7. Settle escrow leftover to launch-fee wallet.
 * 8. Print state.
 * 9. Optionally test buy/sell routes.
 *
 * Run:
 * anchor test --skip-build --skip-deploy --skip-local-validator
 *
 * Optional:
 * TEST_BUY_SOL=0.1 anchor test --skip-build --skip-deploy --skip-local-validator
 * TEST_BUY_SOL=0.1 TEST_SELL_ALL=true anchor test --skip-build --skip-deploy --skip-local-validator
 *
 * Existing mint/state mode:
 * TARGET_MINT=<mint> anchor test --skip-build --skip-deploy --skip-local-validator
 */

const PROGRAM_ID = new PublicKey(
  process.env.AAPED_PROGRAM_ID ||
    process.env.PROGRAM_ID ||
    "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk"
);

// Must match PLATFORM_WALLET in lib.rs.
const PLATFORM_WALLET = new PublicKey(
  process.env.PLATFORM_WALLET ||
    "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

// Must match LAUNCH_FEE_WALLET in lib.rs.
const LAUNCH_FEE_WALLET = new PublicKey(
  process.env.LAUNCH_FEE_WALLET ||
    "7Ky9cCM29q4pGThCLfJz7fBKVZZNHYtB7EbThZU9uQRC"
);

// Must match USDC_MINT in lib.rs.
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  process.env.MPL_PROGRAM_ID ||
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const TARGET_MINT = process.env.TARGET_MINT
  ? new PublicKey(process.env.TARGET_MINT)
  : null;

const PHASE = {
  PENDING_DEV_BUY: 0,
  BONDING: 1,
  MIGRATION_PENDING: 2,
  AMM_LIVE: 3,
  MIGRATED: 4,
  SWITCHING: 5,
} as const;

const QUOTE = {
  SOL: 0,
  USDC: 1,
} as const;

const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY_BASE = new anchor.BN("1000000000000000"); // 1,000,000,000 * 1e6
const SALE_SUPPLY_BASE = new anchor.BN("650000000000000"); // 650,000,000 * 1e6
const LP_SUPPLY_BASE = new anchor.BN("350000000000000"); // 350,000,000 * 1e6

const DEFAULT_DEV_BUY_SOL = Number(process.env.DEV_BUY_SOL || "0.1");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function envNumber(name: string, fallback = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;

  const n = Number(raw);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }

  return n;
}

function phaseName(v: number): string {
  switch (v) {
    case PHASE.PENDING_DEV_BUY:
      return "pending_dev_buy";
    case PHASE.BONDING:
      return "bonding";
    case PHASE.MIGRATION_PENDING:
      return "migration_pending";
    case PHASE.AMM_LIVE:
      return "amm_live";
    case PHASE.MIGRATED:
      return "migrated";
    case PHASE.SWITCHING:
      return "switching";
    default:
      return `unknown_${v}`;
  }
}

function quoteName(v: number): string {
  if (v === QUOTE.SOL) return "SOL/WSOL";
  if (v === QUOTE.USDC) return "USDC";
  return `unknown_${v}`;
}

function bnToString(v: any): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v.toString === "function") return v.toString();
  return String(v);
}

function solToLamportsBn(sol: number): anchor.BN {
  return new anchor.BN(Math.floor(sol * anchor.web3.LAMPORTS_PER_SOL).toString());
}

function usdcToBaseBn(usdc: number): anchor.BN {
  return new anchor.BN(Math.floor(usdc * 1_000_000).toString());
}

async function confirmViaWs(
  connection: anchor.web3.Connection,
  signature: string,
  commitment: Commitment = "finalized",
  timeoutMs = 60000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Signature confirmation timeout: ${signature}`));
    }, timeoutMs);

    let subId: number | undefined;

    subId = connection.onSignature(
      signature,
      async (notif) => {
        clearTimeout(timer);

        if (subId !== undefined) {
          try {
            await connection.removeSignatureListener(subId);
          } catch {}
        }

        if (notif.err) {
          reject(new Error(`Tx failed (${signature}): ${JSON.stringify(notif.err)}`));
        } else {
          resolve();
        }
      },
      commitment
    );
  });
}

async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  return Boolean(await connection.getAccountInfo(pubkey, "confirmed"));
}

async function assertAccountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  label: string
): Promise<void> {
  const exists = await accountExists(connection, pubkey);

  if (!exists) {
    throw new Error(
      `${label} does not exist on this cluster: ${pubkey.toBase58()}\n` +
        `For localnet, restart validator with cloned accounts or change the program constant for local testing.`
    );
  }
}

async function maybeCreateAtaIx(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false);

  if (await accountExists(connection, ata)) {
    return { ata, ix: null };
  }

  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
  };
}

function pushMaybe(ixs: TransactionInstruction[], ix: TransactionInstruction | null) {
  if (ix) ixs.push(ix);
}

async function getTokenRawBalance(
  connection: anchor.web3.Connection,
  ata: PublicKey
): Promise<string> {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return "0";

  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  return bal.value.amount;
}

function derivePdas(programId: PublicKey, mint: PublicKey) {
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    programId
  );

  const [launchEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("launch_escrow"), mint.toBuffer()],
    programId
  );

  const [escrowSolVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_sol"), mint.toBuffer()],
    programId
  );

  const [launchState] = PublicKey.findProgramAddressSync(
    [Buffer.from("launch_state"), mint.toBuffer()],
    programId
  );

  const [saleVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sale_vault"), mint.toBuffer()],
    programId
  );

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), mint.toBuffer()],
    programId
  );

  const [treasuryWsolVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_wsol"), mint.toBuffer()],
    programId
  );

  const [treasuryUsdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_usdc"), mint.toBuffer()],
    programId
  );

  const [metadata, metadataBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );

  return {
    mintAuthority,
    launchEscrow,
    escrowSolVault,
    launchState,
    saleVault,
    lpVault,
    treasuryWsolVault,
    treasuryUsdcVault,
    metadata,
    metadataBump,
  };
}

async function createLaunchMint({
  provider,
  programId,
}: {
  provider: anchor.AnchorProvider;
  programId: PublicKey;
}) {
  const mint = Keypair.generate();

  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    programId
  );

  const rent = await provider.connection.getMinimumBalanceForRentExemption(
    MINT_SIZE
  );

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mint.publicKey,
      TOKEN_DECIMALS,
      mintAuthority,
      mintAuthority,
      TOKEN_PROGRAM_ID
    )
  );

  const sig = await provider.sendAndConfirm(tx, [mint]);

  console.log("Create mint sig:", sig);
  console.log("Created mint:", mint.publicKey.toBase58());
  console.log("Mint authority PDA:", mintAuthority.toBase58());

  return {
    mint,
    mintPubkey: mint.publicKey,
    mintAuthority,
  };
}

async function createFreshLaunch({
  program,
  provider,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  if (!user.publicKey.equals(PLATFORM_WALLET)) {
    throw new Error(
      `Anchor wallet must be the PLATFORM_WALLET for this local test.\n` +
        `Current wallet: ${user.publicKey.toBase58()}\n` +
        `PLATFORM_WALLET: ${PLATFORM_WALLET.toBase58()}\n` +
        `Set Anchor.toml wallet to the platform wallet keypair or update PLATFORM_WALLET in lib.rs for local testing.`
    );
  }

  await assertAccountExists(connection, NATIVE_MINT, "WSOL mint");
  await assertAccountExists(connection, USDC_MINT, "USDC mint");
  await assertAccountExists(connection, TOKEN_METADATA_PROGRAM_ID, "Metaplex Token Metadata program");

  const { mintPubkey } = await createLaunchMint({
    provider,
    programId: program.programId,
  });

  const pdas = derivePdas(program.programId, mintPubkey);

  const devBuyLamports = solToLamportsBn(DEFAULT_DEV_BUY_SOL);

  console.log("Funding launch escrow...");
  const fundSig = await program.methods
    .fundLaunchEscrow(devBuyLamports)
    .accounts({
      creator: user.publicKey,
      mint: mintPubkey,
      launchEscrow: pdas.launchEscrow,
      escrowSolVault: pdas.escrowSolVault,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("fundLaunchEscrow sig:", fundSig);
  await confirmViaWs(connection, fundSig, "finalized");

  const initParams = {
    creator: user.publicKey,
    platform: PLATFORM_WALLET,
    coreAuthority: user.publicKey,
    totalSupply: TOTAL_SUPPLY_BASE,
    saleSupply: SALE_SUPPLY_BASE,
    lpSupply: LP_SUPPLY_BASE,
    feeTotalBps: 125,
    feeCreatorBps: 7000,
    feePlatformBps: 3000,
    ammType: 0,
    name: process.env.TEST_NAME || "Moonz Test",
    symbol: process.env.TEST_SYMBOL || "MOONZT",
    uri:
      process.env.TEST_URI ||
      "https://example.com/moonz-test-metadata.json",
  };

  console.log("Initializing launch...");
  const initSig = await program.methods
    .initializeLaunch(initParams)
    .accounts({
      platformSigner: user.publicKey,
      mintAuthority: pdas.mintAuthority,
      mint: mintPubkey,
      launchEscrow: pdas.launchEscrow,
      wsolMint: NATIVE_MINT,
      usdcMint: USDC_MINT,
      launchState: pdas.launchState,
      saleVault: pdas.saleVault,
      lpVault: pdas.lpVault,
      treasuryWsolVault: pdas.treasuryWsolVault,
      treasuryUsdcVault: pdas.treasuryUsdcVault,
      escrowSolVault: pdas.escrowSolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("initializeLaunch sig:", initSig);
  await confirmViaWs(connection, initSig, "finalized");

  console.log("Initializing metadata...");
  const metaParams = {
    name: initParams.name,
    symbol: initParams.symbol,
    uri: initParams.uri,
  };

  const metaSig = await program.methods
    .initializeMetadata(pdas.metadataBump, metaParams)
    .accounts({
      payer: user.publicKey,
      mintAuthority: pdas.mintAuthority,
      mint: mintPubkey,
      launchState: pdas.launchState,
      metadata: pdas.metadata,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("initializeMetadata sig:", metaSig);
  await confirmViaWs(connection, metaSig, "finalized");

  console.log("Finalizing mint authorities...");
  const finalSig = await program.methods
    .finalizeMintAuthorities(pdas.metadataBump)
    .accounts({
      mintAuthority: pdas.mintAuthority,
      mint: mintPubkey,
      launchState: pdas.launchState,
      metadata: pdas.metadata,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("finalizeMintAuthorities sig:", finalSig);
  await confirmViaWs(connection, finalSig, "finalized");

  const creatorToken = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    mintPubkey
  );

  const creatorWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    NATIVE_MINT
  );

  const platformWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    PLATFORM_WALLET,
    NATIVE_MINT
  );

  const preIxs: TransactionInstruction[] = [];
  pushMaybe(preIxs, creatorToken.ix);
  pushMaybe(preIxs, creatorWsol.ix);
  pushMaybe(preIxs, platformWsol.ix);

  console.log("Starting dev buy from escrow...");
  const devBuySig = await program.methods
    .devBuyStartCurveFromEscrow(new anchor.BN(0), "localnet-test-cid")
    .accounts({
      platformSigner: user.publicKey,
      mint: mintPubkey,
      launchEscrow: pdas.launchEscrow,
      launchState: pdas.launchState,
      escrowSolVault: pdas.escrowSolVault,
      creatorReceiver: user.publicKey,
      saleVault: pdas.saleVault,
      creatorAta: creatorToken.ata,
      treasuryWsolVault: pdas.treasuryWsolVault,
      creatorWsolAta: creatorWsol.ata,
      platformWsolAta: platformWsol.ata,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preIxs)
    .rpc();

  console.log("devBuyStartCurveFromEscrow sig:", devBuySig);
  await confirmViaWs(connection, devBuySig, "finalized");

  console.log("Settling escrow leftover...");
  const settleSig = await program.methods
    .settleEscrowToPlatform()
    .accounts({
      platformSigner: user.publicKey,
      mint: mintPubkey,
      launchState: pdas.launchState,
      launchEscrow: pdas.launchEscrow,
      launchFeeReceiver: LAUNCH_FEE_WALLET,
      escrowSolVault: pdas.escrowSolVault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("settleEscrowToPlatform sig:", settleSig);
  await confirmViaWs(connection, settleSig, "finalized");

  console.log("✅ Fresh launch created");
  console.log("TARGET_MINT:", mintPubkey.toBase58());
  console.log("Launch state:", pdas.launchState.toBase58());

  return {
    mint: mintPubkey,
    ...pdas,
  };
}

async function printState({
  program,
  mint,
}: {
  program: Program<AapedLaunch>;
  mint: PublicKey;
}) {
  const pdas = derivePdas(program.programId, mint);
  const launchState: any = await program.account.launchState.fetch(pdas.launchState);

  const state = Number(launchState.state);
  const quoteAsset = Number(launchState.quoteAsset);

  console.log("Launch state PDA:", pdas.launchState.toBase58());
  console.log("Phase:", state, phaseName(state));
  console.log("Quote asset:", quoteAsset, quoteName(quoteAsset));
  console.log("Creator:", new PublicKey(launchState.creator).toBase58());
  console.log("Sale vault:", new PublicKey(launchState.saleVault).toBase58());
  console.log("LP vault:", new PublicKey(launchState.lpVault).toBase58());
  console.log("Treasury WSOL vault:", new PublicKey(launchState.treasuryWsolVault).toBase58());
  console.log("Treasury USDC vault:", new PublicKey(launchState.treasuryUsdcVault).toBase58());
  console.log("Tokens sold:", bnToString(launchState.tokensSold));
  console.log("SOL collected:", bnToString(launchState.solCollected));

  return {
    pdas,
    launchState,
    state,
    quoteAsset,
    saleVault: new PublicKey(launchState.saleVault),
    lpVault: new PublicKey(launchState.lpVault),
    treasuryWsolVault: new PublicKey(launchState.treasuryWsolVault),
    treasuryUsdcVault: new PublicKey(launchState.treasuryUsdcVault),
    creator: new PublicKey(launchState.creator),
  };
}

describe("aaped-launch localnet full launch test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  const program = new Program<AapedLaunch>(
    require("../target/idl/aaped_launch.json"),
    provider
  ) as Program<AapedLaunch>;

  it("creates mint, launches token, and optionally tests buy/sell routes", async () => {
    const wallet = provider.wallet as anchor.Wallet;
    const user = wallet.payer;

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", program.programId.toBase58());
    console.log("Expected program:", PROGRAM_ID.toBase58());
    console.log("Wallet:", user.publicKey.toBase58());
    console.log("Platform wallet:", PLATFORM_WALLET.toBase58());

    if (!program.programId.equals(PROGRAM_ID)) {
      throw new Error(
        `IDL/program ID mismatch. IDL has ${program.programId.toBase58()}, expected ${PROGRAM_ID.toBase58()}`
      );
    }

    const logsSub = connection.onLogs(
      PROGRAM_ID,
      (ev) => {
        console.log("\n================ PROGRAM LOGS ================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      let mint: PublicKey;

      if (TARGET_MINT) {
        mint = TARGET_MINT;
        console.log("Using existing TARGET_MINT:", mint.toBase58());
      } else {
        const fresh = await createFreshLaunch({
          program,
          provider,
        });

        mint = fresh.mint;
      }

      let stateInfo = await printState({ program, mint });

      if (stateInfo.state === PHASE.SWITCHING) {
        console.log("Trading is paused because launch is switching quote assets.");
        return;
      }

      const buySol = envNumber("TEST_BUY_SOL", 0);
      const sellAll = envBool("TEST_SELL_ALL", false);
      const buyUsdc = envNumber("TEST_USDC_BUY", 0);
      const sellAllUsdc = envBool("TEST_USDC_SELL_ALL", false);

      const userTokenAtaResult = await maybeCreateAtaIx(
        connection,
        user.publicKey,
        user.publicKey,
        mint
      );

      if (buySol > 0) {
        if (stateInfo.state !== PHASE.BONDING && stateInfo.state !== PHASE.AMM_LIVE) {
          throw new Error(`Cannot SOL buy in phase ${phaseName(stateInfo.state)}`);
        }

        if (stateInfo.state === PHASE.AMM_LIVE && stateInfo.quoteAsset !== QUOTE.SOL) {
          throw new Error(`Cannot SOL buy while AMM quote is ${quoteName(stateInfo.quoteAsset)}`);
        }

        const ixs: TransactionInstruction[] = [];

        pushMaybe(ixs, userTokenAtaResult.ix);

        const userWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          user.publicKey,
          NATIVE_MINT
        );

        const creatorWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          stateInfo.creator,
          NATIVE_MINT
        );

        const platformWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          PLATFORM_WALLET,
          NATIVE_MINT
        );

        pushMaybe(ixs, userWsol.ix);
        pushMaybe(ixs, creatorWsol.ix);
        pushMaybe(ixs, platformWsol.ix);

        const lamports = solToLamportsBn(buySol);

        ixs.push(
          SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey: userWsol.ata,
            lamports: lamports.toNumber(),
          })
        );

        ixs.push(createSyncNativeInstruction(userWsol.ata));

        const method =
          stateInfo.state === PHASE.BONDING
            ? program.methods.buy(lamports, new anchor.BN(0)).accounts({
                buyer: user.publicKey,
                launchState: stateInfo.pdas.launchState,
                saleVault: stateInfo.saleVault,
                lpVault: stateInfo.lpVault,
                buyerAta: userTokenAtaResult.ata,
                buyerWsolAta: userWsol.ata,
                treasuryWsolVault: stateInfo.treasuryWsolVault,
                creatorWsolAta: creatorWsol.ata,
                platformWsolAta: platformWsol.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
            : program.methods.ammBuy(lamports, new anchor.BN(0)).accounts({
                buyer: user.publicKey,
                launchState: stateInfo.pdas.launchState,
                lpVault: stateInfo.lpVault,
                buyerAta: userTokenAtaResult.ata,
                buyerWsolAta: userWsol.ata,
                treasuryWsolVault: stateInfo.treasuryWsolVault,
                creatorWsolAta: creatorWsol.ata,
                platformWsolAta: platformWsol.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
              });

        const sig = await method.preInstructions(ixs).rpc();

        console.log(`${stateInfo.state === PHASE.BONDING ? "buy" : "ammBuy"} sig:`, sig);
        await confirmViaWs(connection, sig, "finalized");
        await sleep(1000);

        stateInfo = await printState({ program, mint });
      }

      if (buyUsdc > 0) {
        if (stateInfo.state !== PHASE.AMM_LIVE || stateInfo.quoteAsset !== QUOTE.USDC) {
          throw new Error("USDC buy is only valid in AMM live USDC mode");
        }

        const ixs: TransactionInstruction[] = [];

        pushMaybe(ixs, userTokenAtaResult.ix);

        const userUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          user.publicKey,
          USDC_MINT
        );

        const creatorUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          stateInfo.creator,
          USDC_MINT
        );

        const platformUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          PLATFORM_WALLET,
          USDC_MINT
        );

        pushMaybe(ixs, userUsdc.ix);
        pushMaybe(ixs, creatorUsdc.ix);
        pushMaybe(ixs, platformUsdc.ix);

        const usdcIn = usdcToBaseBn(buyUsdc);

        const sig = await program.methods
          .ammBuyUsdc(usdcIn, new anchor.BN(0))
          .accounts({
            buyer: user.publicKey,
            launchState: stateInfo.pdas.launchState,
            lpVault: stateInfo.lpVault,
            buyerAta: userTokenAtaResult.ata,
            buyerUsdcAta: userUsdc.ata,
            treasuryUsdcVault: stateInfo.treasuryUsdcVault,
            creatorUsdcAta: creatorUsdc.ata,
            platformUsdcAta: platformUsdc.ata,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions(ixs)
          .rpc();

        console.log("ammBuyUsdc sig:", sig);
        await confirmViaWs(connection, sig, "finalized");
        await sleep(1000);

        stateInfo = await printState({ program, mint });
      }

      if (sellAll || sellAllUsdc) {
        const tokenBalRaw = await getTokenRawBalance(connection, userTokenAtaResult.ata);

        if (tokenBalRaw === "0") {
          throw new Error("Wallet holds 0 tokens for this mint");
        }

        const tokensIn = new anchor.BN(tokenBalRaw);

        if (sellAllUsdc) {
          if (stateInfo.state !== PHASE.AMM_LIVE || stateInfo.quoteAsset !== QUOTE.USDC) {
            throw new Error("USDC sell is only valid in AMM live USDC mode");
          }

          const ixs: TransactionInstruction[] = [];

          const userUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            user.publicKey,
            USDC_MINT
          );

          const creatorUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            stateInfo.creator,
            USDC_MINT
          );

          const platformUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            PLATFORM_WALLET,
            USDC_MINT
          );

          pushMaybe(ixs, userUsdc.ix);
          pushMaybe(ixs, creatorUsdc.ix);
          pushMaybe(ixs, platformUsdc.ix);

          const sig = await program.methods
            .ammSellUsdc(tokensIn, new anchor.BN(0))
            .accounts({
              seller: user.publicKey,
              launchState: stateInfo.pdas.launchState,
              lpVault: stateInfo.lpVault,
              sellerAta: userTokenAtaResult.ata,
              sellerUsdcAta: userUsdc.ata,
              treasuryUsdcVault: stateInfo.treasuryUsdcVault,
              creatorUsdcAta: creatorUsdc.ata,
              platformUsdcAta: platformUsdc.ata,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .preInstructions(ixs)
            .rpc();

          console.log("ammSellUsdc sig:", sig);
          await confirmViaWs(connection, sig, "finalized");
          await sleep(1000);
        } else {
          if (stateInfo.state !== PHASE.BONDING && stateInfo.state !== PHASE.AMM_LIVE) {
            throw new Error(`Cannot SOL sell in phase ${phaseName(stateInfo.state)}`);
          }

          if (stateInfo.state === PHASE.AMM_LIVE && stateInfo.quoteAsset !== QUOTE.SOL) {
            throw new Error(`Cannot SOL sell while AMM quote is ${quoteName(stateInfo.quoteAsset)}`);
          }

          const ixs: TransactionInstruction[] = [];

          const userWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            user.publicKey,
            NATIVE_MINT
          );

          const creatorWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            stateInfo.creator,
            NATIVE_MINT
          );

          const platformWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            PLATFORM_WALLET,
            NATIVE_MINT
          );

          pushMaybe(ixs, userWsol.ix);
          pushMaybe(ixs, creatorWsol.ix);
          pushMaybe(ixs, platformWsol.ix);

          const method =
            stateInfo.state === PHASE.BONDING
              ? program.methods.sell(tokensIn, new anchor.BN(0)).accounts({
                  seller: user.publicKey,
                  launchState: stateInfo.pdas.launchState,
                  saleVault: stateInfo.saleVault,
                  sellerAta: userTokenAtaResult.ata,
                  sellerWsolAta: userWsol.ata,
                  treasuryWsolVault: stateInfo.treasuryWsolVault,
                  creatorWsolAta: creatorWsol.ata,
                  platformWsolAta: platformWsol.ata,
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
              : program.methods.ammSell(tokensIn, new anchor.BN(0)).accounts({
                  seller: user.publicKey,
                  launchState: stateInfo.pdas.launchState,
                  lpVault: stateInfo.lpVault,
                  sellerAta: userTokenAtaResult.ata,
                  sellerWsolAta: userWsol.ata,
                  treasuryWsolVault: stateInfo.treasuryWsolVault,
                  creatorWsolAta: creatorWsol.ata,
                  platformWsolAta: platformWsol.ata,
                  tokenProgram: TOKEN_PROGRAM_ID,
                });

          const sig = await method.preInstructions(ixs).rpc();

          console.log(`${stateInfo.state === PHASE.BONDING ? "sell" : "ammSell"} sig:`, sig);
          console.log("WSOL output remains in user WSOL ATA:", userWsol.ata.toBase58());
          await confirmViaWs(connection, sig, "finalized");
          await sleep(1000);
        }

        const tokenBalAfter = await getTokenRawBalance(connection, userTokenAtaResult.ata);
        console.log("Token balance after sell:", tokenBalAfter);

        await printState({ program, mint });
      }

      console.log("✅ Test file completed");
    } finally {
      try {
        await connection.removeOnLogsListener(logsSub);
      } catch {}
    }
  });
});
