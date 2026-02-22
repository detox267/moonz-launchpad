import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Commitment,
  Transaction,
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

// ---------------- CONFIG ----------------
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

const WS_URL = RPC_URL.replace("https://", "wss://");

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

/**
 * Websocket confirmation (avoids RPC polling lag)
 */
async function confirmViaWs(
  connection: anchor.web3.Connection,
  signature: string,
  commitment: Commitment = "finalized",
  timeoutMs = 30000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Signature confirmation timeout: ${signature}`));
    }, timeoutMs);

    const subId = connection.onSignature(
      signature,
      (notif) => {
        clearTimeout(t);
        connection.removeSignatureListener(subId).catch(() => {});
        if (notif.err) {
          reject(
            new Error(
              `Tx failed (${signature}): ${JSON.stringify(notif.err)}`
            )
          );
        } else {
          resolve();
        }
      },
      commitment
    );
  });
}

describe("Full Launch Flow (2 user txns) + Escrow Dev Buy + Normal Buy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // IMPORTANT: wsEndpoint set so websocket confirms work
  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Full flow works (user signs TX0 + TX4)", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.\nExpected: ${PLATFORM_WALLET.toBase58()}\nGot: ${platformSigner.publicKey.toBase58()}`
      );
    }

    console.log("RPC:", RPC_URL);
    console.log("WS:", WS_URL);
    console.log("Program:", program.programId.toBase58());
    console.log("User/Payer:", payer.publicKey.toBase58());
    console.log("Platform signer:", platformSigner.publicKey.toBase58());

    // ---------------- PROGRAM LOG SUB ----------------
    const logsSub = connection.onLogs(
      program.programId,
      (ev) => {
        console.log("\n================= PROGRAM LOGS =================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      // ============================================================
      // TX0 (USER SIGNS): CREATE MINT + USER ATA
      // ============================================================
      // Mint authority is platform, but user pays + signs creation.
      const mint = await createMint(
        connection,
        payer, // fee payer
        platformSigner.publicKey, // mint authority
        platformSigner.publicKey, // freeze authority
        6
      );
      console.log("Mint:", mint.toBase58());

      // Ensure user ATA exists
      const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
      const ataInfo = await connection.getAccountInfo(buyerAta, "confirmed");
      if (!ataInfo) {
        console.log("Creating user ATA:", buyerAta.toBase58());
        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey,
          buyerAta,
          payer.publicKey,
          mint
        );

        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed"))
          .blockhash;

        const signed = await provider.wallet.signTransaction(tx);
        const sigAta = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });

        console.log("TX0b ATA sig:", sigAta);
        await confirmViaWs(connection, sigAta, "finalized");
        console.log("TX0b ATA finalized (ws)");
      }

      // ---------------- PDAs ----------------
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

      const [escrowSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_sol"), mint.toBuffer()],
        program.programId
      );

      const [metadataPda, metadataBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        MPL_PROGRAM_ID
      );

      const saleVault = Keypair.generate();
      const lpVault = Keypair.generate();

      // ---------------- INIT PARAMS ----------------
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

        name: "AAPED TEST",
        symbol: "AAPED",
        uri: "https://example.com/meta.json",
      };

      // ============================================================
      // TX1 (PLATFORM SIGNS): initializeLaunch
      // ============================================================
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
          escrowSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner, saleVault, lpVault])
        .rpc();

      console.log("TX1 sig:", sig1);
      await confirmViaWs(connection, sig1, "finalized");
      console.log("TX1 finalized (ws)");

      // ============================================================
      // TX2 (PLATFORM SIGNS): initializeMetadata
      // ============================================================
      const sig2 = await program.methods
        .initializeMetadata(metadataBump, {
          name: params.name,
          symbol: params.symbol,
          uri: params.uri,
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

      // ============================================================
      // TX3 (PLATFORM SIGNS): finalizeMintAuthorities
      // ============================================================
      const sig3 = await program.methods
        .finalizeMintAuthorities(metadataBump)
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

      // Verify mint authorities revoked AFTER finalized
      const mintInfo = await getMint(connection, mint, "finalized");
      console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
      console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);
      if (mintInfo.mintAuthority !== null) throw new Error("Mint authority NOT revoked");
      if (mintInfo.freezeAuthority !== null) throw new Error("Freeze authority NOT revoked");

      // ============================================================
      // TX4 (USER SIGNS): depositEscrow
      // IMPORTANT: deposit 1 SOL + buffer for fees because dev_buy moves
      // multiple transfers. Your earlier error was 988,390,880 vs 990,000,000.
      // So: deposit 1 SOL + 0.01 SOL buffer.
      // ============================================================
      const escrowAmount = new anchor.BN(
        (1 * LAMPORTS_PER_SOL + 0.01 * LAMPORTS_PER_SOL).toString()
      );

      const sig4 = await program.methods
        .depositEscrow(escrowAmount)
        .accounts({
          depositor: payer.publicKey,
          mint,
          launchState: launchStatePda,
          escrowSolVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("TX4 (depositEscrow) sig:", sig4);
      await confirmViaWs(connection, sig4, "finalized");
      console.log("TX4 finalized (ws)");

      // ============================================================
      // TX5 (PLATFORM OR USER, DEPENDS ON YOUR ACCOUNTS):
      // devBuyStartCurve consumes escrow + sends tokens to dev ATA.
      //
      // If your DevBuyStartCurve requires `dev: Signer`, then USER signs.
      // If you changed it to a non-signer dev (recommended for platform-run),
      // then platform can run it.
      //
      // Your current TS assumes `dev` is signer via provider => user signs.
      // ============================================================
      const solInForDevBuy = new anchor.BN((1 * LAMPORTS_PER_SOL).toString());

      const sig5 = await program.methods
        .devBuyStartCurve(solInForDevBuy, new anchor.BN(0))
        .accounts({
          dev: payer.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVault.publicKey,
          devAta: buyerAta,
          treasurySolVault,
          creatorSolVault,
          platformSolVault,
          escrowSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("TX5 (devBuyStartCurve) sig:", sig5);
      await confirmViaWs(connection, sig5, "finalized");
      console.log("TX5 finalized (ws)");

      // ============================================================
      // Normal buy (curve now live)
      // ============================================================
      const sig6 = await program.methods
        .buy(new anchor.BN(1 * LAMPORTS_PER_SOL), new anchor.BN(0))
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
        .rpc();

      console.log("TX6 (buy) sig:", sig6);
      await confirmViaWs(connection, sig6, "finalized");
      console.log("TX6 finalized (ws)");

      console.log("✅ Full flow executed successfully.");
    } finally {
      await connection.removeOnLogsListener(logsSub);
    }
  });
});
