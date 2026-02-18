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

// Fixed receiver for BOTH creator + platform (per your request)
const FEE_RECEIVER = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

let mint: PublicKey;
let launchStatePda: PublicKey;
let metadataPda: PublicKey;

let saleVault: Keypair;
let lpVault: Keypair;

let treasurySolVault: PublicKey;
let creatorSolVault: PublicKey;
let platformSolVault: PublicKey;

// Pattern A (not used in this test beyond init)
let coreAuthority: Keypair;
let coreLpAta: PublicKey;
let coreSolVault: PublicKey;

describe("aaped-launch (fee claim test)", () => {
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

  // ---------------- tests ----------------

  it("Init (Pattern A) using fixed creator+platform fee receiver, prints PDAs", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // Core authority (not used in this fee test, but required by params)
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

    // 2) Program PDAs
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

    // 3) Metaplex metadata PDA
    [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    // 4) Vault token accounts (created by Anchor init)
    saleVault = Keypair.generate();
    lpVault = Keypair.generate();

    // Optional: core LP ATA just to satisfy pattern A context later if needed
    const coreAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      coreAuthority.publicKey
    );
    coreLpAta = coreAta.address;
    coreSolVault = coreAuthority.publicKey;

    const params = {
      // ✅ both fees go to same wallet (stored in state)
      creator: FEE_RECEIVER,
      platform: FEE_RECEIVER,

      coreAuthority: coreAuthority.publicKey,

      totalSupply: new anchor.BN("1000000000000000"), // 1B * 1e6
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("75800000000"),
      vTok: new anchor.BN("526200000000000"),

      migrationSolTarget: new anchor.BN((91 * LAMPORTS).toString()),

      // NOTE: your buy() currently uses fee_total_bps, fee_platform_bps, fee_lp_growth_bps
      // fee_creator_bps is stored but not used in that posted buy() snippet.
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

    console.log("initializeLaunch tx:", initTx);

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    console.log("mint:", mint.toBase58());
    console.log("launch_state:", launchStatePda.toBase58());
    console.log("sale_vault:", saleVault.publicKey.toBase58());
    console.log("lp_vault:", lpVault.publicKey.toBase58());
    console.log("treasury_sol_vault:", treasurySolVault.toBase58());
    console.log("creator_sol_vault:", creatorSolVault.toBase58());
    console.log("platform_sol_vault:", platformSolVault.toBase58());
    console.log("metadata PDA (derived):", metadataPda.toBase58());
    console.log("state.creator:", st0.creator.toBase58());
    console.log("state.platform:", st0.platform.toBase58());

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(
        `Expected Curve after init, got ${phaseName(Number(st0.state))}`
      );
    }

    // If your state stores metadata PDA, verify it matches
    if (st0.metadata && !st0.metadata.equals(metadataPda)) {
      throw new Error(
        `LaunchState.metadata mismatch. state=${st0.metadata.toBase58()} expected=${metadataPda.toBase58()}`
      );
    }
  });

  it("Fee claim: 1 buy + 1 sell + claim_fees sweeps creator/platform vaults to receiver", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // --- sanity: state should be Curve
    const st0 = await fetchState();
    console.log("phase at start:", phaseName(Number(st0.state)));
    if (Number(st0.state) !== PHASE.Curve) throw new Error("State not Curve");

    // --- buyer
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 5);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    // balances before buy
    const recvBefore = await lamports(FEE_RECEIVER);
    const creatorVaultBefore = await lamports(creatorSolVault);
    const platformVaultBefore = await lamports(platformSolVault);

    console.log("sale remaining before:", (await saleRemainingUi()).toFixed(6));

    // BUY 1 SOL
    const buyTx = await buyOnce(buyer, buyerAta.address, BigInt(1 * LAMPORTS));
    console.log("buy tx:", buyTx);

    // SELL 25% of buyer tokens (base units)
    const tokBal = await tokenBaseAmount(buyerAta.address);
    const sellAmt = tokBal / 4n;

    const sellTx = await program.methods
      .sell(new anchor.BN(sellAmt.toString()))
      .accounts({
        seller: buyer.publicKey,
        launchState: launchStatePda,
        saleVault: saleVault.publicKey,
        sellerAta: buyerAta.address,

        treasurySolVault,
        creatorSolVault,
        platformSolVault,

        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    console.log("sell tx:", sellTx);

    // balances before claim
    const recvMid = await lamports(FEE_RECEIVER);
    const creatorVaultMid = await lamports(creatorSolVault);
    const platformVaultMid = await lamports(platformSolVault);

    console.log("creator vault gained lamports:", creatorVaultMid - creatorVaultBefore);
    console.log("platform vault gained lamports:", platformVaultMid - platformVaultBefore);

    if (creatorVaultMid <= creatorVaultBefore && platformVaultMid <= platformVaultBefore) {
      throw new Error("Expected creator/platform fee vaults to increase after buy/sell.");
    }

    // CLAIM
    const claimTx = await program.methods
      .claimFees()
      .accounts({
        launchState: launchStatePda,
        creatorSolVault,
        platformSolVault,
        creatorReceiver: FEE_RECEIVER,
        platformReceiver: FEE_RECEIVER,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("claim_fees tx:", claimTx);

    // balances after claim
    const recvAfter = await lamports(FEE_RECEIVER);
    const creatorVaultAfter = await lamports(creatorSolVault);
    const platformVaultAfter = await lamports(platformSolVault);

    console.log("receiver delta:", recvAfter - recvMid);
    console.log("creator vault delta:", creatorVaultAfter - creatorVaultMid);
    console.log("platform vault delta:", platformVaultAfter - platformVaultMid);

    if (recvAfter <= recvMid) {
      throw new Error("Expected receiver balance to increase after claimFees().");
    }

    // NOTE:
    // If your on-chain claim_fees drains ALL lamports, these could become 0.
    // That is usually NOT what you want. Prefer leaving rent-minimum.
    console.log("creator vault after:", creatorVaultAfter);
    console.log("platform vault after:", platformVaultAfter);

    if (creatorVaultAfter === 0 || platformVaultAfter === 0) {
      console.log(
        "WARNING: fee vault PDA drained to 0 lamports. This can cause the account to be reclaimed, " +
          "and future transfers to it may fail. Consider leaving Rent::minimum_balance(0) in claim_fees."
      );
    }
  });
});
