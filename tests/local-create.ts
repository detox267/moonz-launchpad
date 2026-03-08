import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---------------- CONFIG ----------------
const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

// hard-locked program tokenomics
const TOTAL_SUPPLY = new anchor.BN("1000000000000000"); // 1,000,000,000 * 1e6
const SALE_SUPPLY = new anchor.BN("820000000000000");   // 820,000,000 * 1e6
const LP_SUPPLY = new anchor.BN("180000000000000");     // 180,000,000 * 1e6

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          } catch {
            // ignore
          }
        }

        if (notif.err) {
          reject(
            new Error(`Tx failed (${signature}): ${JSON.stringify(notif.err)}`)
          );
        } else {
          resolve();
        }
      },
      commitment
    );
  });
}

async function confirmAndPause(
  connection: anchor.web3.Connection,
  signature: string,
  label: string,
  pauseMs = 1200
) {
  console.log(`${label} sig:`, signature);
  await confirmViaWs(connection, signature, "finalized");
  console.log(`${label} finalized`);
  await sleep(pauseMs);
}

describe("aaped-launch localnet create flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("runs TX1 -> TX2 -> TX3 on localnet", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.\nExpected: ${PLATFORM_WALLET.toBase58()}\nGot: ${platformSigner.publicKey.toBase58()}`
      );
    }

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("Platform signer:", platformSigner.publicKey.toBase58());

    const logsSub = await connection.onLogs(
      program.programId,
      (ev) => {
        console.log("\n================ PROGRAM LOGS ================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      const creatorReceiver = payer.publicKey;

      // --------------------------------------------------
      // Airdrops for localnet
      // --------------------------------------------------
      const payerAirdrop = await connection.requestAirdrop(
        payer.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmAndPause(connection, payerAirdrop, "Payer airdrop", 500);

      const platformAirdrop = await connection.requestAirdrop(
        platformSigner.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmAndPause(connection, platformAirdrop, "Platform airdrop", 500);

      // --------------------------------------------------
      // STEP 0: create mint
      // --------------------------------------------------
      const mint = await createMint(
        connection,
        payer,
        platformSigner.publicKey,
        platformSigner.publicKey,
        6
      );

      console.log("Mint:", mint.toBase58());
      await sleep(1000);

      // optional ATA for payer
      const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
      const ataInfo = await connection.getAccountInfo(buyerAta, "confirmed");

      if (!ataInfo) {
        console.log("Creating buyer ATA:", buyerAta.toBase58());

        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey,
          buyerAta,
          payer.publicKey,
          mint
        );

        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;

        const latest = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = latest.blockhash;

        const signed = await provider.wallet.signTransaction(tx);
        const sigAta = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });

        await confirmAndPause(connection, sigAta, "ATA create", 800);
      }

      // --------------------------------------------------
      // TX0: deposit escrow first
      // --------------------------------------------------
      const [escrowSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_sol"), mint.toBuffer()],
        program.programId
      );

      const escrowAmount = new anchor.BN(
        (1 * anchor.web3.LAMPORTS_PER_SOL).toString()
      );

      const sig0 = await program.methods
        .depositEscrow(escrowAmount)
        .accounts({
          depositor: payer.publicKey,
          mint,
          escrowSolVault,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await confirmAndPause(connection, sig0, "TX0 depositEscrow", 1000);

      // --------------------------------------------------
      // PDAs
      // --------------------------------------------------
      const [launchStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("launch_state"), mint.toBuffer()],
        program.programId
      );

      const [saleVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("sale_vault"), mint.toBuffer()],
        program.programId
      );

      const [lpVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_vault"), mint.toBuffer()],
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

      const [metadataPda, metadataBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        MPL_PROGRAM_ID
      );

      // --------------------------------------------------
      // TX1 initializeLaunch
      // --------------------------------------------------
      const params = {
        creator: creatorReceiver,
        platform: PLATFORM_WALLET,
        coreAuthority: payer.publicKey,

        totalSupply: TOTAL_SUPPLY,
        saleSupply: SALE_SUPPLY,
        lpSupply: LP_SUPPLY,

        feeTotalBps: 125,
        feeCreatorBps: 105,
        feePlatformBps: 20,

        name: "AAPED LOCAL",
        symbol: "AAPED",
        uri: "https://example.com/meta.json",
      };

      const sig1 = await program.methods
        .initializeLaunch(params as any)
        .accounts({
          platformSigner: platformSigner.publicKey,
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVaultPda,
          lpVault: lpVaultPda,
          treasurySolVault,
          creatorSolVault,
          escrowSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner])
        .rpc();

      await confirmAndPause(connection, sig1, "TX1 initializeLaunch", 1200);

      // --------------------------------------------------
      // TX2 initializeMetadata
      // --------------------------------------------------
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

      await confirmAndPause(connection, sig2, "TX2 initializeMetadata", 1200);

      // --------------------------------------------------
      // TX3 finalizeMintAuthorities
      // --------------------------------------------------
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

      await confirmAndPause(connection, sig3, "TX3 finalizeMintAuthorities", 1200);

      // --------------------------------------------------
      // final checks
      // --------------------------------------------------
      const mintInfo = await getMint(connection, mint, "finalized");

      console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
      console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);

      if (mintInfo.mintAuthority !== null) {
        throw new Error("Mint authority NOT revoked");
      }

      if (mintInfo.freezeAuthority !== null) {
        throw new Error("Freeze authority NOT revoked");
      }

      const metadataInfo = await connection.getAccountInfo(metadataPda, "finalized");
      if (!metadataInfo) {
        throw new Error("Metadata account was not created");
      }

      console.log("✅ Local creation flow completed");
    } finally {
      await connection.removeOnLogsListener(logsSub).catch(() => {});
    }
  });
});
