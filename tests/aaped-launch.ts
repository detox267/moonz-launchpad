import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---- CONFIG ----
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const SEND_DELAY_MS = 1100;
const MAX_SEND_RETRIES = 6;

// MUST match your Rust constant PLATFORM_WALLET
const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

// Metaplex Token Metadata program (devnet/mainnet)
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// ---- helpers ----
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

describe("aaped launch - 3 tx init flow", () => {
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

  it("initialize_launch -> initialize_metadata -> finalize_mint_authorities", async () => {
    const payer = (rlProvider.wallet as anchor.Wallet).payer;

    console.log("RPC:", RPC_URL);
    console.log("Program:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());

    // 1) Create mint (payer temporarily holds mint+freeze authority)
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority (TEMP)
      payer.publicKey, // freeze authority (TEMP)
      6
    );
    console.log("Mint:", mint.toBase58());

    // 2) PDAs
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
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );
    console.log("Metadata PDA:", metadataPda.toBase58());

    // Token vault accounts (new accounts created by Anchor in init)
    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();

    // 3) TX1 params (must match InitializeParams)
    const initParams = {
      creator: payer.publicKey,
      platform: PLATFORM_WALLET,         // IMPORTANT: must equal hardcoded constant
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

      // stored for guards + later used to build metadata
      name: "AAPED",
      symbol: "AAPED",
      uri: "https://example.com/meta.json",
    };

    // --- TX1: initialize_launch ---
    const sig1 = await rpcWithThrottleAndRetry("TX1 initialize_launch", async () => {
      return await program.methods
        .initializeLaunch(initParams as any)
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

    // fetch state to confirm metadata stored matches PDA
    const st1: any = await program.account.launchState.fetch(launchStatePda);
    console.log("Stored metadata:", st1.metadata.toBase58());
    if (!st1.metadata.equals(metadataPda)) {
      throw new Error("Stored metadata PDA does not match expected Metaplex PDA");
    }

    // --- TX2: initialize_metadata ---
    // If your Rust handler signature is initialize_metadata(ctx, params: MetadataParams):
    const metaParams = {
      name: initParams.name,
      symbol: initParams.symbol,
      uri: initParams.uri,
    };

    const sig2 = await rpcWithThrottleAndRetry("TX2 initialize_metadata", async () => {
      return await program.methods
        // If your IDL expects args: initializeMetadata(metaParams)
        .initializeMetadata(metaParams as any)
        // If your IDL expects NO args (initializeMetadata()), use:
        // .initializeMetadata()
        .accounts({
          payer: payer.publicKey,
          mintAuthority: payer.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });
    console.log("TX2 sig:", sig2);

    // --- TX3: finalize authorities (revoke mint + freeze) ---
    const sig3 = await rpcWithThrottleAndRetry("TX3 finalize_mint_authorities", async () => {
      return await program.methods
        // match your rust instruction name:
        .finalizeMintAuthorities()
        // if you named it finalize_mint_immutable instead, use:
        // .finalizeMintImmutable()
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

    console.log("✅ 3-tx init complete");
  });
});
