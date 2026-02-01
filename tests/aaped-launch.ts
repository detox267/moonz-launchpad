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

  it("Mass buy simulation (stops at MigrationPending / Migrated)", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const buyer = Keypair.generate();

    // airdrop 150 SOL (give headroom so we can reach tail/migration)
    const sig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      150 * LAMPORTS
    );
    await provider.connection.confirmTransaction(sig);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    let prevBuyerTokens = await tokenUiAmount(buyerAta.address);

    let lastPhase = -1;
    let tailStartBuyIndex: number | null = null;

    // You can raise this, but we will BREAK automatically when sale ends
    for (let i = 0; i < 40; i++) {
      const stBefore = await fetchState();
      const phaseBefore = stBefore.state;

      if (phaseBefore !== lastPhase) {
        console.log(`\n--- Phase changed: ${phaseName(lastPhase)} -> ${phaseName(phaseBefore)} at buy #${i + 1} ---`);
        lastPhase = phaseBefore;

        if (phaseBefore === PHASE.Tail && tailStartBuyIndex === null) {
          tailStartBuyIndex = i + 1;
          if ((stBefore as any).tailPriceTokensPerLamport !== undefined) {
            console.log("Captured tail rate:", String((stBefore as any).tailPriceTokensPerLamport));
          }
        }
      }

      // stop if migration pending / migrated
      if (phaseBefore === PHASE.MigrationPending || phaseBefore === PHASE.Migrated) {
        console.log(`Stopping: phase is ${phaseName(phaseBefore)} at buy #${i + 1}`);
        break;
      }

      const buyerSolBefore = await lamports(buyer.publicKey);
      const treasuryBefore = await lamports(treasurySolVault);
      const creatorBefore = await lamports(creatorSolVault);
      const platformBefore = await lamports(platformSolVault);
      const remainingBefore = await saleRemainingUi();

      // Execute buy (1 SOL)
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

      const stAfter = await fetchState();

      console.log(
        `Buy #${i + 1}` +
          ` | phase=${phaseName(stAfter.state)}` +
          ` | got=${deltaTokens.toFixed(6)} tok` +
          ` | spent=${spentSol.toFixed(6)} SOL` +
          ` | drained=${drained.toFixed(6)} tok` +
          ` | remaining=${remainingAfter.toFixed(6)} tok` +
          ` | treasury+${treasuryIn.toFixed(6)} SOL` +
          ` | creator+${creatorIn.toFixed(6)} SOL` +
          ` | platform+${platformIn.toFixed(6)} SOL`
      );

      // If migration pending triggers immediately after this buy, print final snapshot and break.
      if (stAfter.state === PHASE.MigrationPending || stAfter.state === PHASE.Migrated) {
        console.log(`\n*** Sale ended at buy #${i + 1} => ${phaseName(stAfter.state)} ***`);
        if ((stAfter as any).tailPriceTokensPerLamport !== undefined) {
          console.log("Tail rate:", String((stAfter as any).tailPriceTokensPerLamport));
        }
        console.log("tokens_sold:", String(stAfter.tokensSold));
        console.log("sol_collected:", String(stAfter.solCollected));
        console.log("lp_growth_sol:", String(stAfter.lpGrowthSol));
        console.log("sale vault remaining (ui):", remainingAfter.toFixed(6));
        break;
      }
    }

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

  // BUY
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

  // SELL
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

  // BUY AGAIN
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

    if (tailStartBuyIndex !== null) {
      console.log(`\nTail first seen around buy #${tailStartBuyIndex}`);
    } else {
      console.log("\nTail was never reached in this run (check tail_start vs sale_supply and buy size).");
    }
  });
});
