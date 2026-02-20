import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getMint } from "@solana/spl-token";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---- CONFIG ----
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const SEND_DELAY_MS = 1100;
const MAX_SEND_RETRIES = 6;

// MUST match your on-chain constant PLATFORM_WALLET
const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableSendError(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("block height exceeded") ||
    m.includes("blockhash not found") ||
    m.includes("node is behind") ||
    m.includes("429") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("timed out") ||
    m.includes("transaction was not confirmed")
  );
}

async function rpcWithThrottleAndRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: any = null;

  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    await sleep(SEND_DELAY_MS);
    try {
      const res = await fn();
      console.log(`✅ ${label} success (attempt ${attempt})`);
      return res;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      console.log(`❌ ${label} failed (attempt ${attempt}): ${msg}`);

      const logs = e?.logs || e?.transactionLogs;
      if (logs?.length) {
        console.log("---- logs ----");
        for (const l of logs) console.log(l);
        console.log("--------------");
      }

      if (!isRetryableSendError(msg)) break;
      await sleep(400 + attempt * 250);
    }
  }

  throw lastErr;
}

describe("initialize-launch (3 tx flow)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  const wallet = provider.wallet as anchor.Wallet;
  const rlProvider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const program = new Program<AapedLaunch>(
    anchor.workspace.AapedLaunch.idl,
    anchor.workspace.AapedLaunch.programId,
    rlProvider
  );

  it("TX1 -> TX2 -> TX3 (mint/freeze revoke after metadata)", async () => {
    const payer = (rlProvider.wallet as anchor.Wallet).payer;

    console.log("RPC:", RPC_URL);
    console.log("Payer:", payer.publicKey.toBase58());

    const bal = await connection.getBalance(payer.publicKey, "confirmed");
    console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

    // 1) Create mint (payer is mint+freeze authority TEMPORARILY)
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority
      6
    );
    console.log("Mint:", mint.toBase58());

    // 2) Derive PDAs
    const [launchStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), mint.toBuffer()],
      program.programId
    );

    const [treasurySolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_sol"), mint.toBuffer()],
      program.programId
    );
    const [creatorSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_sol"), mint.toBuffer()],
      program.programId
    );
    const [platformSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform_sol"), mint.toBuffer()],
      program.programId
    );

    // Metaplex metadata PDA
    const mplProgramId = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.toBuffer()],
      mplProgramId
    );

    // 3) Token vault accounts (new keypairs because Anchor init needs new addresses)
    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();

    // 4) Fake data for init (so you can SEE state stored)
    const fakeName = "AAPED TEST";
    const fakeSymbol = "AAPED";
    const fakeUri = "https://example.com/aaped/meta.json";

    const params = {
      creator: payer.publicKey,
      platform: PLATFORM_WALLET,       // MUST match program constant
      coreAuthority: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("30000000000"),
      vTok: new anchor.BN("526200000000000"),

      migrationSolTarget: new anchor.BN((89 * LAMPORTS_PER_SOL).toString()),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,

      name: fakeName,
      symbol: fakeSymbol,
      uri: fakeUri,
    };

    // -------------------------
    // TX1: initialize_launch
    // -------------------------
    const sig1 = await rpcWithThrottleAndRetry("initialize_launch", async () => {
      return await program.methods
        .initializeLaunch(params as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: payer.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVault.publicKey,
          lpVault: lpVault.publicKey,
          treasurySolVault,
          creatorSolVault,
          platformSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([saleVault, lpVault])
        .rpc();
    });

    console.log("TX1 sig:", sig1);

    const st1: any = await program.account.launchState.fetch(launchStatePda);
    console.log("launch_state:", launchStatePda.toBase58());
    console.log("sale_vault:", st1.saleVault.toBase58());
    console.log("lp_vault:", st1.lpVault.toBase58());
    console.log("metadata stored:", st1.metadata.toBase58());

    if (!st1.metadata.equals(metadataPda)) {
      throw new Error("Stored metadata PDA does not match expected Metaplex PDA");
    }

    // -------------------------
    // TX2: initialize_metadata
    // -------------------------
    const sig2 = await rpcWithThrottleAndRetry("initialize_metadata", async () => {
      return await program.methods
        .initializeMetadata({
          name: fakeName,
          symbol: fakeSymbol,
          uri: fakeUri,
        } as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: payer.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenMetadataProgram: mplProgramId,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    console.log("TX2 sig:", sig2);

    // -------------------------
    // TX3: finalize_mint_authorities
    // -------------------------
    const sig3 = await rpcWithThrottleAndRetry("finalize_mint_authorities", async () => {
      return await program.methods
        .finalizeMintAuthorities()
        .accounts({
          mintAuthority: payer.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

    console.log("TX3 sig:", sig3);

    // Check mint authorities are revoked
    const mintInfo = await getMint(connection, mint, "confirmed");
    console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
    console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);

    if (mintInfo.mintAuthority !== null) throw new Error("Mint authority NOT revoked");
    if (mintInfo.freezeAuthority !== null) throw new Error("Freeze authority NOT revoked");
  });
});
