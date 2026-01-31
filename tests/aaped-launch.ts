import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

describe("aaped-launch", () => {
  // Provider / wallet
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // IMPORTANT: workspace name is usually PascalCase (from IDL)
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Initializes launch state", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // 1) Create mint, with mint authority = payer
    const mint = await createMint(
      provider.connection,
      payer.payer,                 // payer for tx fees
      payer.publicKey,             // mint authority
      payer.publicKey,             // freeze authority (you revoke later in program)
      6                            // decimals (matches your TOKEN_DECIMALS = 1_000_000)
    );

    // 2) Create mint_receiver ATA for payer (will receive initial mint)
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    // 3) Derive PDAs your program expects
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

    // NOTE: sale_vault + lp_vault are init accounts in your instruction,
    // so we must generate Keypairs and pass them as signers.
    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();

    // 4) Params (adjust to your desired numbers)
    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN(1_000_000_000_000000), // 1B * 1e6 (decimals=6)
      saleSupply: new anchor.BN(600_000_000_000000),    // 600M * 1e6
      lpSupply: new anchor.BN(400_000_000_000000),      // 400M * 1e6

      vSol: new anchor.BN(30_000_000_000),              // 30 SOL in lamports
      vTok: new anchor.BN(526_200_000_000000),          // 526.2M * 1e6

      tailStart: new anchor.BN(15_000_000_000000),      // 15M * 1e6 remaining
      tailEnd: new anchor.BN(5_000_000_000000),         // 5M * 1e6 remaining

      migrationSolTarget: new anchor.BN(85_000_000_000), // 85 SOL lamports

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,
    };

    // 5) Call initializeLaunch
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
      .signers([saleVault, lpVault]) // because these are init accounts
      .rpc();

    console.log("initializeLaunch tx:", tx);
  });
});
