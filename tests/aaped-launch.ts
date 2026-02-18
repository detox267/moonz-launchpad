// tests/aaped-launch.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

// ---- IMPORTANT: point tests at devnet + deployed program id ----
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYED_PROGRAM_ID = new PublicKey(
  "Af8ezmaLxSVm84A9USKQxp57n6bHxgMYctfuUX7Z8XpC"
);

const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PHASE = {
  Curve: 0,
  MigrationPending: 1,
  Migrated: 2,
} as const;

// globals shared across tests
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

describe("aaped-launch (fees + metadata) — devnet deployed", () => {
  // Build a provider explicitly using devnet RPC (not whatever Anchor env had)
  const wallet = anchor.Wallet.local(); // uses ~/.config/solana/id.json
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load local IDL but force program id to deployed address
  // (IDL path is created by anchor build/test)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../target/idl/aaped_launch.json");
  const program = new Program(idl, DEPLOYED_PROGRAM_ID, provider) as Program;

  // ---------- helpers ----------
  async function fund(pubkey: PublicKey, sol: number) {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const lamports = Math.floor(sol * LAMPORTS);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pubkey,
        lamports,
      })
    );

    const sig = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
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

  async function fetchState() {
    if (!launchStatePda) throw new Error("launchStatePda not set (init failed?)");
    return await (program as any).account.launchState.fetch(launchStatePda);
  }

  function phaseName(phase: number): string {
    if (phase === PHASE.Curve) return "Curve";
    if (phase === PHASE.MigrationPending) return "MigrationPending";
    if (phase === PHASE.Migrated) return "Migrated";
    return `Unknown(${phase})`;
  }

  async function buyOnce(buyer: Keypair, buyerAta: PublicKey, solLamports: bigint) {
    return await (program as any).methods
      .buy(new anchor.BN(solLamports.toString()))
      .accountsStrict({
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

  // ---------- tests ----------
  it("Init (Pattern A): PDAs + stored metadata PDA matches derived", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const FEE_RECEIVER = new PublicKey(
      "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
    );

    coreAuthority = Keypair.generate();
    await fund(coreAuthority.publicKey, 0.5);

    // 1) Create mint (payer is mint authority initially)
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // 2) Program PDAs (must use deployed program id)
    [launchStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), mint.toBuffer()],
      DEPLOYED_PROGRAM_ID
    );

    [treasurySolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_sol"), mint.toBuffer()],
      DEPLOYED_PROGRAM_ID
    );

    [creatorSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_sol"), mint.toBuffer()],
      DEPLOYED_PROGRAM_ID
    );

    [platformSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform_sol"), mint.toBuffer()],
      DEPLOYED_PROGRAM_ID
    );

    // 3) Metaplex metadata PDA (derived off Metaplex program id)
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

    // Core SOL vault for migration (Pattern A uses a normal wallet here)
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

    const initTx = await (program as any).methods
      .initializeLaunch(params)
      .accountsStrict({
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
    console.log("metadata PDA:", metadataPda.toBase58());

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(`Expected Curve after init, got ${phaseName(Number(st0.state))}`);
    }

    // stored metadata PDA must match derived
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

    const tx = await (program as any).methods
      .initializeMetadata(metaParams)
      .accountsStrict({
        payer: payer.publicKey,
        mintAuthority: payer.publicKey, // must still have mint authority at this point
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("initializeMetadata tx:", tx);

    const ai = await provider.connection.getAccountInfo(metadataPda);
    if (!ai) throw new Error("Metadata PDA account was not created.");
    if (!ai.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
      throw new Error(
        `Metadata PDA owner mismatch. owner=${ai.owner.toBase58()} expected=${MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()}`
      );
    }
    console.log("metadata account exists, bytes:", ai.data.length);
  });

  it("Fee claim: 1 buy + 1 sell + claim_fees sweeps vaults (leaves rent-min)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const FEE_RECEIVER = new PublicKey(
      "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
    );

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    if (Number(st0.state) !== PHASE.Curve) throw new Error("State not Curve");

    // buyer funded from payer (avoid airdrop flake)
    const buyer = Keypair.generate();
    await fund(buyer.publicKey, 2);

    const buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      buyer.publicKey
    );

    const recvBefore = await lamports(FEE_RECEIVER);
    const creatorVaultBefore = await lamports(creatorSolVault);
    const platformVaultBefore = await lamports(platformSolVault);

    console.log("---- BEFORE ----");
    console.log("receiver lamports:", recvBefore);
    console.log("creator vault lamports:", creatorVaultBefore);
    console.log("platform vault lamports:", platformVaultBefore);

    // BUY 1 SOL
    const buyTx = await buyOnce(buyer, buyerAta.address, BigInt(1 * LAMPORTS));
    console.log("buy tx:", buyTx);

    // SELL 25% of buyer tokens
    const tokBal = await tokenBaseAmount(buyerAta.address);
    if (tokBal <= 0n) throw new Error("Buyer received zero tokens from buy");
    const sellAmt = tokBal / 4n;

    const sellTx = await (program as any).methods
      .sell(new anchor.BN(sellAmt.toString()))
      .accountsStrict({
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

    const creatorVaultMid = await lamports(creatorSolVault);
    const platformVaultMid = await lamports(platformSolVault);

    console.log("---- MID (after buy+sell) ----");
    console.log("creator vault gained:", creatorVaultMid - creatorVaultBefore);
    console.log("platform vault gained:", platformVaultMid - platformVaultBefore);

    // CLAIM
    const claimTx = await (program as any).methods
      .claimFees()
      .accountsStrict({
        launchState: launchStatePda,
        creatorSolVault,
        platformSolVault,
        creatorReceiver: FEE_RECEIVER,
        platformReceiver: FEE_RECEIVER,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("claim_fees tx:", claimTx);

    const recvAfter = await lamports(FEE_RECEIVER);
    const creatorVaultAfter = await lamports(creatorSolVault);
    const platformVaultAfter = await lamports(platformSolVault);

    const rentMin0 = await provider.connection.getMinimumBalanceForRentExemption(0);

    console.log("---- AFTER CLAIM ----");
    console.log("receiver delta:", recvAfter - recvBefore);
    console.log("creator vault final:", creatorVaultAfter, "rentMin0:", rentMin0);
    console.log("platform vault final:", platformVaultAfter, "rentMin0:", rentMin0);

    // Soft assertions: vaults should be reduced near rent-minimum if you implemented rent-min sweep
    if (creatorVaultAfter > creatorVaultMid) throw new Error("creator vault did not decrease");
    if (platformVaultAfter > platformVaultMid) throw new Error("platform vault did not decrease");

    if (creatorVaultAfter < rentMin0) {
      throw new Error("creator vault fell below rent-min (should not happen if sweeping leaves rent)");
    }
    if (platformVaultAfter < rentMin0) {
      throw new Error("platform vault fell below rent-min (should not happen if sweeping leaves rent)");
    }
  });
});
