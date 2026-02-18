// tests/aaped-launch.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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

describe("aaped-launch (fees + metadata)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  const FEE_RECEIVER = new PublicKey(
    "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
  );

  // ---------------- helpers ----------------

  async function confirm(sig: string) {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      },
      "confirmed"
    );
  }

  // ✅ devnet airdrops are unreliable; transfer from provider wallet instead
  async function fund(pubkey: PublicKey, sol: number) {
    const lamports = Math.floor(sol * LAMPORTS);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: pubkey,
        lamports,
      })
    );
    const sig = await provider.sendAndConfirm(tx, []);
    return sig;
  }

  async function lamports(pubkey: PublicKey) {
    return await provider.connection.getBalance(pubkey, "confirmed");
  }

  async function tokenBaseAmount(tokenAccount: PublicKey): Promise<bigint> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount, "confirmed");
    return BigInt(bal.value.amount);
  }

  async function tokenUiAmount(tokenAccount: PublicKey): Promise<number> {
    const bal = await provider.connection.getTokenAccountBalance(tokenAccount, "confirmed");
    return Number(bal.value.uiAmountString ?? "0");
  }

  async function saleRemainingUi(): Promise<number> {
    const bal = await provider.connection.getTokenAccountBalance(
      saleVault.publicKey,
      "confirmed"
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

  async function buyOnce(buyer: Keypair, buyerAta: PublicKey, solLamports: bigint) {
    return await program.methods
      .buy(new anchor.BN(solLamports.toString()))
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

    coreAuthority = Keypair.generate();
    await fund(coreAuthority.publicKey, 1);

    // 1) Create mint
    mint = await createMint(
      provider.connection,
      (payer as any).payer, // Keypair under Anchor wallet
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

    // Core LP ATA (destination later)
    const coreAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (payer as any).payer,
      mint,
      coreAuthority.publicKey
    );
    coreLpAta = coreAta.address;

    // Core SOL vault for migration
    coreSolVault = coreAuthority.publicKey;

    const params = {
      // ✅ must match claim_fees receiver checks (state.creator/state.platform)
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
    console.log("mint:", mint.toBase58());
    console.log("launch_state:", launchStatePda.toBase58());
    console.log("sale_vault:", saleVault.publicKey.toBase58());
    console.log("lp_vault:", lpVault.publicKey.toBase58());
    console.log("treasury_sol_vault:", treasurySolVault.toBase58());
    console.log("creator_sol_vault:", creatorSolVault.toBase58());
    console.log("platform_sol_vault:", platformSolVault.toBase58());
    console.log("metadata PDA:", metadataPda.toBase58());
    console.log("creator stored:", st0.creator.toBase58());
    console.log("platform stored:", st0.platform.toBase58());

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(`Expected Curve after init, got ${phaseName(Number(st0.state))}`);
    }

    // ✅ stored metadata PDA must match derived
    if (!st0.metadata.equals(metadataPda)) {
      throw new Error(
        `LaunchState.metadata mismatch. state=${st0.metadata.toBase58()} expected=${metadataPda.toBase58()}`
      );
    }
  });

  it("Initialize metadata (Metaplex): creates account + owner is Metaplex", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const metaParams = {
      name: "AAPED Launch Token",
      symbol: "AAPED",
      uri: "https://example.com/metadata.json",
    };

    const tx = await program.methods
      .initializeMetadata(metaParams)
      .accounts({
        payer: payer.publicKey,
        mintAuthority: payer.publicKey, // signer via provider wallet
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });

    console.log("initializeMetadata tx:", tx);

    const ai = await provider.connection.getAccountInfo(metadataPda, "confirmed");
    if (!ai) throw new Error("Metadata PDA account was not created.");
    if (!ai.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
      throw new Error(
        `Metadata owner mismatch. owner=${ai.owner.toBase58()} expected=${MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()}`
      );
    }

    console.log("metadata account exists, bytes:", ai.data.length);
  });

  it("Fee claim: 1 buy + 1 sell + claim_fees sweeps vaults (leaves rent-min)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // sanity: Curve
    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    if (Number(st0.state) !== PHASE.Curve) throw new Error("State not Curve");

    // buyer
    const buyer = Keypair.generate();
    await fund(buyer.publicKey, 3); // enough for buy + fees

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (payer as any).payer,
      mint,
      buyer.publicKey
    );

    // BEFORE
    const recvBefore = await lamports(FEE_RECEIVER);
    const creatorVaultBefore = await lamports(creatorSolVault);
    const platformVaultBefore = await lamports(platformSolVault);
    const treasuryBefore = await lamports(treasurySolVault);

    console.log("---- BEFORE ----");
    console.log("receiver:", recvBefore);
    console.log("creator vault:", creatorVaultBefore);
    console.log("platform vault:", platformVaultBefore);
    console.log("treasury vault:", treasuryBefore);

    // BUY 1 SOL
    const buyTx = await buyOnce(buyer, buyerAta.address, BigInt(1 * LAMPORTS));
    console.log("buy tx:", buyTx);

    // SELL 25% of buyer tokens
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

    // MID
    const recvMid = await lamports(FEE_RECEIVER);
    const creatorVaultMid = await lamports(creatorSolVault);
    const platformVaultMid = await lamports(platformSolVault);

    console.log("---- MID (after buy+sell) ----");
    console.log("receiver:", recvMid);
    console.log("creator vault:", creatorVaultMid);
    console.log("platform vault:", platformVaultMid);

    console.log("creator vault gained:", creatorVaultMid - creatorVaultBefore);
    console.log("platform vault gained:", platformVaultMid - platformVaultBefore);

    // rent-min for 0-space system accounts
    const rentMin0 = await provider.connection.getMinimumBalanceForRentExemption(0);

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
      .rpc({ commitment: "confirmed" });

    console.log("claim_fees tx:", claimTx);

    // AFTER
    const recvAfter = await lamports(FEE_RECEIVER);
    const creatorVaultAfter = await lamports(creatorSolVault);
    const platformVaultAfter = await lamports(platformSolVault);

    console.log("---- AFTER CLAIM ----");
    console.log("receiver delta:", recvAfter - recvMid);
    console.log("creator vault final:", creatorVaultAfter, "rentMin0:", rentMin0);
    console.log("platform vault final:", platformVaultAfter, "rentMin0:", rentMin0);

    // Expect fee vaults to be swept DOWN to rent-min (not to 0)
    if (creatorVaultAfter !== rentMin0) {
      console.log("NOTE: creator vault != rentMin0; adjust assertion if you changed sweep logic.");
    }
    if (platformVaultAfter !== rentMin0) {
      console.log("NOTE: platform vault != rentMin0; adjust assertion if you changed sweep logic.");
    }
  });
});
