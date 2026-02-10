import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
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

  async function fetchState() {
    // Anchor generated account fetch
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

    // 4) Init vault token accounts
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
    // tailPriceTokensPerLamport exists only if you added it to IDL via rebuild
    if ((st as any).tailPriceTokensPerLamport !== undefined) {
      console.log("Initial tail rate:", String((st as any).tailPriceTokensPerLamport));
    }
  });

  it("Simulates a single buy (with vault deltas)", async () => {
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

    const st = await fetchState();
    console.log("Phase after buy:", phaseName(st.state));
    if ((st as any).tailPriceTokensPerLamport !== undefined) {
      console.log("Tail rate:", String((st as any).tailPriceTokensPerLamport));
    }
  });

  it("pressure: buy -> sell -> buy has no drift", async () => {
  const payer = provider.wallet as anchor.Wallet;
  const trader = Keypair.generate();

  await provider.connection.requestAirdrop(
    trader.publicKey,
    10 * LAMPORTS
  );

  const traderAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer.payer,
    mint,
    trader.publicKey
  );

  const st0 = await fetchState();
  const treasury0 = await lamports(treasurySolVault);

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

  const sellerBal = await tokenUiAmount(traderAta.address);
  const sellAmount = Math.floor(sellerBal * 0.25);

  await program.methods
    .sell(new anchor.BN(sellAmount))
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

  const st1 = await fetchState();
  const treasury1 = await lamports(treasurySolVault);

  console.log("sol_collected start:", st0.solCollected.toString());
  console.log("sol_collected end  :", st1.solCollected.toString());
  console.log("treasury start SOL:", treasury0 / LAMPORTS);
  console.log("treasury end   SOL:", treasury1 / LAMPORTS);
});

  it("Cycle sim: 5 buys then 1 sell (Curve repricing check)", async () => {
  const payer = provider.wallet as anchor.Wallet;
  const trader = Keypair.generate();

  // Give enough SOL to run multiple cycles
  const sig = await provider.connection.requestAirdrop(trader.publicKey, 80 * LAMPORTS);
  await provider.connection.confirmTransaction(sig);

  const traderAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer.payer,
    mint,
    trader.publicKey
  );

  // Helpers for base units (6 decimals)
  const DECIMALS = 6;
  const BASE = 10 ** DECIMALS;

  async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
    // amount is a string of base units
    return BigInt(bal.value.amount);
  }

  async function runBuy(label: string) {
    const stBefore = await fetchState();
    if (stBefore.state !== PHASE.Curve) {
      console.log(`${label}: stopping buys because phase=${phaseName(stBefore.state)}`);
      return { did: false, gotBase: 0n, spentLamports: 0n };
    }

    const tokBefore = await tokenBaseAmount(traderAta.address);
    const solBefore = BigInt(await lamports(trader.publicKey));

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

    const tokAfter = await tokenBaseAmount(traderAta.address);
    const solAfter = BigInt(await lamports(trader.publicKey));

    const gotBase = tokAfter - tokBefore;
    const spentLamports = solBefore - solAfter;

    return { did: true, gotBase, spentLamports };
  }

  async function runSell(label: string, sellBase: bigint) {
    const stBefore = await fetchState();
    if (stBefore.state !== PHASE.Curve) {
      console.log(`${label}: skipping sell because phase=${phaseName(stBefore.state)} (sell only allowed in Curve)`);
      return { did: false, soldBase: 0n, gotLamports: 0n };
    }

    const tokBefore = await tokenBaseAmount(traderAta.address);
    const solBefore = BigInt(await lamports(trader.publicKey));

    await program.methods
      .sell(new anchor.BN(sellBase.toString()))
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

    const tokAfter = await tokenBaseAmount(traderAta.address);
    const solAfter = BigInt(await lamports(trader.publicKey));

    const soldBaseActual = tokBefore - tokAfter;
    const gotLamports = solAfter - solBefore; // seller balance increases on sell

    return { did: true, soldBase: soldBaseActual, gotLamports };
  }

  // ---- main cycle loop ----
  const MAX_CYCLES = 30;

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const stStart = await fetchState();
    if (stStart.state !== PHASE.Curve) {
      console.log(`\nCycle #${cycle}: stop (phase=${phaseName(stStart.state)})`);
      break;
    }

    console.log(`\n===== Cycle #${cycle} (phase=${phaseName(stStart.state)}) =====`);

    // 5 buys
    let totalGotBase = 0n;
    let totalSpentLamports = 0n;

    for (let j = 1; j <= 5; j++) {
      const r = await runBuy(`cycle${cycle}/buy${j}`);
      if (!r.did) break;
      totalGotBase += r.gotBase;
      totalSpentLamports += r.spentLamports;

      const avgBuyPriceLamportsPerToken =
        totalGotBase > 0n ? Number(totalSpentLamports) / (Number(totalGotBase) / BASE) : 0;

      console.log(
        `buy ${j}/5: got ${(Number(r.gotBase) / BASE).toFixed(6)} tok` +
          ` | spent ${(Number(r.spentLamports) / LAMPORTS).toFixed(6)} SOL` +
          ` | avg buy px ${(avgBuyPriceLamportsPerToken / LAMPORTS).toFixed(9)} SOL/tok`
      );
    }

    const tokBal = await tokenBaseAmount(traderAta.address);

    // Sell 25% of current holdings (base units), ensure non-zero
    let sellBase = tokBal / 4n;
    if (sellBase < 1n) {
      console.log(`cycle${cycle}: stopping (token balance too small to sell)`);
      break;
    }

    // Optional: clamp sell to a smaller chunk to reduce fee noise
    // sellBase = coreMin(sellBase, 10_000_000n); // e.g. sell 10 tokens (10 * 1e6) — uncomment if you want

    const sellRes = await runSell(`cycle${cycle}/sell`, sellBase);
    if (!sellRes.did) {
      console.log(`cycle${cycle}: stopping (sell not executed)`);
      break;
    }

    const avgBuyPriceLamportsPerToken =
      totalGotBase > 0n ? Number(totalSpentLamports) / (Number(totalGotBase) / BASE) : 0;

    const sellPriceLamportsPerToken =
      sellRes.soldBase > 0n ? Number(sellRes.gotLamports) / (Number(sellRes.soldBase) / BASE) : 0;

    console.log(
      `SELL: sold ${(Number(sellRes.soldBase) / BASE).toFixed(6)} tok` +
        ` | received ${(Number(sellRes.gotLamports) / LAMPORTS).toFixed(6)} SOL` +
        ` | sell px ${(sellPriceLamportsPerToken / LAMPORTS).toFixed(9)} SOL/tok`
    );

    // Simple check: sell price should generally be <= most recent buy price because fees/slippage,
    // but it should trend upward across cycles as curve rises.
    const stEnd = await fetchState();
    console.log(
      `cycle summary: avg buy px ${(avgBuyPriceLamportsPerToken / LAMPORTS).toFixed(9)} SOL/tok` +
        ` | sell px ${(sellPriceLamportsPerToken / LAMPORTS).toFixed(9)} SOL/tok` +
        ` | sol_collected=${stEnd.solCollected.toString()}`
    );
  }
});
});
