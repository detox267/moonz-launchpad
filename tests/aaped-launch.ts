// tests/aaped-launch.ts
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

const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PHASE = {
  Curve: 0,
  MigrationPending: 1,
  Migrated: 2,
} as const;

let mint: PublicKey;
let launchStatePda: PublicKey;
let metadataPda: PublicKey;

let saleVault: Keypair;
let lpVault: Keypair;

let treasurySolVault: PublicKey;
let creatorSolVault: PublicKey;
let platformSolVault: PublicKey;

// Pattern A
let coreAuthority: Keypair;
let coreLpAta: PublicKey;
let coreSolVault: PublicKey;

describe("aaped-launch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  // ---------------- helpers ----------------
  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      Math.floor(sol * LAMPORTS)
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: sig,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    });
    return sig;
  }

  async function lamports(pubkey: PublicKey) {
    return await provider.connection.getBalance(pubkey);
  }

  async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
    return BigInt(bal.value.amount);
  }

  async function tokenUiAmount(tokenAccount: PublicKey): Promise<number> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount);
    return Number(bal.value.uiAmountString ?? "0");
  }

  async function saleRemainingUi(): Promise<number> {
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
    if (phase === PHASE.MigrationPending) return "MigrationPending";
    if (phase === PHASE.Migrated) return "Migrated";
    return `Unknown(${phase})`;
  }

  async function buyOnce(
    buyer: Keypair,
    buyerAta: PublicKey,
    solInLamports: bigint
  ) {
    return await program.methods
      .buy(new anchor.BN(solInLamports.toString()))
      .accounts({
        buyer: buyer.publicKey,
        launchState: launchStatePda,
        saleVault: saleVault.publicKey,
        buyerAta,

        treasurySolVault,
        creatorSolVault,
        platformSolVault,

        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();
  }

  /**
   * Drives buys until LaunchState.state == MigrationPending.
   */
  async function buyUntilMigrationPending(opts: {
    buyer: Keypair;
    buyerAta: PublicKey;
    maxIters?: number;
    startSol?: number;
    maxSolPerBuy?: number;
    balanceBufferSol?: number;
  }) {
    const maxIters = opts.maxIters ?? 64;
    let solPerBuy = opts.startSol ?? 1;
    const maxSolPerBuy = opts.maxSolPerBuy ?? 50;
    const bufferSol = opts.balanceBufferSol ?? 0.2;

    for (let i = 1; i <= maxIters; i++) {
      const st = await fetchState();
      const phase = Number(st.state);

      const remaining = await saleRemainingUi();
      console.log(
        `iter ${i} | phase=${phaseName(phase)} | sale_remaining=${remaining.toFixed(
          6
        )}`
      );

      if (phase === PHASE.MigrationPending) return;

      if (phase !== PHASE.Curve) {
        throw new Error(
          `Unexpected phase while driving buys: ${phaseName(phase)}`
        );
      }

      const balLamports = await lamports(opts.buyer.publicKey);
      const balSol = balLamports / LAMPORTS;

      let wantSol = Math.min(solPerBuy, maxSolPerBuy);
      const maxSpendSol = Math.max(0, balSol - bufferSol);
      wantSol = Math.min(wantSol, maxSpendSol);

      if (wantSol <= 0) {
        throw new Error(
          `Buyer out of SOL (bal=${balSol.toFixed(
            4
          )} SOL, buffer=${bufferSol} SOL)`
        );
      }

      const solInLamports = BigInt(Math.floor(wantSol * LAMPORTS));

      const tokBefore = await tokenBaseAmount(opts.buyerAta);
      const solBefore = await lamports(opts.buyer.publicKey);

      const tx = await buyOnce(opts.buyer, opts.buyerAta, solInLamports);

      const tokAfter = await tokenBaseAmount(opts.buyerAta);
      const solAfter = await lamports(opts.buyer.publicKey);

      const gotBase = tokAfter - tokBefore;
      const spentLamports = BigInt(solBefore - solAfter);

      console.log(
        `  buy ${wantSol.toFixed(4)} SOL | spent ${(
          Number(spentLamports) / LAMPORTS
        ).toFixed(6)} SOL | got ${(Number(gotBase) / 1e6).toFixed(
          6
        )} tok | tx=${tx}`
      );

      solPerBuy = Math.min(solPerBuy * 2, maxSolPerBuy);
    }

    const stEnd = await fetchState();
    throw new Error(
      `Did not reach MigrationPending within maxIters. Final phase=${phaseName(
        Number(stEnd.state)
      )}`
    );
  }

  // ---------------- tests ----------------

  it("Init (Pattern A), prints PDAs", async () => {
    const payer = provider.wallet as anchor.Wallet;

    coreAuthority = Keypair.generate();
    await airdrop(coreAuthority.publicKey, 2);

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

    // 3) Program PDAs
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

    // 4) Metaplex metadata PDA
    [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    // 5) Vault token accounts (created by Anchor init)
    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    // Core LP ATA (destination later)
    const coreAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      coreAuthority.publicKey
    );
    coreLpAta = coreAta.address;

    // Core SOL vault for migration
    coreSolVault = coreAuthority.publicKey;

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,
      coreAuthority: coreAuthority.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("75800000000"),
      vTok: new anchor.BN("526200000000000"),

      migrationSolTarget: new anchor.BN((91 * LAMPORTS).toString()),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,

      name: "AAPED Launch Token",
      symbol: "AAPED",
      uri: "https://example.com/metadata.json",
    };

    const initTx = await program.methods
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

        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,

        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([saleVault, lpVault])
      .rpc();

    console.log("initializeLaunch tx:", initTx);

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    console.log("launch_state:", launchStatePda.toBase58());
    console.log("sale_vault:", saleVault.publicKey.toBase58());
    console.log("lp_vault:", lpVault.publicKey.toBase58());
    console.log("treasury_sol_vault:", treasurySolVault.toBase58());
    console.log("creator_sol_vault:", creatorSolVault.toBase58());
    console.log("platform_sol_vault:", platformSolVault.toBase58());
    console.log("core_authority (stored):", st0.coreAuthority.toBase58());
    console.log("core_lp_ata:", coreLpAta.toBase58());
    console.log("core_sol_vault:", coreSolVault.toBase58());
    console.log("metadata PDA:", metadataPda.toBase58());

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(
        `Expected Curve after init, got ${phaseName(Number(st0.state))}`
      );
    }

    // IMPORTANT: ensure state stored the same metadata PDA you derived
    if (!st0.metadata.equals(metadataPda)) {
      throw new Error(
        `LaunchState.metadata mismatch. state=${st0.metadata.toBase58()} expected=${metadataPda.toBase58()}`
      );
    }
  });

  // ✅ NEW TEST: initialize metadata as separate tx, verify Metaplex PDA exists + owner correct
  it("Initialize metadata (Metaplex) and verify account exists", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // Fake metadata params (replace later with your API payload)
    const metaParams = {
      name: "AAPED Launch Token",
      symbol: "AAPED",
      uri: "https://example.com/metadata.json",
    };

    const tx = await program.methods
      .initializeMetadata(metaParams)
      .accounts({
        payer: payer.publicKey,
        mintAuthority: payer.publicKey, // payer still holds mint authority at this point in your flow
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("initializeMetadata tx:", tx);

    // Verify the metadata PDA exists on-chain and owned by Metaplex program
    const ai = await provider.connection.getAccountInfo(metadataPda);
    if (!ai) {
      throw new Error("Metadata PDA account was not created.");
    }
    if (!ai.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
      throw new Error(
        `Metadata PDA owner mismatch. owner=${ai.owner.toBase58()} expected=${MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()}`
      );
    }

    console.log("metadata account exists, bytes:", ai.data.length);
  });

  it("Optional sanity: single buy while in Curve", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const stBefore = await fetchState();
    console.log("phase before sanity buy:", phaseName(Number(stBefore.state)));
    if (Number(stBefore.state) !== PHASE.Curve) {
      console.log("Skipping sanity buy because phase is not Curve.");
      return;
    }

    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 5);

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

    console.log("buy tx:", buyTx);
    console.log(
      "spent SOL:",
      ((buyerSolBefore - buyerSolAfter) / LAMPORTS).toFixed(6)
    );
    console.log("got tokens:", (buyerTokAfter - buyerTokBefore).toFixed(6));
    console.log("sale drained:", (remainingBefore - remainingAfter).toFixed(6));
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

    const stAfter = await fetchState();
    console.log("phase after sanity buy:", phaseName(Number(stAfter.state)));
  });

  it("Drive buys until MigrationPending", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const st0 = await fetchState();
    console.log("phase at start:", phaseName(Number(st0.state)));

    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 250);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    console.log("buyer:", buyer.publicKey.toBase58());
    console.log("buyer_ata:", buyerAta.address.toBase58());

    await buyUntilMigrationPending({
      buyer,
      buyerAta: buyerAta.address,
      startSol: 1,
      maxSolPerBuy: 50,
      maxIters: 64,
      balanceBufferSol: 0.5,
    });

    const st1 = await fetchState();
    console.log("FINAL phase:", phaseName(Number(st1.state)));
    console.log("tokens_sold:", st1.tokensSold.toString());
    console.log("sol_collected:", st1.solCollected.toString());
    console.log("lp_growth_sol:", st1.lpGrowthSol.toString());
    console.log("sale_remaining_ui:", (await saleRemainingUi()).toFixed(6));

    if (Number(st1.state) !== PHASE.MigrationPending) {
      throw new Error(
        `Expected MigrationPending, got ${phaseName(Number(st1.state))}`
      );
    }
  });

  it("Prints PDA balances after reaching MigrationPending", async () => {
    const st = await fetchState();
    console.log("phase:", phaseName(Number(st.state)));

    console.log("treasury SOL:", (await lamports(treasurySolVault)) / LAMPORTS);
    console.log("creator  SOL:", (await lamports(creatorSolVault)) / LAMPORTS);
    console.log("platform SOL:", (await lamports(platformSolVault)) / LAMPORTS);

    console.log("sale vault tokens:", await tokenUiAmount(saleVault.publicKey));
    console.log("lp   vault tokens:", await tokenUiAmount(lpVault.publicKey));
  });

  it("Migration (Pattern A): moves LP tokens + treasury SOL to core, sets Migrated", async () => {
    const stBefore = await fetchState();
    console.log("phase before migrate:", phaseName(Number(stBefore.state)));

    if (Number(stBefore.state) !== PHASE.MigrationPending) {
      throw new Error(
        `Migration requires MigrationPending. Current=${phaseName(
          Number(stBefore.state)
        )}`
      );
    }

    const tx = await program.methods
      .migrateToCore()
      .accounts({
        coreAuthority: coreAuthority.publicKey,
        launchState: launchStatePda,
        lpVault: lpVault.publicKey,
        coreLpAta,
        treasurySolVault,
        coreSolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([coreAuthority])
      .rpc();

    console.log("migrate_to_core tx:", tx);

    const stAfter = await fetchState();
    console.log("phase after migrate:", phaseName(Number(stAfter.state)));

    const coreLpBal = await tokenUiAmount(coreLpAta);
    console.log("core LP ATA token balance:", coreLpBal.toFixed(6));

    if (Number(stAfter.state) !== PHASE.Migrated) {
      throw new Error(
        `Expected Migrated, got ${phaseName(Number(stAfter.state))}`
      );
    }
  });
});
