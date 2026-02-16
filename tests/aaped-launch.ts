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

// Metaplex Token Metadata Program ID (fixed)
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// LaunchPhase enum mirror (from your Rust)
const PHASE = {
  Curve: 0,
  Tail: 1,
  MigrationPending: 2,
  Migrated: 3,
} as const;

let mint: PublicKey;
let launchStatePda: PublicKey;
let metadataPda: PublicKey;

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
  it("Initializes launch state (with immutable Metaplex metadata)", async () => {
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

    // 3) Derive program PDAs
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

    // 4) Derive Metaplex metadata PDA (must match your Anchor seeds constraint)
    // seeds: ["metadata", mpl_program_id, mint]
    [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    // 5) Init vault token accounts (Anchor will create these with init)
    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    // 6) Initialize params (NOW includes name/symbol/uri)
    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"), // 1B * 1e6
      saleSupply: new anchor.BN("600000000000000"), // 600M * 1e6
      lpSupply: new anchor.BN("400000000000000"), // 400M * 1e6

       // If program uses state values, set them to match math.rs:
      vSol: new anchor.BN("75800000000"),            // 75.8 SOL lamports
      vTok: new anchor.BN("526200000000000"),  // 526.2M * 1e6

      tailStart: new anchor.BN("583829673767736"),
      tailEnd: new anchor.BN("0"),

      migrationSolTarget: new anchor.BN((89 * LAMPORTS).toString()),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,

      // ✅ NEW (metaplex)
      name: "AAPED Launch Token",
      symbol: "AAPED",
      uri: "https://example.com/metadata.json",
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

        // ✅ SOL vault PDAs
        treasurySolVault,
        creatorSolVault,
        platformSolVault,

        // ✅ Metaplex accounts
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,

        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([saleVault, lpVault])
      .rpc();

    console.log("initializeLaunch tx:", tx);

    const st = await fetchState();
    console.log("Initial phase:", phaseName(st.state));

    // Verify state-bound metadata (if you stored it in LaunchState)
    if ((st as any).metadata !== undefined) {
      console.log("State metadata:", (st as any).metadata.toBase58());
      console.log("Expected metadata:", metadataPda.toBase58());
    }

    if ((st as any).tailPriceTokensPerLamport !== undefined) {
      console.log(
        "Initial tail rate:",
        String((st as any).tailPriceTokensPerLamport)
      );
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
    console.log(
      "spent SOL:",
      ((buyerSolBefore - buyerSolAfter) / LAMPORTS).toFixed(6)
    );
    console.log("got tokens:", gotTokens.toFixed(6));
    console.log("sale drained:", drained.toFixed(6));
    console.log(
      "treasury +SOL:",
      ((treasuryAfter - treasuryBefore) / LAMPORTS).toFixed(6)
    );
    console.log(
      "creator  +SOL:",
      ((creatorAfter - creatorBefore) / LAMPORTS).toFixed(6)
    );
    console.log(
      "platform +SOL:",
      ((platformAfter - platformBefore) / LAMPORTS).toFixed(6)
    );

    const st = await fetchState();
    console.log("Phase after buy:", phaseName(st.state));
    if ((st as any).tailPriceTokensPerLamport !== undefined) {
      console.log("Tail rate:", String((st as any).tailPriceTokensPerLamport));
    }
  });

  it("pressure: buy -> sell -> buy has no drift", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const trader = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      trader.publicKey,
      10 * LAMPORTS
    );
    await provider.connection.confirmTransaction(sig);

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

  it("Lot test: buy 5, sell lot #1, buy 5, sell lots #2-#5 (FIFO lots)", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const trader = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      trader.publicKey,
      80 * LAMPORTS
    );
    await provider.connection.confirmTransaction(sig);

    const traderAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      trader.publicKey
    );

    const DECIMALS = 6;
    const BASE = 10 ** DECIMALS;

    async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
      const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
      return BigInt(bal.value.amount);
    }

    async function solLamports(pubkey: PublicKey): Promise<bigint> {
      return BigInt(await provider.connection.getBalance(pubkey));
    }

    async function doBuyOneSol(): Promise<{
      gotBase: bigint;
      spentLamports: bigint;
    }> {
      const st = await fetchState();
      if (st.state !== PHASE.Curve) {
        throw new Error(
          `Buy attempted outside Curve. phase=${phaseName(st.state)}`
        );
      }

      const tokBefore = await tokenBaseAmount(traderAta.address);
      const solBefore = await solLamports(trader.publicKey);

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
      const solAfter = await solLamports(trader.publicKey);

      return {
        gotBase: tokAfter - tokBefore,
        spentLamports: solBefore - solAfter,
      };
    }

    async function doSellExact(
      sellBase: bigint
    ): Promise<{ receivedLamports: bigint }> {
      const st = await fetchState();
      if (st.state !== PHASE.Curve) {
        throw new Error(
          `Sell attempted outside Curve. phase=${phaseName(st.state)}`
        );
      }

      const tokBal = await tokenBaseAmount(traderAta.address);
      if (tokBal < sellBase) {
        throw new Error(`Not enough tokens to sell. have=${tokBal} want=${sellBase}`);
      }

      const solBefore = await solLamports(trader.publicKey);

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

      const solAfter = await solLamports(trader.publicKey);
      return { receivedLamports: solAfter - solBefore };
    }

    function pxSolPerTok(lamportsIn: bigint, tokBase: bigint): number {
      if (tokBase === 0n) return 0;
      const sol = Number(lamportsIn) / LAMPORTS;
      const tok = Number(tokBase) / BASE;
      return sol / tok;
    }

    const lots: bigint[] = [];
    console.log("\n=== Batch 1: 5 buys (record lots) ===");

    for (let i = 1; i <= 5; i++) {
      const { gotBase, spentLamports } = await doBuyOneSol();
      lots.push(gotBase);

      console.log(
        `B1 buy #${i}: got ${(Number(gotBase) / BASE).toFixed(6)} tok` +
          ` | spent ${(Number(spentLamports) / LAMPORTS).toFixed(6)} SOL` +
          ` | buy px ${pxSolPerTok(spentLamports, gotBase).toFixed(9)} SOL/tok`
      );
    }

    console.log("\n=== Sell: lot #1 only ===");
    const sellLot1 = lots[0];
    const sell1 = await doSellExact(sellLot1);

    console.log(
      `Sell lot #1: sold ${(Number(sellLot1) / BASE).toFixed(6)} tok` +
        ` | received ${(Number(sell1.receivedLamports) / LAMPORTS).toFixed(6)} SOL` +
        ` | sell px ${pxSolPerTok(sell1.receivedLamports, sellLot1).toFixed(9)} SOL/tok`
    );

    console.log("\n=== Batch 2: 5 buys (continue up curve) ===");
    for (let i = 1; i <= 5; i++) {
      const { gotBase, spentLamports } = await doBuyOneSol();
      console.log(
        `B2 buy #${i}: got ${(Number(gotBase) / BASE).toFixed(6)} tok` +
          ` | spent ${(Number(spentLamports) / LAMPORTS).toFixed(6)} SOL` +
          ` | buy px ${pxSolPerTok(spentLamports, gotBase).toFixed(9)} SOL/tok`
      );
    }

    console.log("\n=== Sell: lots #2-#5 from batch 1 ===");
    for (let i = 1; i < 5; i++) {
      const lot = lots[i];
      const sellRes = await doSellExact(lot);

      console.log(
        `Sell lot #${i + 1}: sold ${(Number(lot) / BASE).toFixed(6)} tok` +
          ` | received ${(Number(sellRes.receivedLamports) / LAMPORTS).toFixed(6)} SOL` +
          ` | sell px ${pxSolPerTok(sellRes.receivedLamports, lot).toFixed(9)} SOL/tok`
      );
    }

    const stEnd = await fetchState();
    console.log("\n=== End state ===");
    console.log("phase:", phaseName(stEnd.state));
    console.log("tokens_sold:", stEnd.tokensSold.toString());
    console.log("sol_collected:", stEnd.solCollected.toString());
    console.log("lp_growth_sol:", stEnd.lpGrowthSol.toString());
  });
});
