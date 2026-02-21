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
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

describe("initialize-launch (3 tx flow)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");

  const program = anchor.workspace
    .AapedLaunch as Program<AapedLaunch>;

  it("TX1 -> TX2 -> TX3 (mint/freeze revoke after metadata)", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;

    console.log("RPC:", RPC_URL);
    console.log("Payer:", payer.publicKey.toBase58());

    const bal = await connection.getBalance(payer.publicKey);
    console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

    // ---------------------------------------
    // 1️⃣ CREATE MINT (payer is temp authority)
    // ---------------------------------------
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
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

    const mplProgramId = new PublicKey(
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
    );

    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        mplProgramId.toBuffer(),
        mint.toBuffer(),
      ],
      mplProgramId
    );

    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();

    const fakeName = "AAPED TEST";
    const fakeSymbol = "AAPED";
    const fakeUri = "https://example.com/aaped/meta.json";

    const params = {
      creator: payer.publicKey,
      platform: PLATFORM_WALLET,
      coreAuthority: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("30000000000"),
      vTok: new anchor.BN("526200000000000"),

      migrationSolTarget: new anchor.BN(
        (89 * LAMPORTS_PER_SOL).toString()
      ),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,

      name: fakeName,
      symbol: fakeSymbol,
      uri: fakeUri,
    };

    // ---------------------------------------
    // TX1 initialize_launch
    // ---------------------------------------
    await program.methods
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

    const st1: any =
      await program.account.launchState.fetch(launchStatePda);

    if (!st1.metadata.equals(metadataPda)) {
      throw new Error("Metadata PDA mismatch");
    }

    // ---------------------------------------
    // TX2 initialize_metadata
    // ---------------------------------------
    await program.methods
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

    // ---------------------------------------
    // TX3 finalize_mint_authorities
    // ---------------------------------------
    await program.methods
      .finalizeMintAuthorities()
      .accounts({
        mintAuthority: payer.publicKey,
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // ---------------------------------------
    // VERIFY AUTHORITIES REVOKED
    // ---------------------------------------
    const mintInfo = await getMint(connection, mint);

    console.log(
      "mintAuthority:",
      mintInfo.mintAuthority?.toBase58() || null
    );

    console.log(
      "freezeAuthority:",
      mintInfo.freezeAuthority?.toBase58() || null
    );

    if (mintInfo.mintAuthority !== null)
      throw new Error("Mint authority NOT revoked");

    if (mintInfo.freezeAuthority !== null)
      throw new Error("Freeze authority NOT revoked");
  });
});
