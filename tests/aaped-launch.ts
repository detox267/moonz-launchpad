// tests/aaped-launch.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

// ✅ JSON import (NO require). Ensure tsconfig has "resolveJsonModule": true
import idl from "../target/idl/aaped_launch.json";

const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

// Deployed program on devnet
const PROGRAM_ID = new PublicKey(
  "Af8ezmaLxSVm84A9USKQxp57n6bHxgMYctfuUX7Z8XpC"
);

// Metaplex Token Metadata program
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

// Pattern A (still initialized, but we won't migrate in this suite)
let coreAuthority: Keypair;
let coreLpAta: PublicKey;
let coreSolVault: PublicKey;

describe("aaped-launch (fees + metadata) — devnet / skip-deploy", () => {
  // Force devnet connection (do NOT rely on whatever AnchorProvider.env() picks up)
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });

  // Use Anchor's wallet from env
  const wallet = anchor.Wallet.local();

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Build Program from IDL + deployed program id
  const program = new Program(idl as Idl, PROGRAM_ID, provider);

  // ---------------- helpers ----------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function airdrop(pubkey: PublicKey, sol: number) {
    // devnet airdrop can intermittently fail -> retry
    for (let i = 1; i <= 6; i++) {
      try {
        const sig = await provider.connection.requestAirdrop(
          pubkey,
          Math.floor(sol * LAMPORTS)
        );
        const bh = await provider.connection.getLatestBlockhash("confirmed");
        await provider.connection.confirmTransaction(
          {
            signature: sig,
            blockhash: bh.blockhash,
            lastValidBlockHeight: bh.lastValidBlockHeight,
          },
          "confirmed"
        );
        return sig;
      } catch (e) {
        if (i === 6) throw e;
        await sleep(800 * i);
      }
    }
    throw new Error("airdrop failed after retries");
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

  async function fetchState() {
    // Anchor account fetch using program
    return await (program.account as any).launchState.fetch(launchStatePda);
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
    await airdrop(coreAuthority.publicKey, 2);

    // Create mint (payer is mint authority initially)
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // PDAs
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

    // Metaplex metadata PDA (derived under Metaplex program)
    [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    // Vault token accounts (Anchor init)
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
    console.log("mint:", mint.toBase58());
    console.log("launch_state:", launchStatePda.toBase58());
    console.log("treasury_sol_vault:", treasurySolVault.toBase58());
    console.log("creator_sol_vault:", creatorSolVault.toBase58());
    console.log("platform_sol_vault:", platformSolVault.toBase58());
    console.log("metadata PDA:", metadataPda.toBase58());

    if (Number(st0.state) !== PHASE.Curve) {
      throw new Error(`Expected Curve after init, got ${phaseName(Number(st0.state))}`);
    }

    // ✅ metadata PDA stored in LaunchState must match derived PDA
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

    const ai = await provider.connection.getAccountInfo(metadataPda, "confirmed");
    if (!ai) throw new Error("Metadata PDA account was not created.");
    if (!ai.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
      throw new Error(
        `Metadata PDA owner mismatch. owner=${ai.owner.toBase58()} expected=${MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()}`
      );
    }

    console.log("metadata account exists, bytes:", ai.data.length);
  });

  it("Fee claim: 1 buy + 1 sell + claim_fees sweeps vaults", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const FEE_RECEIVER = new PublicKey(
      "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
    );

    const st0 = await fetchState();
    console.log("phase:", phaseName(Number(st0.state)));
    if (Number(st0.state) !== PHASE.Curve) throw new Error("State not Curve");

    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 5);

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

    const recvAfter = await lamports(FEE_RECEIVER);
    const creatorVaultAfter = await lamports(creatorSolVault);
    const platformVaultAfter = await lamports(platformSolVault);

    console.log("receiver delta:", recvAfter - recvMid);
    console.log("creator vault delta:", creatorVaultAfter - creatorVaultMid);
    console.log("platform vault delta:", platformVaultAfter - platformVaultMid);

    // If your claim_fees leaves rent-min, vault should end around rentMin0.
    // If it sweeps everything, vault could go to 0 (not rent-exempt anymore).
    const rentMin0 = await provider.connection.getMinimumBalanceForRentExemption(0);

    console.log("creator vault final:", creatorVaultAfter, "rentMin0:", rentMin0);
    console.log("platform vault final:", platformVaultAfter, "rentMin0:", rentMin0);

    if (recvAfter <= recvBefore) {
      throw new Error("Fee receiver did not increase. Fees were not claimable.");
    }

    // Soft assertion: should be <= rentMin0 + small dust
    const dust = 10_000; // lamports
    if (creatorVaultAfter > rentMin0 + dust) {
      throw new Error("Creator vault not swept down (too high after claim).");
    }
    if (platformVaultAfter > rentMin0 + dust) {
      throw new Error("Platform vault not swept down (too high after claim).");
    }
  });
});
