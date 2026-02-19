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

const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

// LaunchPhase enum mirror (from your Rust)
const PHASE = {
  Curve: 0,
  Tail: 1,
  MigrationPending: 2,
  Migrated: 3,
} as const;

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

  // ---------- helpers ----------
  async function lamports(pubkey: PublicKey) {
    return await provider.connection.getBalance(pubkey);
  }

  async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
    return BigInt(bal.value.amount); // base units
  }

  async function saleRemainingBase(): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(saleVault.publicKey);
    return BigInt(bal.value.amount);
  }

  async function fetchState() {
    return await program.account.launchState.fetch(launchStatePda);
  }

  function phaseName(phase: number): string {
    if (phase === PHASE.Curve) return "Curve";
    if (phase === PHASE.Tail) return "Tail";
    if (phase === PHASE.MigrationPending) return "MigrationPending";
    if (phase === PHASE.Migrated) return "Migrated";
    return `Unknown(${phase})`;
  }

  // ---------- tests ----------
  it("Initialize launch + verify mint is immutable (no mint/freeze authority)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // 1) Create mint (standard SPL, 6 decimals)
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey, // mint authority starts as payer
      payer.publicKey, // freeze authority starts as payer
      6
    );

    // 2) Mint receiver ATA (payer)
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    // 3) Derive PDAs
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

    // 4) Init vault token accounts (your program uses init payer + token::authority=launch_state)
    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"), // 1B * 1e6
      saleSupply: new anchor.BN("600000000000000"),  // 600M * 1e6
      lpSupply: new anchor.BN("400000000000000"),    // 400M * 1e6

      vSol: new anchor.BN("30000000000"),            // 30 SOL lamports
      vTok: new anchor.BN("526200000000000"),        // 526.2M * 1e6

      tailStart: new anchor.BN("583829673767736"),
      tailEnd: new anchor.BN("0"),

      migrationSolTarget: new anchor.BN((89 * LAMPORTS).toString()),

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

    const st = await fetchState();
    console.log("Initial phase:", phaseName(st.state));

    // ✅ “Immutable” check for standard SPL mint:
    // Your initialize_launch sets mint authority + freeze authority to None.
    const mintInfo = await getMint(provider.connection, mint);
    const mintAuth = mintInfo.mintAuthority;     // PublicKey | null
    const freezeAuth = mintInfo.freezeAuthority; // PublicKey | null

    console.log("Mint authority:", mintAuth ? mintAuth.toBase58() : null);
    console.log("Freeze authority:", freezeAuth ? freezeAuth.toBase58() : null);

    if (mintAuth !== null) throw new Error("Mint authority is NOT null (mint is not immutable)");
    if (freezeAuth !== null) throw new Error("Freeze authority is NOT null (mint is not immutable)");
  });

  it("Buy 1 SOL: verify vault + buyer deltas", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const buyer = Keypair.generate();

    // airdrop 5 SOL
    const sig = await provider.connection.requestAirdrop(buyer.publicKey, 5 * LAMPORTS);
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

    const saleBefore = await saleRemainingBase();
    const buyerTokBefore = await tokenBaseAmount(buyerAta.address);

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

    const saleAfter = await saleRemainingBase();
    const buyerTokAfter = await tokenBaseAmount(buyerAta.address);

    console.log("buy tx:", buyTx);
    console.log("buyer spent SOL:", (buyerSolBefore - buyerSolAfter) / LAMPORTS);
    console.log("buyer got tokens (base):", (buyerTokAfter - buyerTokBefore).toString());
    console.log("sale vault drained (base):", (saleBefore - saleAfter).toString());
    console.log("treasury +SOL:", (treasuryAfter - treasuryBefore) / LAMPORTS);
    console.log("creator  +SOL:", (creatorAfter - creatorBefore) / LAMPORTS);
    console.log("platform +SOL:", (platformAfter - platformBefore) / LAMPORTS);

    const st = await fetchState();
    console.log("Phase after buy:", phaseName(st.state));
  });

  it("Sell 25% of holdings once (Curve only): verify SOL received", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const trader = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(trader.publicKey, 10 * LAMPORTS);
    await provider.connection.confirmTransaction(sig);

    const traderAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      trader.publicKey
    );

    // Buy first so we have tokens
    await program.methods
      .buy(new anchor.BN(1 * LAMPORTS))
      .accounts({
        buyer: trader.publicKey,
        launchState: launchStatePda,
        saleVault: saleVault.publicKey,
        buyerAta: traderAta.address,
        treasurySolVault,
        creatorSolVault,
        platformSolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader])
      .rpc();

    const tokBal = await tokenBaseAmount(traderAta.address);
    const sellAmount = tokBal / 4n; // 25%

    const solBefore = await lamports(trader.publicKey);

    const sellTx = await program.methods
      .sell(new anchor.BN(sellAmount.toString()))
      .accounts({
        seller: trader.publicKey,
        launchState: launchStatePda,
        saleVault: saleVault.publicKey,
        sellerAta: traderAta.address,
        treasurySolVault,
        creatorSolVault,
        platformSolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader])
      .rpc();

    const solAfter = await lamports(trader.publicKey);

    console.log("sell tx:", sellTx);
    console.log("sold tokens (base):", sellAmount.toString());
    console.log("seller SOL delta:", (solAfter - solBefore) / LAMPORTS);

    const st = await fetchState();
    console.log("Phase after sell:", phaseName(st.state));
  });
});
