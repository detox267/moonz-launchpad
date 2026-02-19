import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getMint,
  getAccount,
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

    console.log("Program ID:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());

    // 1️⃣ Create mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    console.log("Mint created:", mint.toBase58());

    // 2️⃣ Mint receiver ATA
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    console.log("Mint receiver ATA:", mintReceiver.address.toBase58());

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

    console.log("LaunchState PDA:", launchStatePda.toBase58());
    console.log("Treasury SOL Vault:", treasurySolVault.toBase58());
    console.log("Creator SOL Vault:", creatorSolVault.toBase58());
    console.log("Platform SOL Vault:", platformSolVault.toBase58());

    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    console.log("Sale vault:", saleVault.publicKey.toBase58());
    console.log("LP vault:", lpVault.publicKey.toBase58());

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

    const sig = await program.methods
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

    console.log("Initialize TX signature:", sig);

    // 🔎 Fetch state
    const state = await program.account.launchState.fetch(launchStatePda);

    console.log("----- LaunchState -----");
    console.log("Mint:", state.mint.toBase58());
    console.log("Sale vault:", state.saleVault.toBase58());
    console.log("LP vault:", state.lpVault.toBase58());
    console.log("Total supply:", state.totalSupply.toString());
    console.log("Sale supply:", state.saleSupply.toString());
    console.log("LP supply:", state.lpSupply.toString());
    console.log("State phase:", state.state);

    // 🔎 Check vault balances
    const saleVaultInfo = await getAccount(provider.connection, saleVault.publicKey);
    const lpVaultInfo = await getAccount(provider.connection, lpVault.publicKey);

    console.log("Sale vault token balance:", saleVaultInfo.amount.toString());
    console.log("LP vault token balance:", lpVaultInfo.amount.toString());

    // 🔎 Verify mint authority removed
    const mintInfo = await getMint(provider.connection, mint);
    console.log("Mint authority:", mintInfo.mintAuthority);
    console.log("Freeze authority:", mintInfo.freezeAuthority);

    if (mintInfo.mintAuthority !== null) {
      throw new Error("Mint authority NOT revoked");
    }

    if (mintInfo.freezeAuthority !== null) {
      throw new Error("Freeze authority NOT revoked");
    }

    console.log("✅ Initialize test PASSED");
  });
});
