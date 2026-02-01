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

const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

describe("aaped-launch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  // ---------- helpers ----------
  async function lamports(pubkey: PublicKey) {
    return await provider.connection.getBalance(pubkey);
  }

  async function tokenUiAmount(tokenAccount: PublicKey) {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
    return Number(bal.value.uiAmountString ?? "0");
  }

  async function saleRemainingUi() {
    const bal = await provider.connection.getTokenAccountBalance(
      saleVault.publicKey
    );
    return Number(bal.value.uiAmountString ?? "0");
  }

  // ---------- tests ----------
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
      saleSupply: new anchor.BN("600000000000000"), // 600M * 1e6
      lpSupply: new anchor.BN("400000000000000"), // 400M * 1e6

      vSol: new anchor.BN("30000000000"), // 30 SOL lamports
      vTok: new anchor.BN("526200000000000"), // 526.2M * 1e6

      tailStart: new anchor.BN("583829673767736"), 
      tailEnd: new anchor.BN("0"), 

      migrationSolTarget: new anchor.BN((89 * anchor.web3.LAMPORTS_PER_SOL).toString()),

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

  it("Simulates a buy (with vault deltas)", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const buyer = Keypair.generate();

    // airdrop 5 SOL
    const sig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      5 * LAMPORTS
    );
    await provider.connection.confirmTransaction(sig);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    const buyerSolBefore = await lamports(buyer.publicKey);
    const treasuryBefore = await lamports(treasurySolVault);
    const creatorBefore = await lamports(creatorSolVault);
    const platformBefore = await lamports(platformSolVault);
    const remainingBefore = await saleRemainingUi();
    const buyerTokBefore = await tokenUiAmount(buyerAta.address);

    const buyTx = await program.methods
      .buy(new anchor.BN(1 * LAMPORTS))
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

    const buyerSolAfter = await lamports(buyer.publicKey);
    const treasuryAfter = await lamports(treasurySolVault);
    const creatorAfter = await lamports(creatorSolVault);
    const platformAfter = await lamports(platformSolVault);
    const remainingAfter = await saleRemainingUi();
    const buyerTokAfter = await tokenUiAmount(buyerAta.address);

    const gotTokens = buyerTokAfter - buyerTokBefore;
    const drained = remainingBefore - remainingAfter;

    console.log("buy tx:", buyTx);
    console.log("spent SOL:", ((buyerSolBefore - buyerSolAfter) / LAMPORTS).toFixed(6));
    console.log("got tokens:", gotTokens.toFixed(6));
    console.log("sale drained:", drained.toFixed(6));
    console.log("treasury +SOL:", ((treasuryAfter - treasuryBefore) / LAMPORTS).toFixed(6));
    console.log("creator  +SOL:", ((creatorAfter - creatorBefore) / LAMPORTS).toFixed(6));
    console.log("platform +SOL:", ((platformAfter - platformBefore) / LAMPORTS).toFixed(6));
  });

  it("Mass buy simulation (delta per buy + vaults)", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const buyer = Keypair.generate();

    // airdrop 100 SOL
    const sig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      100 * LAMPORTS
    );
    await provider.connection.confirmTransaction(sig);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    let prevBuyerTokens = await tokenUiAmount(buyerAta.address);

    for (let i = 0; i < 90; i++) {
      const buyerSolBefore = await lamports(buyer.publicKey);
      const treasuryBefore = await lamports(treasurySolVault);
      const creatorBefore = await lamports(creatorSolVault);
      const platformBefore = await lamports(platformSolVault);
      const remainingBefore = await saleRemainingUi();

      await program.methods
        .buy(new anchor.BN(1 * LAMPORTS))
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

      const buyerTokensNow = await tokenUiAmount(buyerAta.address);
      const deltaTokens = buyerTokensNow - prevBuyerTokens;
      prevBuyerTokens = buyerTokensNow;

      const buyerSolAfter = await lamports(buyer.publicKey);
      const treasuryAfter = await lamports(treasurySolVault);
      const creatorAfter = await lamports(creatorSolVault);
      const platformAfter = await lamports(platformSolVault);
      const remainingAfter = await saleRemainingUi();

      const spentSol = (buyerSolBefore - buyerSolAfter) / LAMPORTS;
      const treasuryIn = (treasuryAfter - treasuryBefore) / LAMPORTS;
      const creatorIn = (creatorAfter - creatorBefore) / LAMPORTS;
      const platformIn = (platformAfter - platformBefore) / LAMPORTS;
      const drained = remainingBefore - remainingAfter;

      console.log(
        `Buy #${i + 1}` +
          ` | got=${deltaTokens.toFixed(6)} tok` +
          ` | spent=${spentSol.toFixed(6)} SOL` +
          ` | drained=${drained.toFixed(6)} tok` +
          ` | treasury+${treasuryIn.toFixed(6)} SOL` +
          ` | creator+${creatorIn.toFixed(6)} SOL` +
          ` | platform+${platformIn.toFixed(6)} SOL`
      );
    }
  });
});
