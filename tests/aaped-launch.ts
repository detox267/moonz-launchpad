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
  createMintToInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

/**
 * AAPED / Moonz localnet bond + blocked switch-to-USDC test.
 *
 * This test proves the new safety rule:
 * completePoolSwitch(USDC) must fail until WSOL treasury is drained/converted.
 *
 * Flow:
 * 1. Ensure local mock USDC mint exists.
 * 2. Create fresh launch.
 * 3. Bond token into AMM live.
 * 4. Mint mock USDC to user.
 * 5. Seed treasury USDC vault.
 * 6. Begin pool switch to USDC.
 * 7. Try completePoolSwitch without draining WSOL.
 * 8. Confirm it fails.
 * 9. Confirm state remains Switching and quote remains SOL/WSOL.
 *
 * Run:
 * BOND_BUY_SOL=20 BOND_MAX_BUYS=500 USDC_TREASURY_SEED=100000 anchor test --skip-build --skip-deploy --skip-local-validator
 */

const PROGRAM_ID = new PublicKey(
  process.env.AAPED_PROGRAM_ID ||
    process.env.PROGRAM_ID ||
    "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk"
);

const PLATFORM_WALLET = new PublicKey(
  process.env.PLATFORM_WALLET ||
    "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const LAUNCH_FEE_WALLET = new PublicKey(
  process.env.LAUNCH_FEE_WALLET ||
    "7Ky9cCM29q4pGThCLfJz7fBKVZZNHYtB7EbThZU9uQRC"
);

const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ||
    "DDshYgDPwMoWGWh5hcXZi375jGMKz7U3aj3jebgu1YWP"
);

const MOCK_SWAP_PROGRAM_ID = new PublicKey(
  process.env.MOCK_SWAP_PROGRAM_ID ||
    "7QyZeftmo4HQ2Ayub8vhbB1nK6mtprknYNSXW1XjsLts"
);

const MOCK_USDC_KEYPAIR_PATH =
  process.env.MOCK_USDC_KEYPAIR_PATH || "test-keys/mock-usdc.json";

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
const USDC_DECIMALS = 6;

const TOTAL_SUPPLY_BASE = new anchor.BN("1000000000000000");
const SALE_SUPPLY_BASE = new anchor.BN("650000000000000");
const LP_SUPPLY_BASE = new anchor.BN("350000000000000");

const DEFAULT_DEV_BUY_SOL = Number(process.env.DEV_BUY_SOL || "0.1");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function envInt(name: string, fallback = 0): number {
  return Math.floor(envNumber(name, fallback));
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

function bnToBigInt(v: any): bigint {
  if (v === null || v === undefined) return 0n;
  return BigInt(v.toString());
}

function pow10BigInt(decimals: number): bigint {
  let base = 1n;

  for (let i = 0; i < decimals; i++) {
    base *= 10n;
  }

  return base;
}

function formatBaseUnits(raw: bigint, decimals = 6): string {
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;

  const base = pow10BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  return `${sign}${whole.toString()}.${frac.toString().padStart(decimals, "0")}`;
}

function formatSol(lamports: bigint): string {
  return formatBaseUnits(lamports, 9);
}

function formatToken(baseUnits: bigint): string {
  return formatBaseUnits(baseUnits, TOKEN_DECIMALS);
}

function formatUsdc(baseUnits: bigint): string {
  return formatBaseUnits(baseUnits, USDC_DECIMALS);
}

function solToLamportsBn(sol: number): anchor.BN {
  return new anchor.BN(Math.floor(sol * anchor.web3.LAMPORTS_PER_SOL).toString());
}

function usdcToBaseBn(usdc: number): anchor.BN {
  return new anchor.BN(Math.floor(usdc * 1_000_000).toString());
}

function readKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
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
    throw new Error(`${label} does not exist: ${pubkey.toBase58()}`);
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
  if (!ix) return;

  const ataKey = ix.keys?.[1]?.pubkey;

  if (
    ataKey &&
    ixs.some((existingIx) => {
      const existingAtaKey = existingIx.keys?.[1]?.pubkey;
      return (
        existingAtaKey &&
        existingAtaKey.equals(ataKey) &&
        existingIx.programId.equals(ix.programId)
      );
    })
  ) {
    return;
  }

  ixs.push(ix);
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

async function ensureMockUsdcMint(provider: anchor.AnchorProvider) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const mockUsdc = readKeypair(MOCK_USDC_KEYPAIR_PATH);

  if (!mockUsdc.publicKey.equals(USDC_MINT)) {
    throw new Error(
      `Mock USDC keypair mismatch.\n` +
        `USDC_MINT const: ${USDC_MINT.toBase58()}\n` +
        `Keypair pubkey: ${mockUsdc.publicKey.toBase58()}\n` +
        `Path: ${MOCK_USDC_KEYPAIR_PATH}`
    );
  }

  if (await accountExists(connection, USDC_MINT)) {
    console.log("Mock USDC mint exists:", USDC_MINT.toBase58());
    return mockUsdc;
  }

  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: mockUsdc.publicKey,
      space: MINT_SIZE,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mockUsdc.publicKey,
      USDC_DECIMALS,
      user.publicKey,
      user.publicKey,
      TOKEN_PROGRAM_ID
    )
  );

  const sig = await provider.sendAndConfirm(tx, [mockUsdc]);

  console.log("Created mock USDC mint:", mockUsdc.publicKey.toBase58());
  console.log("create mock USDC sig:", sig);

  await confirmViaWs(connection, sig, "finalized");
  await sleep(1000);

  for (let i = 0; i < 10; i++) {
    if (await accountExists(connection, USDC_MINT)) {
      console.log("Mock USDC mint confirmed:", USDC_MINT.toBase58());
      return mockUsdc;
    }

    console.log("Waiting for mock USDC mint account...");
    await sleep(500);
  }

  throw new Error(`Mock USDC mint was created but still not visible: ${USDC_MINT.toBase58()}`);
}

