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
} from "@solana/spl-token";
import fs from "fs";
import { createHash } from "crypto";

import { AapedLaunch } from "../target/types/aaped_launch";

/**
 * AAPED / Moonz localnet bond + mock swap switch-to-USDC test.
 *
 * Run:
 * BOND_BUY_SOL=20 BOND_MAX_BUYS=500 MOCK_SWITCH_USDC_OUT=100000 anchor test --skip-build --skip-deploy --skip-local-validator
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

const PLATFORM_FEE_WALLET = new PublicKey(
  process.env.PLATFORM_FEE_WALLET ||
    "3mTCqBzGWMkUHqp3Ysepj3oewaMw6ndGQ368gEnxv1uH"
);

const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

const MOCK_SWAP_PROGRAM_ID = new PublicKey(
  process.env.MOCK_SWAP_PROGRAM_ID ||
    "7QyZeftmo4HQ2Ayub8vhbB1nK6mtprknYNSXW1XjsLts"
);

const JUPITER_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
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
  CURVE: 1,
  AMM_LIVE: 2,
  SWITCHING: 3,
  CANCELLED: 4,
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
const RUN_LEGACY_MOCK_SWITCH =
  process.env.RUN_LEGACY_MOCK_SWITCH === "true";

const RUN_JUPITER_SECURITY_SWITCH =
  process.env.RUN_JUPITER_SECURITY_SWITCH === "true";

const JUPITER_FIXTURE_FAMILY =
  (process.env.JUPITER_FIXTURE_FAMILY || "shared")
    .trim()
    .toLowerCase();

function currentJupiterFixtureInstructionName():
  "route" | "shared_accounts_route" {
  if (JUPITER_FIXTURE_FAMILY === "route") {
    return "route";
  }

  if (
    JUPITER_FIXTURE_FAMILY === "shared" ||
    JUPITER_FIXTURE_FAMILY === "shared_accounts_route"
  ) {
    return "shared_accounts_route";
  }

  throw new Error(
    `Invalid JUPITER_FIXTURE_FAMILY: ${JUPITER_FIXTURE_FAMILY}. ` +
    `Expected "route" or "shared".`
  );
}

function encodeJupiterFixtureSwapData({
  instructionName,
  amountIn,
  amountOut,
  mutationMode = 0,
}: {
  instructionName: string;
  amountIn: bigint;
  amountOut: bigint;
  mutationMode?: number;
}): Buffer {
  if (
    !Number.isInteger(mutationMode) ||
    mutationMode < 0 ||
    mutationMode > 255
  ) {
    throw new Error(
      `Invalid Jupiter fixture mutation mode: ${mutationMode}`
    );
  }

  const discriminator =
    createHash("sha256")
      .update(`global:${instructionName}`)
      .digest()
      .subarray(0, 8);

  const amountInData = Buffer.alloc(8);
  amountInData.writeBigUInt64LE(amountIn, 0);

  const amountOutData = Buffer.alloc(8);
  amountOutData.writeBigUInt64LE(amountOut, 0);

  return Buffer.concat([
    discriminator,
    amountInData,
    amountOutData,
    Buffer.from([mutationMode]),
  ]);
}

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
    case PHASE.CURVE:
      return "curve";
    case PHASE.AMM_LIVE:
      return "amm_live";
    case PHASE.CANCELLED:
      return "cancelled";
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

function u32LeBuffer(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function metadataCommitment({
  mint,
  creator,
  name,
  symbol,
  uri,
}: {
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): number[] {
  const nameBuf = Buffer.from(name, "utf8");
  const symbolBuf = Buffer.from(symbol, "utf8");
  const uriBuf = Buffer.from(uri, "utf8");

  return Array.from(
    createHash("sha256")
      .update(Buffer.from("moonz_metadata_v1"))
      .update(mint.toBuffer())
      .update(creator.toBuffer())
      .update(u32LeBuffer(nameBuf.length))
      .update(nameBuf)
      .update(u32LeBuffer(symbolBuf.length))
      .update(symbolBuf)
      .update(u32LeBuffer(uriBuf.length))
      .update(uriBuf)
      .digest()
  );
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

async function expectSwitchBackToWsolBlockedByCooldown({
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

  const before = await printState({
    program,
    mint,
    label: "BEFORE IMMEDIATE SWITCH BACK TEST",
  });

  if (before.state !== PHASE.AMM_LIVE) {
    throw new Error(`Expected AMM live. Got ${phaseName(before.state)}`);
  }

  if (before.quoteAsset !== QUOTE.USDC) {
    throw new Error(`Expected current quote USDC. Got ${quoteName(before.quoteAsset)}`);
  }

  console.log("\n================ TRY IMMEDIATE SWITCH BACK TO WSOL ================");
  console.log("Expected result: beginPoolSwitch(SOL) should fail due to 24-hour cooldown.");

  const expectedUsdcPoolAmount = BigInt(
    await getTokenRawBalance(connection, before.pdas.treasuryUsdcVault)
  );

  if (expectedUsdcPoolAmount <= 0n) {
    throw new Error("Treasury USDC must be greater than zero before cooldown test.");
  }

  let blocked = false;

  try {
    const sig = await program.methods
      .beginPoolSwitch(
        QUOTE.SOL,
        new anchor.BN(expectedUsdcPoolAmount.toString()),
        new anchor.BN(1)
      )
      .accountsPartial({
        creator: user.publicKey,
        launchState: before.pdas.launchState,
        sourceQuoteVault: before.pdas.treasuryUsdcVault,
        platformWallet: PLATFORM_WALLET,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("beginPoolSwitch(SOL) unexpectedly succeeded:", sig);
    await confirmViaWs(connection, sig, "finalized");
  } catch (err: any) {
    blocked = true;

    const msg = String(err?.message || err);

    console.log("beginPoolSwitch(SOL) failed as expected.");
    console.log("Failure:", msg.slice(0, 700));
  }

  if (!blocked) {
    throw new Error(
      "Immediate switch back to WSOL succeeded. 24-hour pool switch cooldown is not working."
    );
  }

  const after = await printState({
    program,
    mint,
    label: "AFTER BLOCKED SWITCH BACK TEST",
  });

  if (after.state !== PHASE.AMM_LIVE) {
    throw new Error(
      `Expected phase to remain AMM live after blocked switch back. Got ${phaseName(after.state)}`
    );
  }

  if (after.quoteAsset !== QUOTE.USDC) {
    throw new Error(
      `Expected quote to remain USDC after blocked switch back. Got ${quoteName(after.quoteAsset)}`
    );
  }

  console.log("\n✅ Immediate switch back to WSOL was blocked.");
  console.log("✅ 24-hour pool switch cooldown works.");
}

async function maybeCreateAtaIx(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  allowOwnerOffCurve = false
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve
  );

  if (await accountExists(connection, ata)) {
    return { ata, ix: null };
  }

  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
  };
}

function deriveCreatorFeeAuthority(
  programId: PublicKey,
  creator: PublicKey
): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_fees"), creator.toBuffer()],
    programId
  );

  return authority;
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

  const existingUsdc = await connection.getAccountInfo(
    USDC_MINT,
    "confirmed"
  );

  if (existingUsdc) {
    if (!existingUsdc.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(
        `Preloaded USDC fixture has wrong owner: ${existingUsdc.owner.toBase58()}`
      );
    }

    const mintData = Buffer.from(existingUsdc.data);

    if (mintData.length !== MINT_SIZE) {
      throw new Error(
        `Preloaded USDC fixture has wrong mint size: ${mintData.length}`
      );
    }

    const mintAuthorityOption =
      mintData.readUInt32LE(0);

    const mintAuthority =
      new PublicKey(
        mintData.subarray(4, 36)
      );

    const decimals =
      mintData[44];

    const initialized =
      mintData[45];

    if (mintAuthorityOption !== 1) {
      throw new Error(
        "Preloaded USDC fixture has no mint authority."
      );
    }

    if (!mintAuthority.equals(user.publicKey)) {
      throw new Error(
        `Preloaded USDC fixture mint authority mismatch. Expected ${user.publicKey.toBase58()}, got ${mintAuthority.toBase58()}`
      );
    }

    if (decimals !== USDC_DECIMALS) {
      throw new Error(
        `Preloaded USDC fixture decimals mismatch. Expected ${USDC_DECIMALS}, got ${decimals}`
      );
    }

    if (initialized !== 1) {
      throw new Error(
        "Preloaded USDC fixture is not initialized."
      );
    }

    console.log(
      "Preloaded canonical USDC fixture verified:",
      USDC_MINT.toBase58()
    );

    return;
  }

  const mockUsdc = readKeypair(MOCK_USDC_KEYPAIR_PATH);

  if (!mockUsdc.publicKey.equals(USDC_MINT)) {
    throw new Error(
      `Mock USDC keypair mismatch.\n` +
        `USDC_MINT const: ${USDC_MINT.toBase58()}\n` +
        `Keypair pubkey: ${mockUsdc.publicKey.toBase58()}\n` +
        `Path: ${MOCK_USDC_KEYPAIR_PATH}`
    );
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

  const { mint, mintPubkey } = await createLaunchMint({
    provider,
    programId: program.programId,
  });

  const pdas = derivePdas(program.programId, mintPubkey);
  const devBuyLamports = solToLamportsBn(DEFAULT_DEV_BUY_SOL);
  const devBuyMinTokensOut = new anchor.BN(
    process.env.DEV_BUY_MIN_TOKENS_OUT || "1"
  );

  const initParams = {
    creator: user.publicKey,
    name: process.env.TEST_NAME || "Moonz Test",
    symbol: process.env.TEST_SYMBOL || "MOONZT",
    uri: process.env.TEST_URI || "https://example.com/moonz-test-metadata.json",
  };

  const commitment = metadataCommitment({
    mint: mintPubkey,
    creator: user.publicKey,
    name: initParams.name,
    symbol: initParams.symbol,
    uri: initParams.uri,
  });

  console.log("\n================ CREATE LAUNCH ================");
  console.log("Mint:", mintPubkey.toBase58());
  console.log("Funding launch escrow:", formatSol(BigInt(devBuyLamports.toString())), "SOL");

  const fundSig = await program.methods
    .fundLaunchEscrow(devBuyLamports, devBuyMinTokensOut, commitment)
    .accountsPartial({
      creator: user.publicKey,
      mint: mintPubkey,
      launchEscrow: pdas.launchEscrow,
      escrowSolVault: pdas.escrowSolVault,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([mint])
    .rpc();

  console.log("fundLaunchEscrow:", fundSig);
  await confirmViaWs(connection, fundSig, "finalized");

  const initSig = await program.methods
    .initializeLaunch(initParams)
    .accountsPartial({
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
    .accountsPartial({
      payer: user.publicKey,
      mintAuthority: pdas.mintAuthority,
      mint: mintPubkey,
      launchState: pdas.launchState,
      metadata: pdas.metadata,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      launchEscrow: pdas.launchEscrow,
    })
    .rpc();

  console.log("initializeMetadata:", metaSig);
  await confirmViaWs(connection, metaSig, "finalized");

  const finalSig = await program.methods
    .finalizeMintAuthorities(pdas.metadataBump)
    .accountsPartial({
      mintAuthority: pdas.mintAuthority,
      mint: mintPubkey,
      launchState: pdas.launchState,
      metadata: pdas.metadata,
      tokenProgram: TOKEN_PROGRAM_ID,
      launchEscrow: pdas.launchEscrow,
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

  const creatorFeeAuthority = deriveCreatorFeeAuthority(
    program.programId,
    user.publicKey
  );

  const creatorFeeWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    creatorFeeAuthority,
    NATIVE_MINT,
    true
  );

  const platformWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    PLATFORM_FEE_WALLET,
    NATIVE_MINT
  );

  const preIxs: TransactionInstruction[] = [];
  pushMaybe(preIxs, creatorToken.ix);
  pushMaybe(preIxs, creatorFeeWsol.ix);
  pushMaybe(preIxs, platformWsol.ix);

  const devBuySig = await program.methods
    .devBuyStartCurveFromEscrow(devBuyMinTokensOut, "localnet-test-cid")
    .accountsPartial({
      platformSigner: user.publicKey,
      mint: mintPubkey,
      launchEscrow: pdas.launchEscrow,
      launchState: pdas.launchState,
      escrowSolVault: pdas.escrowSolVault,
      creatorReceiver: user.publicKey,
      saleVault: pdas.saleVault,
      creatorAta: creatorToken.ata,
      treasuryWsolVault: pdas.treasuryWsolVault,
      creatorFeeAuthority,
      creatorFeeWsolVault: creatorFeeWsol.ata,
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
    .accountsPartial({
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

  if (before.state !== PHASE.CURVE) {
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

  const creatorFeeAuthority = deriveCreatorFeeAuthority(
    program.programId,
    before.creator
  );

  const creatorFeeWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    creatorFeeAuthority,
    NATIVE_MINT,
    true
  );

  const platformWsol = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    PLATFORM_FEE_WALLET,
    NATIVE_MINT
  );

  pushMaybe(ixs, userWsol.ix);
  pushMaybe(ixs, creatorFeeWsol.ix);
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
    .buy(lamports, new anchor.BN(1))
    .accountsPartial({
      buyer: user.publicKey,
      launchState: before.pdas.launchState,
      saleVault: before.saleVault,
      lpVault: before.lpVault,
      buyerAta: userTokenAta,
      buyerWsolAta: userWsol.ata,
      treasuryWsolVault: before.treasuryWsolVault,
      creatorFeeAuthority,
      creatorFeeWsolVault: creatorFeeWsol.ata,
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

    if (before.state !== PHASE.CURVE) {
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

    if (after.state !== PHASE.CURVE) {
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

async function switchPoolToUsdcWithMockSwap({
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

  const mockSwapProgram = new Program(
    require("../target/idl/mock_swap.json"),
    provider
  );

  let stateInfo = await readState({ program, mint });

  console.log("\n================ BEGIN POOL SWITCH TO USDC ================");

  const mockUsdcOutNumber = envNumber("MOCK_SWITCH_USDC_OUT", 100000);
  const mockUsdcOut = usdcToBaseBn(mockUsdcOutNumber);
  const expectedWsolPoolAmount = BigInt(
    await getTokenRawBalance(connection, stateInfo.treasuryWsolVault)
  );

  if (expectedWsolPoolAmount <= 0n) {
    throw new Error("Treasury WSOL must be greater than zero before mock switch.");
  }

  let staleAmountBlocked = false;

  try {
    await program.methods
      .beginPoolSwitch(
        QUOTE.USDC,
        new anchor.BN((expectedWsolPoolAmount + 1n).toString()),
        mockUsdcOut
      )
      .accountsPartial({
        creator: user.publicKey,
        launchState: stateInfo.pdas.launchState,
        sourceQuoteVault: stateInfo.treasuryWsolVault,
        platformWallet: PLATFORM_WALLET,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } catch (err: any) {
    staleAmountBlocked = true;
    console.log(
      "Stale displayed pool amount rejected as expected:",
      String(err?.message || err).slice(0, 500)
    );
  }

  if (!staleAmountBlocked) {
    throw new Error("Pool switch accepted a stale expected pool amount.");
  }

  const beginSig = await program.methods
    .beginPoolSwitch(
      QUOTE.USDC,
      new anchor.BN(expectedWsolPoolAmount.toString()),
      mockUsdcOut
    )
    .accountsPartial({
      creator: user.publicKey,
      launchState: stateInfo.pdas.launchState,
      sourceQuoteVault: stateInfo.treasuryWsolVault,
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

  const treasuryWsolBefore = BigInt(
    await getTokenRawBalance(connection, afterBegin.treasuryWsolVault)
  );

  const treasuryUsdcBefore = BigInt(
    await getTokenRawBalance(connection, afterBegin.treasuryUsdcVault)
  );

  if (treasuryWsolBefore <= 0n) {
    throw new Error("Treasury WSOL must be greater than zero before mock switch swap.");
  }

  const userWsolSink = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    NATIVE_MINT
  );

  const userUsdcDonor = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    USDC_MINT
  );

  const setupIxs: TransactionInstruction[] = [];
  pushMaybe(setupIxs, userWsolSink.ix);
  pushMaybe(setupIxs, userUsdcDonor.ix);

  if (setupIxs.length > 0) {
    const setupSig = await provider.sendAndConfirm(
      new Transaction().add(...setupIxs),
      []
    );

    console.log("Created mock swap ATAs:", setupSig);
  }

  await mintMockUsdcToUser({
    provider,
    amountUsdc: mockUsdcOutNumber,
  });

  const amountIn = new anchor.BN(treasuryWsolBefore.toString());
  const minAmountOut = mockUsdcOut;

  console.log("\n================ EXECUTE MOCK SWITCH SWAP ================");
  console.log("Mock WSOL in:", formatSol(BigInt(amountIn.toString())));
  console.log("Mock USDC out:", formatUsdc(BigInt(minAmountOut.toString())));
  console.log("Mock swap program:", mockSwapProgram.programId.toBase58());

  if (!mockSwapProgram.programId.equals(MOCK_SWAP_PROGRAM_ID)) {
    throw new Error(
      `Mock swap ID mismatch. IDL has ${mockSwapProgram.programId.toBase58()}, expected ${MOCK_SWAP_PROGRAM_ID.toBase58()}`
    );
  }

  const mockIx = await mockSwapProgram.methods
    .mockSwitchSwap(amountIn, minAmountOut)
    .accountsPartial({
      authority: afterBegin.pdas.launchState,
      sourceQuoteVault: afterBegin.treasuryWsolVault,
      sourceSinkVault: userWsolSink.ata,
      usdcDonorAta: userUsdcDonor.ata,
      destinationQuoteVault: afterBegin.treasuryUsdcVault,
      usdcDonorAuthority: user.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const remainingAccounts = mockIx.keys.map((key) => {
    return {
      pubkey: key.pubkey,
      isWritable: key.isWritable,
      isSigner: key.pubkey.equals(afterBegin.pdas.launchState)
        ? false
        : key.isSigner,
    };
  });

  const execSig = await program.methods
    .executePoolSwitchSwap(Buffer.from(mockIx.data))
    .accountsPartial({
      platformSigner: user.publicKey,
      launchState: afterBegin.pdas.launchState,
      sourceQuoteVault: afterBegin.treasuryWsolVault,
      destinationQuoteVault: afterBegin.treasuryUsdcVault,
      swapProgram: mockSwapProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  console.log("executePoolSwitchSwap:", execSig);
  await confirmViaWs(connection, execSig, "finalized");

  const afterSwap = await printState({
    program,
    mint,
    label: "AFTER MOCK SWITCH SWAP",
  });

  const treasuryWsolAfter = BigInt(
    await getTokenRawBalance(connection, afterSwap.treasuryWsolVault)
  );

  const treasuryUsdcAfter = BigInt(
    await getTokenRawBalance(connection, afterSwap.treasuryUsdcVault)
  );

  if (treasuryWsolAfter !== 0n) {
    throw new Error(
      `Expected treasury WSOL to be drained to zero. Got ${formatSol(treasuryWsolAfter)}`
    );
  }

  if (treasuryUsdcAfter <= treasuryUsdcBefore) {
    throw new Error("Expected treasury USDC to increase after mock switch swap.");
  }

  console.log("\n================ COMPLETE POOL SWITCH TO USDC ================");

  const completeSig = await program.methods
    .completePoolSwitch()
    .accountsPartial({
      platformSigner: PLATFORM_WALLET,
      platformFeeReceiver: PLATFORM_FEE_WALLET,
      launchState: afterSwap.pdas.launchState,
      treasuryWsolVault: afterSwap.treasuryWsolVault,
      treasuryUsdcVault: afterSwap.treasuryUsdcVault,
    })
    .rpc();

  console.log("completePoolSwitch:", completeSig);
  await confirmViaWs(connection, completeSig, "finalized");

  const afterComplete = await printState({
    program,
    mint,
    label: "AFTER COMPLETE SWITCH",
  });

  if (afterComplete.state !== PHASE.AMM_LIVE) {
    throw new Error(`Expected AMM live. Got ${phaseName(afterComplete.state)}`);
  }

  if (afterComplete.quoteAsset !== QUOTE.USDC) {
    throw new Error(`Expected USDC quote. Got ${quoteName(afterComplete.quoteAsset)}`);
  }

  console.log("\n✅ Mock switch swap completed.");
  console.log("✅ Pool switched to USDC after WSOL drain.");
}




async function expectJupiterSecurityExecuteRejectedAndRolledBack({
  program,
  provider,
  launchState,
  sourceQuoteVault,
  destinationQuoteVault,
  remainingAccounts,
  cpiAmountIn,
  cpiAmountOut,
  swapProgram =
    JUPITER_V6_PROGRAM_ID,
  instructionName =
    currentJupiterFixtureInstructionName(),
  mutationMode = 0,
  label,
}: {
  program: Program<AapedLaunch>;
  provider: anchor.AnchorProvider;
  launchState: PublicKey;
  sourceQuoteVault: PublicKey;
  destinationQuoteVault: PublicKey;
  remainingAccounts: {
    pubkey: PublicKey;
    isWritable: boolean;
    isSigner: boolean;
  }[];
  cpiAmountIn: bigint;
  cpiAmountOut: bigint;
  swapProgram?: PublicKey;
  instructionName?: string;
  mutationMode?: number;
  label: string;
}) {
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const user = wallet.payer;

  const stateBeforeInfo = await connection.getAccountInfo(
    launchState,
    "confirmed"
  );

  if (!stateBeforeInfo) {
    throw new Error(
      `${label}: LaunchState does not exist before rejection test.`
    );
  }

  const stateBefore = Buffer.from(stateBeforeInfo.data);

  const sourceAccountBeforeInfo =
    await connection.getAccountInfo(
      sourceQuoteVault,
      "confirmed"
    );

  const destinationAccountBeforeInfo =
    await connection.getAccountInfo(
      destinationQuoteVault,
      "confirmed"
    );

  if (!sourceAccountBeforeInfo) {
    throw new Error(
      `${label}: source token account missing before rejection test.`
    );
  }

  if (!destinationAccountBeforeInfo) {
    throw new Error(
      `${label}: destination token account missing before rejection test.`
    );
  }

  const sourceAccountDataBefore =
    Buffer.from(sourceAccountBeforeInfo.data);

  const destinationAccountDataBefore =
    Buffer.from(destinationAccountBeforeInfo.data);

  const sourceBefore = BigInt(
    await getTokenRawBalance(
      connection,
      sourceQuoteVault
    )
  );

  const destinationBefore = BigInt(
    await getTokenRawBalance(
      connection,
      destinationQuoteVault
    )
  );

  const swapData =
    encodeJupiterFixtureSwapData({
      instructionName,
      amountIn: cpiAmountIn,
      amountOut: cpiAmountOut,
      mutationMode,
    });

  let rejected = false;

  console.log(
    `\n================ ${label} ================`
  );

  try {
    const sig =
      await program.methods
        .executePoolSwitchSwap(
          swapData
        )
        .accountsPartial({
          platformSigner:
            user.publicKey,
          launchState,
          sourceQuoteVault,
          destinationQuoteVault,
          swapProgram,
        })
        .remainingAccounts(
          remainingAccounts
        )
        .rpc();

    console.log(
      `${label}: unexpectedly succeeded:`,
      sig
    );
  } catch (err: any) {
    rejected = true;

    console.log(
      `${label}: rejected as expected.`
    );

    console.log(
      "Failure:",
      String(
        err?.message || err
      ).slice(0, 900)
    );
  }

  if (!rejected) {
    throw new Error(
      `${label}: executePoolSwitchSwap unexpectedly succeeded.`
    );
  }

  const stateAfterInfo = await connection.getAccountInfo(
    launchState,
    "confirmed"
  );

  if (!stateAfterInfo) {
    throw new Error(
      `${label}: LaunchState disappeared after rejected transaction.`
    );
  }

  const stateAfter = Buffer.from(
    stateAfterInfo.data
  );

  if (!stateAfter.equals(stateBefore)) {
    throw new Error(
      `${label}: LaunchState bytes changed despite rejected transaction.`
    );
  }

  const sourceAccountAfterInfo =
    await connection.getAccountInfo(
      sourceQuoteVault,
      "confirmed"
    );

  const destinationAccountAfterInfo =
    await connection.getAccountInfo(
      destinationQuoteVault,
      "confirmed"
    );

  if (!sourceAccountAfterInfo) {
    throw new Error(
      `${label}: source token account disappeared after rejection.`
    );
  }

  if (!destinationAccountAfterInfo) {
    throw new Error(
      `${label}: destination token account disappeared after rejection.`
    );
  }

  if (
    !Buffer.from(sourceAccountAfterInfo.data)
      .equals(sourceAccountDataBefore)
  ) {
    throw new Error(
      `${label}: complete source token-account data changed despite rejected transaction.`
    );
  }

  if (
    !Buffer.from(destinationAccountAfterInfo.data)
      .equals(destinationAccountDataBefore)
  ) {
    throw new Error(
      `${label}: complete destination token-account data changed despite rejected transaction.`
    );
  }

  const sourceAfter = BigInt(
    await getTokenRawBalance(
      connection,
      sourceQuoteVault
    )
  );

  const destinationAfter = BigInt(
    await getTokenRawBalance(
      connection,
      destinationQuoteVault
    )
  );

  if (sourceAfter !== sourceBefore) {
    throw new Error(
      `${label}: source vault changed despite rejected transaction. ` +
      `before=${sourceBefore} after=${sourceAfter}`
    );
  }

  if (destinationAfter !== destinationBefore) {
    throw new Error(
      `${label}: destination vault changed despite rejected transaction. ` +
      `before=${destinationBefore} after=${destinationAfter}`
    );
  }

  console.log(
    `${label}: atomic rollback verified.`
  );

  console.log(
    `Source unchanged: ${sourceAfter}`
  );

  console.log(
    `Destination unchanged: ${destinationAfter}`
  );

  console.log(
    `${label}: complete SPL token-account bytes unchanged.`
  );
}

async function switchPoolToUsdcWithJupiterSecurityFixture({
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

  const stateInfo = await readState({ program, mint });

  console.log(
    "\n================ JUPITER SECURITY SWITCH TO USDC ================"
  );

  const mockUsdcOutNumber = envNumber(
    "MOCK_SWITCH_USDC_OUT",
    100000
  );

  const minAmountOut = usdcToBaseBn(
    mockUsdcOutNumber
  );

  const approvedAmountIn = BigInt(
    await getTokenRawBalance(
      connection,
      stateInfo.treasuryWsolVault
    )
  );

  if (approvedAmountIn <= 0n) {
    throw new Error(
      "Treasury WSOL must be greater than zero before Jupiter security switch."
    );
  }

  console.log(
    "Approved source amount:",
    formatSol(approvedAmountIn)
  );

  console.log(
    "Minimum destination output:",
    formatUsdc(
      BigInt(minAmountOut.toString())
    )
  );

  if (stateInfo.state !== PHASE.AMM_LIVE) {
    throw new Error(
      `Expected AMM_LIVE before wrong-state security test. Got ${phaseName(stateInfo.state)}`
    );
  }

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      stateInfo.pdas.launchState,
    sourceQuoteVault:
      stateInfo.treasuryWsolVault,
    destinationQuoteVault:
      stateInfo.treasuryUsdcVault,
    remainingAccounts: [],
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER STATE NOT SWITCHING",
  });

  const beginSig = await program.methods
    .beginPoolSwitch(
      QUOTE.USDC,
      new anchor.BN(
        approvedAmountIn.toString()
      ),
      minAmountOut
    )
    .accountsPartial({
      creator: user.publicKey,
      launchState: stateInfo.pdas.launchState,
      sourceQuoteVault:
        stateInfo.treasuryWsolVault,
      platformWallet: PLATFORM_WALLET,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(
    "beginPoolSwitch:",
    beginSig
  );

  await confirmViaWs(
    connection,
    beginSig,
    "finalized"
  );

  const afterBegin = await printState({
    program,
    mint,
    label: "AFTER JUPITER SECURITY BEGIN",
  });

  if (afterBegin.state !== PHASE.SWITCHING) {
    throw new Error(
      `Expected switching phase. Got ${phaseName(afterBegin.state)}`
    );
  }

  /*
   * Simulate an attacker donating one base unit of WSOL
   * after the creator approved the pool amount.
   *
   * Native SOL is transferred directly into the WSOL
   * token account and SyncNative updates its SPL amount.
   */
  const donationBaseUnitsRaw =
    process.env.JUPITER_DONATION_BASE_UNITS ||
    "1";

  if (!/^\d+$/.test(donationBaseUnitsRaw)) {
    throw new Error(
      `Invalid JUPITER_DONATION_BASE_UNITS: ${donationBaseUnitsRaw}`
    );
  }

  const donationBaseUnits =
    BigInt(donationBaseUnitsRaw);

  if (
    donationBaseUnits < 0n ||
    donationBaseUnits >
      BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      `JUPITER_DONATION_BASE_UNITS must be between 0 and ${Number.MAX_SAFE_INTEGER}.`
    );
  }

  if (donationBaseUnits > 0n) {
    const donationSig =
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey:
              afterBegin.treasuryWsolVault,
            lamports: Number(
              donationBaseUnits
            ),
          }),
          createSyncNativeInstruction(
            afterBegin.treasuryWsolVault
          )
        ),
        []
      );

    console.log(
      `WSOL donation (${donationBaseUnits.toString()} base units):`,
      donationSig
    );

    /*
     * provider.sendAndConfirm may return at confirmed commitment while
     * an immediate RPC token-balance read can still observe the prior slot.
     * Finalize the donation and wait until the synced WSOL amount is visible
     * before asserting the security-test precondition.
     */
    await confirmViaWs(
      connection,
      donationSig,
      "finalized"
    );
  } else {
    console.log(
      "WSOL donation: 0 base units (exact-source-balance case)"
    );
  }

  const expectedSourceBefore =
    approvedAmountIn +
    donationBaseUnits;

  let sourceBefore = BigInt(
    await getTokenRawBalance(
      connection,
      afterBegin.treasuryWsolVault
    )
  );

  for (
    let attempt = 0;
    attempt < 20 &&
    sourceBefore !== expectedSourceBefore;
    attempt++
  ) {
    await sleep(100);

    sourceBefore = BigInt(
      await getTokenRawBalance(
        connection,
        afterBegin.treasuryWsolVault
      )
    );
  }

  const destinationBefore = BigInt(
    await getTokenRawBalance(
      connection,
      afterBegin.treasuryUsdcVault
    )
  );

  if (sourceBefore !== expectedSourceBefore) {
    throw new Error(
      `Donation setup mismatch. Expected source ${expectedSourceBefore}, got ${sourceBefore}.`
    );
  }

  console.log(
    "Source before CPI:",
    sourceBefore.toString()
  );

  console.log(
    "Approved amount:",
    approvedAmountIn.toString()
  );

  console.log(
    "Donation:",
    donationBaseUnits.toString()
  );

  /*
   * Create the fixture's external accounts.
   *
   * The source sink belongs to the test wallet.
   * The output donor belongs to a PDA derived by the
   * test-only Jupiter-address fixture.
   */
  const userWsolSink =
    await maybeCreateAtaIx(
      connection,
      user.publicKey,
      user.publicKey,
      NATIVE_MINT
    );

  const [fixtureDonorAuthority] =
    PublicKey.findProgramAddressSync(
      [Buffer.from("mock_donor")],
      JUPITER_V6_PROGRAM_ID
    );

  const fixtureUsdcDonor =
    await maybeCreateAtaIx(
      connection,
      user.publicKey,
      fixtureDonorAuthority,
      USDC_MINT,
      true
    );

  const setupIxs:
    TransactionInstruction[] = [];

  pushMaybe(
    setupIxs,
    userWsolSink.ix
  );

  pushMaybe(
    setupIxs,
    fixtureUsdcDonor.ix
  );

  if (setupIxs.length > 0) {
    const setupSig =
      await provider.sendAndConfirm(
        new Transaction().add(
          ...setupIxs
        ),
        []
      );

    console.log(
      "Created Jupiter fixture ATAs:",
      setupSig
    );
  }

  /*
   * Fund the fixture PDA's USDC donor token account.
   * The mock USDC mint authority remains the local
   * test wallet only.
   */
  const donorFundSig =
    await provider.sendAndConfirm(
      new Transaction().add(
        createMintToInstruction(
          USDC_MINT,
          fixtureUsdcDonor.ata,
          user.publicKey,
          BigInt(
            minAmountOut.toString()
          ),
          [],
          TOKEN_PROGRAM_ID
        )
      ),
      []
    );

  console.log(
    "Funded Jupiter fixture donor:",
    donorFundSig
  );

  /*
   * Patch 1 regression fixture.
   *
   * The LOCAL fixture does not implement Jupiter's real route-plan
   * argument schema. It deliberately uses the real Anchor instruction
   * discriminator and fixed account ABI while its trailing test-only
   * arguments remain amount_in, amount_out and mutation_mode.
   */
  const fixtureInstructionName =
    currentJupiterFixtureInstructionName();

  const swapData =
    encodeJupiterFixtureSwapData({
      instructionName:
        fixtureInstructionName,
      amountIn:
        approvedAmountIn,
      amountOut:
        BigInt(
          minAmountOut.toString()
        ),
      mutationMode: 0,
    });

  /*
   * Fixed account order mirrors the Jupiter v6 ABI checked by Moonz.
   *
   * route:
   * 0 tokenProgram
   * 1 userTransferAuthority
   * 2 userSourceTokenAccount
   * 3 userDestinationTokenAccount
   * 4 destinationTokenAccount
   * 5 destinationMint
   *
   * sharedAccountsRoute:
   * 0 tokenProgram
   * 1 programAuthority
   * 2 userTransferAuthority
   * 3 sourceTokenAccount
   * 4 programSourceTokenAccount
   * 5 programDestinationTokenAccount
   * 6 destinationTokenAccount
   * 7 sourceMint
   * 8 destinationMint
   *
   * Accounts after those fixed positions are test-fixture-only.
   * launch_state is deliberately non-signer in the outer Moonz
   * instruction. Moonz validates the account and reconstructs its
   * Jupiter AccountMeta as signer only inside invoke_signed().
   */
  const remainingAccounts =
    fixtureInstructionName === "route"
      ? [
          {
            pubkey: TOKEN_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.pdas.launchState,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.treasuryWsolVault,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.treasuryUsdcVault,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey:
              fixtureUsdcDonor.ata,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: USDC_MINT,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: userWsolSink.ata,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey:
              fixtureDonorAuthority,
            isWritable: false,
            isSigner: false,
          },
        ]
      : [
          {
            pubkey: TOKEN_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              fixtureDonorAuthority,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.pdas.launchState,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.treasuryWsolVault,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: userWsolSink.ata,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey:
              fixtureUsdcDonor.ata,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey:
              afterBegin.treasuryUsdcVault,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: NATIVE_MINT,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: USDC_MINT,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey:
              fixtureDonorAuthority,
            isWritable: false,
            isSigner: false,
          },
        ];

  console.log(
    "Jupiter fixture program:",
    JUPITER_V6_PROGRAM_ID.toBase58()
  );

  console.log(
    "Fixture donor PDA:",
    fixtureDonorAuthority.toBase58()
  );

  console.log(
    "Fixture instruction family:",
    fixtureInstructionName
  );

  const authorityIndex =
    fixtureInstructionName === "route"
      ? 1
      : 2;

  const sourceIndex =
    fixtureInstructionName === "route"
      ? 2
      : 3;

  const destinationIndex =
    fixtureInstructionName === "route"
      ? 3
      : 6;

  const destinationMintIndex =
    fixtureInstructionName === "route"
      ? 5
      : 8;

  const replaceRemainingMeta = (
    index: number,
    replacement: {
      pubkey: PublicKey;
      isWritable: boolean;
      isSigner: boolean;
    }
  ) => {
    return remainingAccounts.map(
      (meta, i) =>
        i === index
          ? replacement
          : meta
    );
  };

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    instructionName:
      "route_with_token_ledger",
    label:
      "JUPITER TOKEN-LEDGER DISCRIMINATOR",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    instructionName:
      "shared_accounts_exact_out_route",
    label:
      "JUPITER EXACT-OUT DISCRIMINATOR",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    instructionName:
      "not_a_moonz_authorized_jupiter_instruction",
    label:
      "JUPITER UNKNOWN DISCRIMINATOR",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      replaceRemainingMeta(
        0,
        {
          pubkey:
            SystemProgram.programId,
          isWritable: false,
          isSigner: false,
        }
      ),
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG TOKEN PROGRAM ROLE",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      replaceRemainingMeta(
        authorityIndex,
        {
          pubkey: user.publicKey,
          isWritable: false,
          isSigner: true,
        }
      ),
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG USER TRANSFER AUTHORITY ROLE",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      replaceRemainingMeta(
        sourceIndex,
        {
          pubkey: userWsolSink.ata,
          isWritable: true,
          isSigner: false,
        }
      ),
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG FIXED SOURCE ACCOUNT ROLE",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      replaceRemainingMeta(
        destinationIndex,
        {
          pubkey:
            fixtureUsdcDonor.ata,
          isWritable: true,
          isSigner: false,
        }
      ),
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG FIXED DESTINATION ACCOUNT ROLE",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      replaceRemainingMeta(
        destinationMintIndex,
        {
          pubkey: NATIVE_MINT,
          isWritable: false,
          isSigner: false,
        }
      ),
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG DESTINATION MINT ROLE",
  });

  if (
    fixtureInstructionName ===
    "shared_accounts_route"
  ) {
    await expectJupiterSecurityExecuteRejectedAndRolledBack({
      program,
      provider,
      launchState:
        afterBegin.pdas.launchState,
      sourceQuoteVault:
        afterBegin.treasuryWsolVault,
      destinationQuoteVault:
        afterBegin.treasuryUsdcVault,
      remainingAccounts:
        replaceRemainingMeta(
          7,
          {
            pubkey: USDC_MINT,
            isWritable: false,
            isSigner: false,
          }
        ),
      cpiAmountIn:
        approvedAmountIn,
      cpiAmountOut:
        BigInt(minAmountOut.toString()),
      label:
        "JUPITER WRONG SOURCE MINT ROLE",
    });
  }

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts: [
      ...remainingAccounts,
      {
        pubkey: afterBegin.saleVault,
        isWritable: false,
        isSigner: false,
      },
    ],
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER SALE VAULT BLOCKED",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts: [
      ...remainingAccounts,
      {
        pubkey: afterBegin.lpVault,
        isWritable: false,
        isSigner: false,
      },
    ],
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER LP VAULT BLOCKED",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts: [
      ...remainingAccounts,
      {
        pubkey: user.publicKey,
        isWritable: false,
        isSigner: true,
      },
    ],
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER UNAPPROVED SIGNER",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    swapProgram:
      SystemProgram.programId,
    label:
      "NON-JUPITER SWAP PROGRAM",
  });

  const duplicateSourceRemainingAccounts = [
    ...remainingAccounts,
    {
      pubkey:
        afterBegin.treasuryWsolVault,
      isWritable: true,
      isSigner: false,
    },
  ];

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts:
      duplicateSourceRemainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER DUPLICATE CONTROLLED SOURCE",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.lpVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG SOURCE VAULT",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.lpVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER WRONG DESTINATION VAULT",
  });

  if (approvedAmountIn <= 1n) {
    throw new Error(
      `Approved switch amount is too small for approved-1 security test: ${approvedAmountIn}`
    );
  }

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn - 1n,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER UNDER-CONSUME APPROVED-1",
  });

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn + 1n,
    cpiAmountOut:
      BigInt(minAmountOut.toString()),
    label:
      "JUPITER OVER-CONSUME APPROVED+1",
  });

  const minAmountOutBigInt =
    BigInt(minAmountOut.toString());

  if (minAmountOutBigInt <= 0n) {
    throw new Error(
      `Minimum output is too small for minimum-1 security test: ${minAmountOutBigInt}`
    );
  }

  await expectJupiterSecurityExecuteRejectedAndRolledBack({
    program,
    provider,
    launchState:
      afterBegin.pdas.launchState,
    sourceQuoteVault:
      afterBegin.treasuryWsolVault,
    destinationQuoteVault:
      afterBegin.treasuryUsdcVault,
    remainingAccounts,
    cpiAmountIn:
      approvedAmountIn,
    cpiAmountOut:
      minAmountOutBigInt - 1n,
    label:
      "JUPITER MIN-OUTPUT BELOW BOUNDARY",
  });

  const mutationCases = [
    {
      mode: 1,
      label:
        "JUPITER POST-CPI SOURCE DELEGATE MUTATION",
    },
    {
      mode: 2,
      label:
        "JUPITER POST-CPI DESTINATION DELEGATE MUTATION",
    },
    {
      mode: 3,
      label:
        "JUPITER POST-CPI SOURCE CLOSE-AUTHORITY MUTATION",
    },
    {
      mode: 4,
      label:
        "JUPITER POST-CPI DESTINATION CLOSE-AUTHORITY MUTATION",
    },
    {
      mode: 5,
      label:
        "JUPITER POST-CPI SOURCE TOKEN-OWNER MUTATION",
    },
    {
      mode: 6,
      label:
        "JUPITER POST-CPI DESTINATION TOKEN-OWNER MUTATION",
    },
  ];

  for (const mutationCase of mutationCases) {
    await expectJupiterSecurityExecuteRejectedAndRolledBack({
      program,
      provider,
      launchState:
        afterBegin.pdas.launchState,
      sourceQuoteVault:
        afterBegin.treasuryWsolVault,
      destinationQuoteVault:
        afterBegin.treasuryUsdcVault,
      remainingAccounts,
      cpiAmountIn:
        approvedAmountIn,
      cpiAmountOut:
        BigInt(
          minAmountOut.toString()
        ),
      mutationMode:
        mutationCase.mode,
      label:
        mutationCase.label,
    });
  }

  console.log(
    "\n================ EXECUTE JUPITER SECURITY CPI ================"
  );

  const execSig =
    await program.methods
      .executePoolSwitchSwap(
        swapData
      )
      .accountsPartial({
        platformSigner:
          user.publicKey,
        launchState:
          afterBegin.pdas.launchState,
        sourceQuoteVault:
          afterBegin.treasuryWsolVault,
        destinationQuoteVault:
          afterBegin.treasuryUsdcVault,
        swapProgram:
          JUPITER_V6_PROGRAM_ID,
      })
      .remainingAccounts(
        remainingAccounts
      )
      .rpc();

  console.log(
    "executePoolSwitchSwap:",
    execSig
  );

  await confirmViaWs(
    connection,
    execSig,
    "finalized"
  );

  const afterSwap =
    await printState({
      program,
      mint,
      label:
        "AFTER JUPITER SECURITY SWAP",
    });

  const sourceAfter = BigInt(
    await getTokenRawBalance(
      connection,
      afterSwap.treasuryWsolVault
    )
  );

  const destinationAfter = BigInt(
    await getTokenRawBalance(
      connection,
      afterSwap.treasuryUsdcVault
    )
  );

  if (sourceAfter > sourceBefore) {
    throw new Error(
      "Source balance increased during Jupiter security CPI."
    );
  }

  if (
    destinationAfter <
    destinationBefore
  ) {
    throw new Error(
      "Destination balance decreased during Jupiter security CPI."
    );
  }

  const sourceDecrease =
    sourceBefore - sourceAfter;

  const destinationIncrease =
    destinationAfter -
    destinationBefore;

  if (
    sourceDecrease !==
    approvedAmountIn
  ) {
    throw new Error(
      `Approved source consumption mismatch. Approved ${approvedAmountIn}, consumed ${sourceDecrease}.`
    );
  }

  if (
    sourceAfter !==
    donationBaseUnits
  ) {
    throw new Error(
      `Donation was incorrectly consumed. Expected ${donationBaseUnits} base unit to remain, got ${sourceAfter}.`
    );
  }

  if (
    destinationIncrease <
    BigInt(
      minAmountOut.toString()
    )
  ) {
    throw new Error(
      `Minimum output not satisfied. Minimum ${minAmountOut.toString()}, received ${destinationIncrease}.`
    );
  }

  console.log(
    "Source decrease:",
    sourceDecrease.toString()
  );

  console.log(
    "Source donation remaining:",
    sourceAfter.toString()
  );

  console.log(
    "Destination increase:",
    destinationIncrease.toString()
  );

  console.log(
    "✅ Approved amount consumed exactly."
  );

  console.log(
    `✅ ${donationBaseUnits.toString()} donated base units remained in old source vault.`
  );

  console.log(
    "✅ Minimum destination output satisfied."
  );

  console.log(
    "\n================ COMPLETE JUPITER SECURITY SWITCH ================"
  );

  const completeSig =
    await program.methods
      .completePoolSwitch()
      .accountsPartial({
        platformSigner:
          PLATFORM_WALLET,
        platformFeeReceiver:
          PLATFORM_FEE_WALLET,
        launchState:
          afterSwap.pdas.launchState,
        treasuryWsolVault:
          afterSwap.treasuryWsolVault,
        treasuryUsdcVault:
          afterSwap.treasuryUsdcVault,
      })
      .rpc();

  console.log(
    "completePoolSwitch:",
    completeSig
  );

  await confirmViaWs(
    connection,
    completeSig,
    "finalized"
  );

  const afterComplete =
    await printState({
      program,
      mint,
      label:
        "AFTER JUPITER SECURITY COMPLETE",
    });

  if (
    afterComplete.state !==
    PHASE.AMM_LIVE
  ) {
    throw new Error(
      `Expected AMM live after completion. Got ${phaseName(afterComplete.state)}`
    );
  }

  if (
    afterComplete.quoteAsset !==
    QUOTE.USDC
  ) {
    throw new Error(
      `Expected USDC quote after completion. Got ${quoteName(afterComplete.quoteAsset)}`
    );
  }

  const finalOldSourceBalance =
    BigInt(
      await getTokenRawBalance(
        connection,
        afterComplete.treasuryWsolVault
      )
    );

  if (
    finalOldSourceBalance !==
    donationBaseUnits
  ) {
    throw new Error(
      `Old source donation changed during completion. Expected ${donationBaseUnits}, got ${finalOldSourceBalance}.`
    );
  }

  console.log(
    "✅ Pool switch completed with donation still present."
  );

  console.log(
    "✅ Donation-griefing happy-path security test PASS."
  );
}

