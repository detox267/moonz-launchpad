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

describe("Full Launch Flow + Escrow Dev Buy + Normal Buy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Full flow works", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error("Platform keypair mismatch");
    }

    // ---------------- CREATE MINT ----------------
    const mint = await createMint(
      connection,
      payer,
      platformSigner.publicKey,
      platformSigner.publicKey,
      6
    );

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

    // ---------------- TX1 initialize ----------------
    await program.methods
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

    // ---------------- TX2 metadata ----------------
    await program.methods
      .initializeMetadata(metadataBump, {
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
      })
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

    // ---------------- TX3 revoke authorities ----------------
    await program.methods
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

    // ---------------- ENSURE ATA EXISTS ----------------
    const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const ataInfo = await connection.getAccountInfo(buyerAta);

    if (!ataInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        buyerAta,
        payer.publicKey,
        mint
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix));
    }

    // ---------------- DEPOSIT ESCROW ----------------
    const escrowAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .depositEscrow(escrowAmount)
      .accounts({
        depositor: payer.publicKey,
        mint,
        launchState: launchStatePda,
        escrowSolVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // ---------------- DEV BUY START CURVE ----------------
    await program.methods
      .devBuyStartCurve(escrowAmount, new anchor.BN(0))
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

    // ---------------- NORMAL BUY (curve now live) ----------------
    await program.methods
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

    console.log("Full flow executed successfully.");
  });
});
