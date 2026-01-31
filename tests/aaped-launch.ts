import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

let mint: PublicKey;
let launchStatePda: PublicKey;
let saleVault: Keypair;
let lpVault: Keypair;

let treasurySolVault: PublicKey;
let creatorSolVault: PublicKey;
let platformSolVault: PublicKey;

describe("aaped-launch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Initializes launch state", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // 1) Create mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // 2) Mint receiver ATA (payer)
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    // 3) Derive PDAs (ASSIGN TO GLOBALS - NO const)
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

    // 4) Init accounts (Keypairs must be signers)
    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"), // 1B * 1e6
      saleSupply: new anchor.BN("600000000000000"),   // 600M * 1e6
      lpSupply: new anchor.BN("400000000000000"),     // 400M * 1e6

      vSol: new anchor.BN("30000000000"),             // 30 SOL lamports
      vTok: new anchor.BN("526200000000000"),         // 526.2M * 1e6

      tailStart: new anchor.BN("15000000000000"),     // 15M * 1e6 remaining
      tailEnd: new anchor.BN("5000000000000"),        // 5M * 1e6 remaining

      migrationSolTarget: new anchor.BN("85000000000"), // 85 SOL lamports

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,
    };

    const tx = await program.methods
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

    console.log("initializeLaunch tx:", tx);
  });

  it("Simulates a buy", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const buyer = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    const buyTx = await program.methods
      .buy(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL)) // 1 SOL
      .accounts({
        buyer: buyer.publicKey,
        launchState: launchStatePda,
        saleVault: saleVault.publicKey,
        buyerAta: buyerAta.address,

        treasurySolVault,
        creatorSolVault,
        platformSolVault,

        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    console.log("buy tx:", buyTx);

    const buyerBal = await provider.connection.getBalance(buyer.publicKey);
    console.log("buyer SOL after:", buyerBal);

    const tokenBal = await provider.connection.getTokenAccountBalance(
      buyerAta.address
    );
    console.log("buyer tokens:", tokenBal.value.uiAmountString);
  });

  it("Mass buy simulation", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const buyer = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      100 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    for (let i = 0; i < 20; i++) {
      await program.methods
        .buy(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
        .accounts({
          buyer: buyer.publicKey,
          launchState: launchStatePda,
          saleVault: saleVault.publicKey,
          buyerAta: buyerAta.address,

          treasurySolVault,
          creatorSolVault,
          platformSolVault,

          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const tokenBal = await provider.connection.getTokenAccountBalance(
        buyerAta.address
      );

      console.log(`Buy #${i + 1} tokens:`, tokenBal.value.uiAmountString);
    }
  });
});
