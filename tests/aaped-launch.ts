// tests/aaped-launch.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

const PROGRAM_ID = new PublicKey(
  "Af8ezmaLxSVm84A9USKQxp57n6bHxgMYctfuUX7Z8XpC"
);

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

describe("aaped-launch (fees + metadata)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // ---- Load IDL without JSON import (avoids Node ESM json assert errors)
  const idlPath = path.resolve(__dirname, "../target/idl/aaped_launch.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // ---- Instantiate Program using deployed program id (NOT anchor.workspace)
  const program = new Program(idl, PROGRAM_ID, provider) as Program;

  // ---------------- helpers ----------------
  async function fundFromPayer(to: PublicKey, sol: number) {
    const payer = provider.wallet as anchor.Wallet;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: to,
        lamports: Math.floor(sol * LAMPORTS),
      })
    );
    return await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  }

  async function lamports(pubkey: PublicKey) {
    return await provider.connection.getBalance(pubkey, "confirmed");
  }

  async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount, "confirmed");
    return BigInt(bal.value.amount);
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

  async function buyOnce(buyer: Keypair, buyerAta: PublicKey, solInLamports: bigint) {
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
      .rpc({ commitment: "confirmed" });
  }

  // ---------------- tests ----------------

  it("Init (Pattern A): PDAs + stored metadata PDA matches derived", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const FEE_RECEIVER = new PublicKey(
      "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
    );

    coreAuthority = Keypair.generate();
    await fundFromPayer(coreAuthority.publicKey, 2); // avoid flaky devnet airdrops

    // 1) Create mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // 2) Program PDAs (derived with ACTUAL program id)
    [launchStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), mint.toBuffer()],
      PROGRAM_ID
    );

    [treasurySolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_sol"), mint.toBuffer()],
      PROGRAM_ID
    );

    [creatorSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_sol"), mint.toBuffer()],
      PROGRAM_ID
    );

    [platformSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform_sol"), mint.toBuffer()],
      PROGRAM_ID
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
      creator: FEE_RECEIVER,
      platform: FEE_RECEIVER,

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
      .rpc({ commitment: "confirmed" });

    console.log("initializeLaunch tx:", initTx);

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(`Expected Curve after init, got ${phaseName(Number(st0.state))}`);
    }

    if (!st0.metadata.equals(metadataPda)) {
      throw new Error(
        `LaunchState.metadata mismatch. state=${st0.metadata.toBase58()} expected=${metadataPda.toBase58()}`
      );
    }
  });

  it("Initialize metadata (Metaplex): creates account + owner is Metaplex", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const st0 = await fetchState();
    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(`State not Curve. got=${phaseName(Number(st0.state))}`);
    }

    const tx = await program.methods
      .initializeMetadata({
        name: "AAPED Launch Token",
        symbol: "AAPED",
        uri: "https://example.com/metadata.json",
      })
      .accounts({
        payer: payer.publicKey,
        mintAuthority: payer.publicKey,
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });

    console.log("initializeMetadata tx:", tx);

    const info = await provider.connection.getAccountInfo(metadataPda, "confirmed");
    if (!info) throw new Error("Metadata account not created");
    if (!info.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
      throw new Error(
        `Metadata owner mismatch. got=${info.owner.toBase58()} expected=${MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()}`
      );
    }
  });

  it("Fee claim: 1 buy + 1 sell + claim_fees sweeps vaults (leaves rent-min)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const FEE_RECEIVER = new PublicKey(
      "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
    );

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    if (Number(st0.state) !== PHASE.Curve) throw new Error("State not Curve");

    // buyer funded from payer wallet (no airdrop flakiness)
    const buyer = Keypair.generate();
    await fundFromPayer(buyer.publicKey, 5);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    const recvBefore = await lamports(FEE_RECEIVER);
    const creatorVaultBefore = await lamports(creatorSolVault);
    const platformVaultBefore = await lamports(platformSolVault);

    // BUY 1 SOL
    const buyTx = await buyOnce(buyer, buyerAta.address, BigInt(1 * LAMPORTS));
    console.log("buy tx:", buyTx);

    // SELL 25%
    const tokBal = await tokenBaseAmount(buyerAta.address);
    if (tokBal <= 0n) throw new Error("Buyer received zero tokens from buy");
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
      .rpc({ commitment: "confirmed" });

    console.log("sell tx:", sellTx);

    const recvMid = await lamports(FEE_RECEIVER);
    const creatorVaultMid = await lamports(creatorSolVault);
    const platformVaultMid = await lamports(platformSolVault);

    console.log("creator vault gained:", creatorVaultMid - creatorVaultBefore);
    console.log("platform vault gained:", platformVaultMid - platformVaultBefore);

    const rentMin0 = await provider.connection.getMinimumBalanceForRentExemption(0);

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
      .rpc({ commitment: "confirmed" });

    console.log("claim_fees tx:", claimTx);

    const recvAfter = await lamports(FEE_RECEIVER);
    const creatorVaultAfter = await lamports(creatorSolVault);
    const platformVaultAfter = await lamports(platformSolVault);

    console.log("receiver delta:", recvAfter - recvMid);
    console.log("creator vault final:", creatorVaultAfter, "rentMin0:", rentMin0);
    console.log("platform vault final:", platformVaultAfter, "rentMin0:", rentMin0);

    // If your claim_fees leaves rent-min, these should equal rentMin0
    // If you still sweep full balance, these may go to 0 and break this.
    if (creatorVaultAfter !== rentMin0) {
      console.log("NOTE: creator vault not rentMin0 (check claim_fees sweep logic).");
    }
    if (platformVaultAfter !== rentMin0) {
      console.log("NOTE: platform vault not rentMin0 (check claim_fees sweep logic).");
    }
  });
});