async function mintMockUsdcToUser({
  provider,
  amountUsdc,
}: {
  provider: anchor.AnchorProvider;
  amountUsdc: number;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const userUsdc = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    USDC_MINT
  );

  const ixs: TransactionInstruction[] = [];
  pushMaybe(ixs, userUsdc.ix);

  const amount = usdcToBaseBn(amountUsdc);

  ixs.push(
    createMintToInstruction(
      USDC_MINT,
      userUsdc.ata,
      user.publicKey,
      BigInt(amount.toString()),
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const sig = await provider.sendAndConfirm(new Transaction().add(...ixs), []);

  console.log("Minted mock USDC to user:", formatUsdc(BigInt(amount.toString())));
  console.log("User USDC ATA:", userUsdc.ata.toBase58());
  console.log("mint mock USDC sig:", sig);

  return userUsdc.ata;
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
      `Anchor wallet must be PLATFORM_WALLET.\n` +
        `Current wallet: ${user.publicKey.toBase58()}\n` +
        `PLATFORM_WALLET: ${PLATFORM_WALLET.toBase58()}`
    );
  }

  await assertAccountExists(connection, NATIVE_MINT, "WSOL mint");
  await assertAccountExists(connection, USDC_MINT, "Mock USDC mint");
  await assertAccountExists(connection, TOKEN_METADATA_PROGRAM_ID, "Metaplex Token Metadata program");

  const { mintPubkey } = await createLaunchMint({
    provider,
    programId: program.programId,
  });

  const pdas = derivePdas(program.programId, mintPubkey);
  const devBuyLamports = solToLamportsBn(DEFAULT_DEV_BUY_SOL);

  console.log("\n================ CREATE LAUNCH ================");
  console.log("Mint:", mintPubkey.toBase58());
  console.log("Funding launch escrow:", formatSol(BigInt(devBuyLamports.toString())), "SOL");

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

  console.log("fundLaunchEscrow:", fundSig);
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
    uri: process.env.TEST_URI || "https://example.com/moonz-test-metadata.json",
  };

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

  console.log("initializeLaunch:", initSig);
  await confirmViaWs(connection, initSig, "finalized");

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

  console.log("initializeMetadata:", metaSig);
  await confirmViaWs(connection, metaSig, "finalized");

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

  console.log("finalizeMintAuthorities:", finalSig);
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

  console.log("devBuyStartCurveFromEscrow:", devBuySig);
  await confirmViaWs(connection, devBuySig, "finalized");

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

  console.log("settleEscrowToPlatform:", settleSig);
  await confirmViaWs(connection, settleSig, "finalized");

  console.log("✅ Fresh launch created");
  console.log("TARGET_MINT:", mintPubkey.toBase58());
  console.log("Launch state:", pdas.launchState.toBase58());

  return {
    mint: mintPubkey,
    ...pdas,
  };
}

