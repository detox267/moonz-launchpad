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

let coreAuthority: Keypair;
let coreLpAta: PublicKey;
let coreSolVault: PublicKey;

describe("aaped-launch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

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
    if (phase === PHASE.MigrationPending) return "MigrationPending";
    if (phase === PHASE.Migrated) return "Migrated";
    return `Unknown(${phase})`;
  }

  it("Initializes launch state (Pattern A core authority stored)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    coreAuthority = Keypair.generate();

    // fund core authority (for ATA rent etc)
    const fundCore = await provider.connection.requestAirdrop(
      coreAuthority.publicKey,
      2 * LAMPORTS
    );
    await provider.connection.confirmTransaction(fundCore);

    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

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

    [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    // Core LP ATA (destination for 400M tokens)
    const coreAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      coreAuthority,
      mint,
      coreAuthority.publicKey
    );
    coreLpAta = coreAta.address;

    // Core SOL vault: simplest = core authority wallet itself
    coreSolVault = coreAuthority.publicKey;

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      coreAuthority: coreAuthority.publicKey, // ✅ Pattern A

      totalSupply: new anchor.BN("1000000000000000"), // 1B * 1e6
      saleSupply: new anchor.BN("600000000000000"),   // 600M * 1e6
      lpSupply: new anchor.BN("400000000000000"),     // 400M * 1e6

      vSol: new anchor.BN("75800000000"),             // 75.8 SOL lamports
      vTok: new anchor.BN("526200000000000"),         // 526.2M * 1e6

      migrationSolTarget: new anchor.BN((91 * LAMPORTS).toString()),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,

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

    console.log("initializeLaunch tx:", tx);

    const st = await fetchState();
    console.log("Initial phase:", phaseName(st.state));
    console.log("core_authority:", st.coreAuthority.toBase58());
  });

  it("Simulates a single buy (with vault deltas)", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const buyer = Keypair.generate();

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

    console.log("buy tx:", buyTx);
    console.log("spent SOL:", ((buyerSolBefore - buyerSolAfter) / LAMPORTS).toFixed(6));
    console.log("got tokens:", (buyerTokAfter - buyerTokBefore).toFixed(6));
    console.log("sale drained:", (remainingBefore - remainingAfter).toFixed(6));
    console.log("treasury +SOL:", ((treasuryAfter - treasuryBefore) / LAMPORTS).toFixed(6));
    console.log("creator  +SOL:", ((creatorAfter - creatorBefore) / LAMPORTS).toFixed(6));
    console.log("platform +SOL:", ((platformAfter - platformBefore) / LAMPORTS).toFixed(6));

    const st = await fetchState();
    console.log("Phase after buy:", phaseName(st.state));
  });

  it("Migration (Pattern A): moves LP tokens + treasury SOL to core, sets Migrated", async () => {
    // ⚠️ In a real run you’d drive buys until sale_vault drains and state flips.
    // For now, this test assumes you already reached MigrationPending in prior steps.

    const stBefore = await fetchState();
    console.log("phase before migrate:", phaseName(stBefore.state));

    // call migrate
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
    console.log("phase after migrate:", phaseName(stAfter.state));

    // quick sanity prints
    const coreLpBal = await tokenUiAmount(coreLpAta);
    console.log("core LP ATA token balance:", coreLpBal.toFixed(6));
  });
});
