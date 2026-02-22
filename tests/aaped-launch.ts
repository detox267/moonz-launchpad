import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Commitment,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---- CONFIG ----
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

// For most providers, ws is wss:// + same host/path
const WS_URL = RPC_URL.replace("https://", "wss://");

// Platform wallet (must match hardcoded PLATFORM_WALLET in lib.rs)
const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Use the standard Solana CLI keypair path on your machine
// You asked: ~/.config/solana/id.json
const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

/**
 * Websocket confirmation (no RPC signature polling lag)
 */
async function confirmViaWs(
  connection: anchor.web3.Connection,
  signature: string,
  commitment: Commitment = "finalized",
  timeoutMs = 20000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Signature confirmation timeout: ${signature}`));
    }, timeoutMs);

    connection.onSignature(
      signature,
      (notif) => {
        clearTimeout(t);
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

describe("initialize-launch (3 tx flow) + events + dev buy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // IMPORTANT: set wsEndpoint so onLogs/onSignature works reliably
  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("TX1 -> TX2 -> TX3, then dev BUY 1 SOL (confirmed by websocket)", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;

    // -----------------------------
    // Load PLATFORM mint authority signer (from Solana CLI path)
    // -----------------------------
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.
Expected: ${PLATFORM_WALLET.toBase58()}
Got:      ${platformSigner.publicKey.toBase58()}
Path:     ${PLATFORM_KEYPAIR_PATH}`
      );
    }

    console.log("RPC:", RPC_URL);
    console.log("WS:", WS_URL);
    console.log("Program:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("Platform (mint authority):", platformSigner.publicKey.toBase58());
    console.log("Platform keypair path:", PLATFORM_KEYPAIR_PATH);

    const bal = await connection.getBalance(payer.publicKey);
    console.log("Payer Balance:", bal / LAMPORTS_PER_SOL, "SOL");

    // -----------------------------
    // Subscribe to program logs (captures emit! events)
    // -----------------------------
    const subId = connection.onLogs(
      program.programId,
      (ev) => {
        console.log("\n================= PROGRAM LOGS =================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      // ---------------------------------------
      // 1️⃣ CREATE MINT (platform is authority)
      // ---------------------------------------
      const mint = await createMint(
        connection,
        payer, // fee payer for creating mint account
        platformSigner.publicKey, // mint authority = platform
        platformSigner.publicKey, // freeze authority = platform
        6
      );

      console.log("Mint:", mint.toBase58());

      // ---------------------------------------
      // 2️⃣ Derive PDAs
      // ---------------------------------------
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

      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        MPL_PROGRAM_ID
      );

      const saleVault = Keypair.generate();
      const lpVault = Keypair.generate();

      const fakeName = "AAPED TEST";
      const fakeSymbol = "AAPED";
      const fakeUri = "https://example.com/aaped/meta.json";

      // NOTE:
      // - params.platform MUST equal PLATFORM_WALLET (hardcoded validation)
      // - ctx.accounts.mintAuthority MUST equal PLATFORM_WALLET (your new enforcement)
      const params = {
        creator: payer.publicKey,
        platform: PLATFORM_WALLET,
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

      // ---------------------------------------
      // TX1 initialize_launch (signed by platformSigner)
      // ---------------------------------------
      const sig1 = await program.methods
        .initializeLaunch(params as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: platformSigner.publicKey,
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
        .signers([platformSigner, saleVault, lpVault])
        .rpc();

      console.log("TX1 sig:", sig1);
      await confirmViaWs(connection, sig1, "finalized");
      console.log("TX1 finalized (ws)");

      const st1: any = await program.account.launchState.fetch(launchStatePda);
      if (!st1.metadata.equals(metadataPda)) throw new Error("Metadata PDA mismatch");

      // ---------------------------------------
      // TX2 initialize_metadata (signed by platformSigner)
      // ---------------------------------------
      const sig2 = await program.methods
        .initializeMetadata({
          name: fakeName,
          symbol: fakeSymbol,
          uri: fakeUri,
        } as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenMetadataProgram: MPL_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner])
        .rpc();

      console.log("TX2 sig:", sig2);
      await confirmViaWs(connection, sig2, "finalized");
      console.log("TX2 finalized (ws)");

      // ---------------------------------------
      // TX3 finalize_mint_authorities (signed by platformSigner)
      // ---------------------------------------
      const sig3 = await program.methods
        .finalizeMintAuthorities()
        .accounts({
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([platformSigner])
        .rpc();

      console.log("TX3 sig:", sig3);
      await confirmViaWs(connection, sig3, "finalized");
      console.log("TX3 finalized (ws)");

      // ---------------------------------------
      // VERIFY AUTHORITIES REVOKED (after ws finalization)
      // ---------------------------------------
      // Using getMint here is fine because we already waited for finalized via websocket.
      const mintInfo = await getMint(connection, mint, "finalized");

      console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
      console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);

      if (mintInfo.mintAuthority !== null) throw new Error("Mint authority NOT revoked");
      if (mintInfo.freezeAuthority !== null) throw new Error("Freeze authority NOT revoked");

      // ============================================================
      // DEV BUY: 1 SOL (gross input) after authorities finalized
      // ============================================================
      // Ensure payer has an ATA for this mint (create if missing)
      const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false);

      const ataInfo = await connection.getAccountInfo(buyerAta, "confirmed");
      if (!ataInfo) {
        console.log("Creating buyer ATA:", buyerAta.toBase58());
        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey, // payer for ATA creation
          buyerAta,
          payer.publicKey, // owner
          mint
        );

        const tx = new anchor.web3.Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

        // payer signs (provider wallet)
        const signed = await provider.wallet.signTransaction(tx);
        const sigAta = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });

        console.log("ATA create sig:", sigAta);
        await confirmViaWs(connection, sigAta, "finalized");
        console.log("ATA created (ws finalized)");
      }

      // Buy 1 SOL, allow high slippage for test (minTokensOut = 0)
      const solInLamports = new anchor.BN(1 * LAMPORTS_PER_SOL);
      const minTokensOut = new anchor.BN(0);

      const sigBuy = await program.methods
        .buy(solInLamports, minTokensOut)
        .accounts({
          buyer: payer.publicKey,
          launchState: launchStatePda,
          saleVault: saleVault.publicKey,
          buyerAta,
          treasurySolVault,
          creatorSolVault,
          platformSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([]) // payer signs via provider wallet automatically
        .rpc();

      console.log("BUY sig:", sigBuy);
      await confirmViaWs(connection, sigBuy, "finalized");
      console.log("BUY finalized (ws)");

      // Optional: fetch buyer token balance
      const buyerAtaParsed = await connection.getParsedAccountInfo(buyerAta, "finalized");
      const amt =
        (buyerAtaParsed.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmountString ??
        "0";
      console.log("Buyer ATA balance (ui):", amt);
    } finally {
      await connection.removeOnLogsListener(subId);
    }
  });
});