async function readState({
  program,
  mint,
}: {
  program: Program<AapedLaunch>;
  mint: PublicKey;
}) {
  const pdas = derivePdas(program.programId, mint);
  const launchState: any = await program.account.launchState.fetch(pdas.launchState);

  return {
    pdas,
    raw: launchState,
    state: Number(launchState.state),
    quoteAsset: Number(launchState.quoteAsset),
    creator: new PublicKey(launchState.creator),
    saleVault: new PublicKey(launchState.saleVault),
    lpVault: new PublicKey(launchState.lpVault),
    treasuryWsolVault: new PublicKey(launchState.treasuryWsolVault),
    treasuryUsdcVault: new PublicKey(launchState.treasuryUsdcVault),
    tokensSold: bnToBigInt(launchState.tokensSold),
    solCollected: bnToBigInt(launchState.solCollected),
  };
}

async function printState({
  program,
  mint,
  label = "STATE",
}: {
  program: Program<AapedLaunch>;
  mint: PublicKey;
  label?: string;
}) {
  const connection = program.provider.connection;
  const stateInfo = await readState({ program, mint });

  const lpBal = await getTokenRawBalance(connection, stateInfo.lpVault);
  const wsolBal = await getTokenRawBalance(connection, stateInfo.treasuryWsolVault);
  const usdcBal = await getTokenRawBalance(connection, stateInfo.treasuryUsdcVault);

  console.log(`\n================ ${label} ================`);
  console.log("Phase:", stateInfo.state, phaseName(stateInfo.state));
  console.log("Quote:", stateInfo.quoteAsset, quoteName(stateInfo.quoteAsset));
  console.log("Launch state:", stateInfo.pdas.launchState.toBase58());
  console.log("LP vault tokens:", formatToken(BigInt(lpBal)));
  console.log("Treasury WSOL:", formatSol(BigInt(wsolBal)));
  console.log("Treasury USDC:", formatUsdc(BigInt(usdcBal)));
  console.log("Tokens sold:", formatToken(stateInfo.tokensSold));
  console.log("SOL collected:", formatSol(stateInfo.solCollected));

  return stateInfo;
}

