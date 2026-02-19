import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getMint,
} from "@solana/spl-token";

describe("aaped-launch initialize only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  let mint: PublicKey;
  let launchStatePda: PublicKey;
  let saleVault: Keypair;
  let lpVault: Keypair;

  let treasurySolVault: PublicKey;
  let creatorSolVault: PublicKey;
  let platformSolVault: PublicKey;

  it("Initializes launch correctly", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // 1️⃣ Create mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // 2️⃣ Mint receiver ATA
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    // 3️⃣ Derive PDAs
    [launchStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), mint.toBuffer()],
      program.programId
    );

    [treasurySolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_sol"), mint.toBuffer()],
      program.programId
    );

    [creatorSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_sol"), mint.toBuffer()],
      program.programId
    );

    [platformSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform_sol"), mint.toBuffer()],
      program.programId
    );

    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("30000000000"),
      vTok: new anchor.BN("526200000000000"),

      tailStart: new anchor.BN("583829673767736"),
      tailEnd: new anchor.BN("0"),

      migrationSolTarget: new anchor.BN("91000000000"),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,
    };

    console.log("Sending initialize tx...");

    await program.methods
      .initializeLaunch(params)
      .accounts({
        payer: payer.publicKey,
        mintAuthority: payer.publicKey,
        mint,
        mintReceiver: mintReceiver.address,

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

    console.log("Initialize complete");

    // ✅ Fetch state
    const state = await program.account.launchState.fetch(launchStatePda);

    console.log("State.mint:", state.mint.toBase58());
    console.log("State.saleSupply:", state.saleSupply.toString());
    console.log("State.lpSupply:", state.lpSupply.toString());

    // ✅ Verify mint authority removed
    const mintInfo = await getMint(provider.connection, mint);
    console.log("Mint authority:", mintInfo.mintAuthority);

    if (mintInfo.mintAuthority !== null) {
      throw new Error("Mint authority NOT revoked");
    }

    console.log("Initialize test PASSED");
  });
});