async function tradeUsdcAfterSwitch({
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

  const stateInfo = await readState({ program, mint });

  if (stateInfo.state !== PHASE.AMM_LIVE) {
    throw new Error(`Expected AMM live before USDC trading. Got ${phaseName(stateInfo.state)}`);
  }

  if (stateInfo.quoteAsset !== QUOTE.USDC) {
    throw new Error(`Expected USDC quote before USDC trading. Got ${quoteName(stateInfo.quoteAsset)}`);
  }

  const userToken = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    mint
  );

  const userUsdc = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    user.publicKey,
    USDC_MINT
  );

  const creatorFeeAuthority = deriveCreatorFeeAuthority(
    program.programId,
    stateInfo.creator
  );

  const creatorFeeUsdc = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    creatorFeeAuthority,
    USDC_MINT,
    true
  );

  const platformUsdc = await maybeCreateAtaIx(
    connection,
    user.publicKey,
    PLATFORM_WALLET,
    USDC_MINT
  );

  const setupIxs: TransactionInstruction[] = [];
  pushMaybe(setupIxs, userToken.ix);
  pushMaybe(setupIxs, userUsdc.ix);
  pushMaybe(setupIxs, creatorFeeUsdc.ix);
  pushMaybe(setupIxs, platformUsdc.ix);

  if (setupIxs.length > 0) {
    const setupSig = await provider.sendAndConfirm(
      new Transaction().add(...setupIxs),
      []
    );

    console.log("Created USDC trade ATAs:", setupSig);
  }

  const testBuyUsdcNumber = envNumber("TEST_USDC_BUY", 1000);
  const buyAmount = usdcToBaseBn(testBuyUsdcNumber);

  await mintMockUsdcToUser({
    provider,
    amountUsdc: testBuyUsdcNumber,
  });

  const tokenBeforeBuy = BigInt(
    await getTokenRawBalance(connection, userToken.ata)
  );

  const userUsdcBeforeBuy = BigInt(
    await getTokenRawBalance(connection, userUsdc.ata)
  );

  const treasuryUsdcBeforeBuy = BigInt(
    await getTokenRawBalance(connection, stateInfo.treasuryUsdcVault)
  );

  const lpBeforeBuy = BigInt(
    await getTokenRawBalance(connection, stateInfo.lpVault)
  );

  console.log("\n================ AMM BUY WITH USDC ================");
  console.log("Input:", formatUsdc(BigInt(buyAmount.toString())), "USDC");

  const buySig = await program.methods
    .ammBuyUsdc(buyAmount, new anchor.BN(0))
    .accountsPartial({
      buyer: user.publicKey,
      launchState: stateInfo.pdas.launchState,
      lpVault: stateInfo.lpVault,
      buyerAta: userToken.ata,
      buyerUsdcAta: userUsdc.ata,
      treasuryUsdcVault: stateInfo.treasuryUsdcVault,
      creatorFeeAuthority,
      creatorFeeUsdcVault: creatorFeeUsdc.ata,
      platformUsdcAta: platformUsdc.ata,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("ammBuyUsdc:", buySig);
  await confirmViaWs(connection, buySig, "finalized");

  const tokenAfterBuy = BigInt(
    await getTokenRawBalance(connection, userToken.ata)
  );

  const userUsdcAfterBuy = BigInt(
    await getTokenRawBalance(connection, userUsdc.ata)
  );

  const treasuryUsdcAfterBuy = BigInt(
    await getTokenRawBalance(connection, stateInfo.treasuryUsdcVault)
  );

  const lpAfterBuy = BigInt(
    await getTokenRawBalance(connection, stateInfo.lpVault)
  );

  const boughtTokens = tokenAfterBuy - tokenBeforeBuy;

  console.log("User token delta:", formatToken(boughtTokens));
  console.log("User USDC delta:", formatUsdc(userUsdcAfterBuy - userUsdcBeforeBuy));
  console.log("Treasury USDC delta:", formatUsdc(treasuryUsdcAfterBuy - treasuryUsdcBeforeBuy));
  console.log("LP token vault delta:", formatToken(lpAfterBuy - lpBeforeBuy));

  if (boughtTokens <= 0n) {
    throw new Error("USDC AMM buy produced zero tokens.");
  }

  if (treasuryUsdcAfterBuy <= treasuryUsdcBeforeBuy) {
    throw new Error("Treasury USDC did not increase after AMM USDC buy.");
  }

  const sellPercent = BigInt(envInt("TEST_USDC_SELL_PERCENT", 50));

  if (sellPercent <= 0n || sellPercent > 100n) {
    throw new Error("Invalid TEST_USDC_SELL_PERCENT. Use 1-100.");
  }

  const sellTokens = (boughtTokens * sellPercent) / 100n;

  if (sellTokens <= 0n) {
    throw new Error("Calculated sell amount is zero.");
  }

  const tokenBeforeSell = BigInt(
    await getTokenRawBalance(connection, userToken.ata)
  );

  const userUsdcBeforeSell = BigInt(
    await getTokenRawBalance(connection, userUsdc.ata)
  );

  const treasuryUsdcBeforeSell = BigInt(
    await getTokenRawBalance(connection, stateInfo.treasuryUsdcVault)
  );

  const lpBeforeSell = BigInt(
    await getTokenRawBalance(connection, stateInfo.lpVault)
  );

  console.log("\n================ AMM SELL TO USDC ================");
  console.log("Selling:", formatToken(sellTokens), "tokens");
  console.log("Sell percent of bought tokens:", sellPercent.toString() + "%");

  const sellSig = await program.methods
    .ammSellUsdc(new anchor.BN(sellTokens.toString()), new anchor.BN(0))
    .accountsPartial({
      seller: user.publicKey,
      launchState: stateInfo.pdas.launchState,
      lpVault: stateInfo.lpVault,
      sellerAta: userToken.ata,
      sellerUsdcAta: userUsdc.ata,
      treasuryUsdcVault: stateInfo.treasuryUsdcVault,
      creatorFeeAuthority,
      creatorFeeUsdcVault: creatorFeeUsdc.ata,
      platformUsdcAta: platformUsdc.ata,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("ammSellUsdc:", sellSig);
  await confirmViaWs(connection, sellSig, "finalized");

  const tokenAfterSell = BigInt(
    await getTokenRawBalance(connection, userToken.ata)
  );

  const userUsdcAfterSell = BigInt(
    await getTokenRawBalance(connection, userUsdc.ata)
  );

  const treasuryUsdcAfterSell = BigInt(
    await getTokenRawBalance(connection, stateInfo.treasuryUsdcVault)
  );

  const lpAfterSell = BigInt(
    await getTokenRawBalance(connection, stateInfo.lpVault)
  );

  console.log("User token delta:", formatToken(tokenAfterSell - tokenBeforeSell));
  console.log("User USDC delta:", formatUsdc(userUsdcAfterSell - userUsdcBeforeSell));
  console.log("Treasury USDC delta:", formatUsdc(treasuryUsdcAfterSell - treasuryUsdcBeforeSell));
  console.log("LP token vault delta:", formatToken(lpAfterSell - lpBeforeSell));

  if (tokenAfterSell >= tokenBeforeSell) {
    throw new Error("User token balance did not decrease after AMM USDC sell.");
  }

  if (userUsdcAfterSell <= userUsdcBeforeSell) {
    throw new Error("User USDC balance did not increase after AMM USDC sell.");
  }

  if (treasuryUsdcAfterSell >= treasuryUsdcBeforeSell) {
    throw new Error("Treasury USDC did not decrease after AMM USDC sell.");
  }

  await printState({
    program,
    mint,
    label: "AFTER USDC BUY AND SELL",
  });

  console.log("\n✅ USDC AMM buy worked.");
  console.log("✅ USDC AMM sell worked.");
}

describe("aaped-launch localnet launch and bonding flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  const program = new Program<AapedLaunch>(
    require("../target/idl/aaped_launch.json"),
    provider
  ) as Program<AapedLaunch>;

  it("creates a launch and bonds it to AMM", async () => {
    const wallet = provider.wallet as anchor.Wallet;
    const user = wallet.payer;

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", program.programId.toBase58());
    console.log("Expected program:", PROGRAM_ID.toBase58());
    console.log("Wallet:", user.publicKey.toBase58());
    console.log("Platform wallet:", PLATFORM_WALLET.toBase58());
    console.log("Mock USDC mint:", USDC_MINT.toBase58());
    console.log("Mock swap program:", MOCK_SWAP_PROGRAM_ID.toBase58());

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

    if (RUN_JUPITER_SECURITY_SWITCH) {
      console.warn(
        "RUN_JUPITER_SECURITY_SWITCH is enabled. The local validator must load the audited test-only fixture at the real Jupiter v6 program address."
      );

      await switchPoolToUsdcWithJupiterSecurityFixture({
        program,
        provider,
        mint,
      });
    } else if (RUN_LEGACY_MOCK_SWITCH) {
      console.warn(
        "RUN_LEGACY_MOCK_SWITCH is enabled. This requires a dedicated test build " +
          "whose allowed swap program is the local mock harness, not the mainnet Jupiter-only binary."
      );

      await switchPoolToUsdcWithMockSwap({
        program,
        provider,
        mint,
      });

      await tradeUsdcAfterSwitch({
        program,
        provider,
        mint,
      });

      await expectSwitchBackToWsolBlockedByCooldown({
        program,
        provider,
        mint,
      });
    } else {
      console.log(
        "Skipping pool-switch execution. Set RUN_JUPITER_SECURITY_SWITCH=true for the production-Jupiter security fixture."
      );
    }

    console.log("✅ Launch + bonding + AMM migration test completed");
  });
});