async function doBondingBuy({
  program,
  provider,
  mint,
  buySol,
  buyIndex,
  userTokenAta,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
  mint: PublicKey;
  buySol: number;
  buyIndex: number;
  userTokenAta: PublicKey;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const before = await readState({ program, mint });

  if (before.state !== PHASE.BONDING) {
    console.log(`Stopping buys. Phase is ${phaseName(before.state)}.`);
    return false;
  }

  const tokenBefore = BigInt(await getTokenRawBalance(connection, userTokenAta));
  const treasuryWsolBefore = BigInt(await getTokenRawBalance(connection, before.treasuryWsolVault));
  const lpBefore = BigInt(await getTokenRawBalance(connection, before.lpVault));

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
    before.creator,
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

  console.log(`\n================ BOND BUY #${buyIndex} ================`);
  console.log("Input:", buySol, "SOL");

  const sig = await program.methods
    .buy(lamports, new anchor.BN(0))
    .accounts({
      buyer: user.publicKey,
      launchState: before.pdas.launchState,
      saleVault: before.saleVault,
      lpVault: before.lpVault,
      buyerAta: userTokenAta,
      buyerWsolAta: userWsol.ata,
      treasuryWsolVault: before.treasuryWsolVault,
      creatorWsolAta: creatorWsol.ata,
      platformWsolAta: platformWsol.ata,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(ixs)
    .rpc();

  console.log("buy:", sig);
  await confirmViaWs(connection, sig, "finalized");
  await sleep(250);

  const after = await readState({ program, mint });
  const tokenAfter = BigInt(await getTokenRawBalance(connection, userTokenAta));
  const treasuryWsolAfter = BigInt(await getTokenRawBalance(connection, after.treasuryWsolVault));
  const lpAfter = BigInt(await getTokenRawBalance(connection, after.lpVault));

  console.log("Wallet token delta:", formatToken(tokenAfter - tokenBefore));
  console.log("Tokens sold delta:", formatToken(after.tokensSold - before.tokensSold));
  console.log("SOL collected delta:", formatSol(after.solCollected - before.solCollected));
  console.log("Treasury WSOL delta:", formatSol(treasuryWsolAfter - treasuryWsolBefore));
  console.log("LP vault token delta:", formatToken(lpAfter - lpBefore));

  return true;
}

async function bondToAmm({
  program,
  provider,
  mint,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
  mint: PublicKey;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const buySol = envNumber("BOND_BUY_SOL", 20);
  const maxBuys = envInt("BOND_MAX_BUYS", 500);

  console.log("\n================ BOND TO AMM CONFIG ================");
  console.log("BOND_BUY_SOL:", buySol);
  console.log("BOND_MAX_BUYS:", maxBuys);

  const userToken = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    mint
  );

  const setupIxs: TransactionInstruction[] = [];
  pushMaybe(setupIxs, userToken.ix);

  if (setupIxs.length > 0) {
    const sig = await provider.sendAndConfirm(new Transaction().add(...setupIxs), []);
    console.log("Created user token ATA:", sig);
  }

  await printState({ program, mint, label: "BOND START" });

  for (let i = 1; i <= maxBuys; i++) {
    const before = await readState({ program, mint });

    if (before.state !== PHASE.BONDING) {
      console.log(`Bonding stopped before buy #${i}. Phase: ${phaseName(before.state)}`);
      break;
    }

    const saleVaultBalanceRaw = await getTokenRawBalance(connection, before.saleVault);

    console.log("\n================ BOND CHECK ================");
    console.log("Buy #:", i);
    console.log("Sale vault:", formatToken(BigInt(saleVaultBalanceRaw)));

    if (saleVaultBalanceRaw === "0") {
      break;
    }

    const buyOk = await doBondingBuy({
      program,
      provider,
      mint,
      buySol,
      buyIndex: i,
      userTokenAta: userToken.ata,
    });

    if (!buyOk) break;

    const after = await readState({ program, mint });

    if (after.state === PHASE.AMM_LIVE) {
      console.log("\n✅ Token reached AMM live.");
      break;
    }

    if (after.state !== PHASE.BONDING) {
      console.log(`Stopped because phase changed to ${phaseName(after.state)}.`);
      break;
    }
  }

  const finalState = await printState({
    program,
    mint,
    label: "AFTER BONDING",
  });

  if (finalState.state !== PHASE.AMM_LIVE) {
    throw new Error(`Token did not reach AMM live. Phase: ${phaseName(finalState.state)}`);
  }

  if (finalState.quoteAsset !== QUOTE.SOL) {
    throw new Error(`Expected SOL quote after bonding. Got ${quoteName(finalState.quoteAsset)}`);
  }

  return userToken.ata;
}

async function seedUsdcTreasury({
  program,
  provider,
  mint,
  amountUsdc,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
  mint: PublicKey;
  amountUsdc: number;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const stateInfo = await readState({ program, mint });

  const userUsdcAta = await mintMockUsdcToUser({
    provider,
    amountUsdc,
  });

  const amount = usdcToBaseBn(amountUsdc);

  const sig = await provider.sendAndConfirm(
    new Transaction().add(
      createTransferInstruction(
        userUsdcAta,
        stateInfo.treasuryUsdcVault,
        user.publicKey,
        BigInt(amount.toString()),
        [],
        TOKEN_PROGRAM_ID
      )
    ),
    []
  );

  console.log("\n================ SEED USDC TREASURY ================");
  console.log("Seeded treasury USDC:", formatUsdc(BigInt(amount.toString())));
  console.log("Treasury USDC vault:", stateInfo.treasuryUsdcVault.toBase58());
  console.log("seed sig:", sig);

  await printState({ program, mint, label: "AFTER USDC TREASURY SEED" });
}

async function switchPoolToUsdcExpectBlocked({
  program,
  provider,
  mint,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
  mint: PublicKey;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  let stateInfo = await readState({ program, mint });

  console.log("\n================ BEGIN POOL SWITCH TO USDC ================");

  const beginSig = await program.methods
    .beginPoolSwitch(QUOTE.USDC)
    .accounts({
      creator: user.publicKey,
      launchState: stateInfo.pdas.launchState,
      platformWallet: PLATFORM_WALLET,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("beginPoolSwitch:", beginSig);
  await confirmViaWs(connection, beginSig, "finalized");

  const afterBegin = await printState({
    program,
    mint,
    label: "AFTER BEGIN SWITCH",
  });

  if (afterBegin.state !== PHASE.SWITCHING) {
    throw new Error(`Expected switching phase. Got ${phaseName(afterBegin.state)}`);
  }

  if (afterBegin.quoteAsset !== QUOTE.SOL) {
    throw new Error(`Expected current quote still SOL. Got ${quoteName(afterBegin.quoteAsset)}`);
  }

  const wsolBeforeComplete = BigInt(
    await getTokenRawBalance(connection, afterBegin.treasuryWsolVault)
  );

  const usdcBeforeComplete = BigInt(
    await getTokenRawBalance(connection, afterBegin.treasuryUsdcVault)
  );

  console.log("\n================ TRY COMPLETE WITHOUT CONVERSION ================");
  console.log("Treasury WSOL before complete:", formatSol(wsolBeforeComplete));
  console.log("Treasury USDC before complete:", formatUsdc(usdcBeforeComplete));
  console.log("Expected result: completePoolSwitch should fail because WSOL was not drained.");

  let blocked = false;

  try {
    const completeSig = await program.methods
      .completePoolSwitch()
      .accounts({
        creator: user.publicKey,
        launchState: afterBegin.pdas.launchState,
        treasuryWsolVault: afterBegin.treasuryWsolVault,
        treasuryUsdcVault: afterBegin.treasuryUsdcVault,
      })
      .rpc();

    console.log("completePoolSwitch unexpectedly succeeded:", completeSig);
  } catch (err: any) {
    blocked = true;

    const msg = String(err?.message || err);

    console.log("completePoolSwitch failed as expected.");
    console.log("Failure:", msg.slice(0, 700));
  }

  if (!blocked) {
    throw new Error(
      "completePoolSwitch succeeded even though treasury WSOL was not drained. Dust rule is not working."
    );
  }

  const afterFailedComplete = await printState({
    program,
    mint,
    label: "AFTER BLOCKED COMPLETE",
  });

  if (afterFailedComplete.state !== PHASE.SWITCHING) {
    throw new Error(
      `Expected phase to remain switching after blocked complete. Got ${phaseName(
        afterFailedComplete.state
      )}`
    );
  }

  if (afterFailedComplete.quoteAsset !== QUOTE.SOL) {
    throw new Error(
      `Expected quote to remain SOL after blocked complete. Got ${quoteName(
        afterFailedComplete.quoteAsset
      )}`
    );
  }

  console.log("\n✅ Pool switch protection works.");
  console.log("The program now requires WSOL to be drained before USDC switch can complete.");
}

describe("aaped-launch localnet bond then blocked switch to USDC", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  const program = new Program<AapedLaunch>(
    require("../target/idl/aaped_launch.json"),
    provider
  ) as Program<AapedLaunch>;

  it("creates launch, bonds to AMM, then blocks USDC switch until WSOL is converted", async () => {
    const wallet = provider.wallet as anchor.Wallet;
    const user = wallet.payer;

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", program.programId.toBase58());
    console.log("Expected program:", PROGRAM_ID.toBase58());
    console.log("Wallet:", user.publicKey.toBase58());
    console.log("Platform wallet:", PLATFORM_WALLET.toBase58());
    console.log("Mock USDC mint:", USDC_MINT.toBase58());

    if (!program.programId.equals(PROGRAM_ID)) {
      throw new Error(
        `IDL/program ID mismatch. IDL has ${program.programId.toBase58()}, expected ${PROGRAM_ID.toBase58()}`
      );
    }

    await ensureMockUsdcMint(provider);

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

    await bondToAmm({
      program,
      provider,
      mint,
    });

    await seedUsdcTreasury({
      program,
      provider,
      mint,
      amountUsdc: envNumber("USDC_TREASURY_SEED", 100000),
    });

    await switchPoolToUsdcWithMockSwap({
  program,
  provider,
  mint,
});

console.log("✅ Bond + mock swap + USDC switch test completed");

    console.log("✅ Bond + blocked USDC switch test completed");
  });
});
