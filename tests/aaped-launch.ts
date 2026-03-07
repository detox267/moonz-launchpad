import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getMint,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import assert from "assert";
import * as fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

async function ensureAta(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  owner: PublicKey,
  payer: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await provider.connection.getAccountInfo(ata);

  if (!info) {
    const ix = createAssociatedTokenAccountInstruction(
      payer,
      ata,
      owner,
      mint
    );

    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, []);
  }

  return ata;
}

describe("aaped-launch full local flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;
  const connection = provider.connection;

  it("runs full launch, dev buy, curve buy, migration, amm trade, fee claim, escrow settle", async () => {
    const user = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    assert.ok(
      platformSigner.publicKey.equals(PLATFORM_WALLET),
      `Platform signer mismatch. Expected ${PLATFORM_WALLET.toBase58()} got ${platformSigner.publicKey.toBase58()}`
    );

    console.log("Program:", program.programId.toBase58());
    console.log("User:", user.publicKey.toBase58());
    console.log("Platform:", platformSigner.publicKey.toBase58());

    // --------------------------------------------------
    // Create mint
    // --------------------------------------------------
    const mint = await createMint(
      connection,
      user,
      platformSigner.publicKey,
      platformSigner.publicKey,
      6
    );

    console.log("Mint:", mint.toBase58());

    // --------------------------------------------------
    // PDAs
    // --------------------------------------------------
    const [launchStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), mint.toBuffer()],
      program.programId
    );

    const [saleVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sale_vault"), mint.toBuffer()],
      program.programId
    );

    const [lpVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault"), mint.toBuffer()],
      program.programId
    );

    const [treasurySolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_sol"), mint.toBuffer()],
      program.programId
    );

    const [creatorSolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_sol"), mint.toBuffer()],
      program.programId
    );

    const [escrowSolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_sol"), mint.toBuffer()],
      program.programId
    );

    const [metadataPda, metadataBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      MPL_PROGRAM_ID
    );

    // --------------------------------------------------
    // ATAs
    // --------------------------------------------------
    const userAta = await ensureAta(
      provider,
      mint,
      user.publicKey,
      user.publicKey
    );

    // --------------------------------------------------
    // TX0 - deposit escrow first
    // initialize_launch now requires escrow already exists and funded
    // --------------------------------------------------
    const escrowDeposit = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .depositEscrow(escrowDeposit)
      .accounts({
        depositor: user.publicKey,
        mint,
        escrowSolVault: escrowSolVaultPda,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("deposit_escrow complete");

    // --------------------------------------------------
    // TX1 - initialize launch
    // Hard-locked tokenomics in program:
    // total 1,000,000,000
    // sale 700,000,000
    // lp    300,000,000
    // with 6 decimals
    // --------------------------------------------------
    const params = {
      creator: user.publicKey,
      platform: PLATFORM_WALLET,
      coreAuthority: user.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("700000000000000"),
      lpSupply: new anchor.BN("300000000000000"),

      feeTotalBps: 125,
      feeCreatorBps: 105,
      feePlatformBps: 20,

      name: "AAPED TEST",
      symbol: "AAPED",
      uri: "https://example.com/meta.json",
    };

    await program.methods
      .initializeLaunch(params as any)
      .accounts({
        platformSigner: platformSigner.publicKey,
        mintAuthority: platformSigner.publicKey,
        mint,
        launchState: launchStatePda,
        saleVault: saleVaultPda,
        lpVault: lpVaultPda,
        treasurySolVault: treasurySolVaultPda,
        creatorSolVault: creatorSolVaultPda,
        escrowSolVault: escrowSolVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([platformSigner])
      .rpc();

    console.log("initialize_launch complete");

    // --------------------------------------------------
    // TX2 - initialize metadata
    // --------------------------------------------------
    await program.methods
      .initializeMetadata(metadataBump, {
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
      })
      .accounts({
        payer: user.publicKey,
        mintAuthority: platformSigner.publicKey,
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([platformSigner])
      .rpc();

    console.log("initialize_metadata complete");

    // --------------------------------------------------
    // TX3 - finalize mint authorities
    // --------------------------------------------------
    await program.methods
      .finalizeMintAuthorities(metadataBump)
      .accounts({
        mintAuthority: platformSigner.publicKey,
        mint,
        launchState: launchStatePda,
        metadata: metadataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([platformSigner])
      .rpc();

    console.log("finalize_mint_authorities complete");

    const mintInfo = await getMint(connection, mint);
    assert.equal(mintInfo.mintAuthority, null, "mint authority not revoked");
    assert.equal(mintInfo.freezeAuthority, null, "freeze authority not revoked");

    // --------------------------------------------------
    // Check launch state + vault balances
    // --------------------------------------------------
    let launchState = await program.account.launchState.fetch(launchStatePda);
    let saleVault = await getAccount(connection, saleVaultPda);
    let lpVault = await getAccount(connection, lpVaultPda);

    assert.equal(launchState.state, 0); // PendingDevBuy
    assert.equal(saleVault.amount.toString(), "700000000000000");
    assert.equal(lpVault.amount.toString(), "300000000000000");

    console.log("initial vault balances correct");

    // --------------------------------------------------
    // TX4 - dev buy start curve
    // NOTE: current program takes SOL from dev wallet directly
    // escrow is settled separately later
    // --------------------------------------------------
    await program.methods
      .devBuyStartCurve(
        new anchor.BN(1 * LAMPORTS_PER_SOL),
        new anchor.BN(0),
        "bafybeigdyrzt4examplecid"
      )
      .accounts({
        dev: user.publicKey,
        mint,
        launchState: launchStatePda,
        saleVault: saleVaultPda,
        devAta: userAta,
        treasurySolVault: treasurySolVaultPda,
        creatorSolVault: creatorSolVaultPda,
        platformWallet: PLATFORM_WALLET,
        escrowSolVault: escrowSolVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("dev_buy_start_curve complete");

    launchState = await program.account.launchState.fetch(launchStatePda);
    assert.equal(launchState.state, 1); // Curve
    assert.equal(launchState.devBuyDone, true);

    // --------------------------------------------------
    // normal curve buy
    // --------------------------------------------------
    await program.methods
      .buy(new anchor.BN(1 * LAMPORTS_PER_SOL), new anchor.BN(0))
      .accounts({
        buyer: user.publicKey,
        launchState: launchStatePda,
        saleVault: saleVaultPda,
        lpVault: lpVaultPda,
        buyerAta: userAta,
        treasurySolVault: treasurySolVaultPda,
        creatorSolVault: creatorSolVaultPda,
        platformWallet: PLATFORM_WALLET,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("curve buy complete");

    launchState = await program.account.launchState.fetch(launchStatePda);
    console.log("tokens_sold after buy:", launchState.tokensSold.toString());

    // --------------------------------------------------
    // Force migration by buying until sale vault is empty
    // --------------------------------------------------
    let loops = 0;
    while (true) {
      loops += 1;
      if (loops > 60) {
        throw new Error("Migration loop exceeded safety limit");
      }

      const freshState = await program.account.launchState.fetch(launchStatePda);
      if (freshState.state === 3) {
        break; // AmmLive
      }

      const freshSaleVault = await getAccount(connection, saleVaultPda);
      if (freshSaleVault.amount === BigInt(0)) {
        break;
      }

      // Use a larger buy to drain faster.
      await program.methods
        .buy(new anchor.BN(25 * LAMPORTS_PER_SOL), new anchor.BN(0))
        .accounts({
          buyer: user.publicKey,
          launchState: launchStatePda,
          saleVault: saleVaultPda,
          lpVault: lpVaultPda,
          buyerAta: userAta,
          treasurySolVault: treasurySolVaultPda,
          creatorSolVault: creatorSolVaultPda,
          platformWallet: PLATFORM_WALLET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const stateAfter = await program.account.launchState.fetch(launchStatePda);
      console.log(
        `buy loop ${loops}: state=${stateAfter.state} tokensSold=${stateAfter.tokensSold.toString()}`
      );
    }

    launchState = await program.account.launchState.fetch(launchStatePda);
    saleVault = await getAccount(connection, saleVaultPda);
    lpVault = await getAccount(connection, lpVaultPda);

    assert.equal(launchState.state, 3, "launch did not migrate to AmmLive");
    assert.equal(saleVault.amount.toString(), "0", "sale vault not empty");
    assert.ok(
      launchState.ammInitialSol.toNumber() > 0,
      "amm_initial_sol not set"
    );
    assert.ok(
      launchState.ammInitialTok.toNumber() > 0,
      "amm_initial_tok not set"
    );

    console.log("migration complete");

    // --------------------------------------------------
    // AMM buy
    // --------------------------------------------------
    await program.methods
      .ammBuy(new anchor.BN(1 * LAMPORTS_PER_SOL), new anchor.BN(0))
      .accounts({
        buyer: user.publicKey,
        launchState: launchStatePda,
        lpVault: lpVaultPda,
        buyerAta: userAta,
        treasurySolVault: treasurySolVaultPda,
        creatorSolVault: creatorSolVaultPda,
        platformWallet: PLATFORM_WALLET,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("amm_buy complete");

    // --------------------------------------------------
    // AMM sell
    // sell a small amount from user ATA
    // --------------------------------------------------
    const userTokenAccount = await getAccount(connection, userAta);
    const sellAmount = userTokenAccount.amount > BigInt(1_000_000)
      ? new anchor.BN("1000000")
      : new anchor.BN(userTokenAccount.amount.toString());

    await program.methods
      .ammSell(sellAmount, new anchor.BN(0))
      .accounts({
        seller: user.publicKey,
        launchState: launchStatePda,
        lpVault: lpVaultPda,
        sellerAta: userAta,
        treasurySolVault: treasurySolVaultPda,
        creatorSolVault: creatorSolVaultPda,
        platformWallet: PLATFORM_WALLET,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("amm_sell complete");

    // --------------------------------------------------
    // claim creator fees
    // --------------------------------------------------
    await program.methods
      .claimFees()
      .accounts({
        launchState: launchStatePda,
        creatorSolVault: creatorSolVaultPda,
        creatorReceiver: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("claim_fees complete");

    // --------------------------------------------------
    // settle escrow to platform
    // --------------------------------------------------
    await program.methods
      .settleEscrowToPlatform()
      .accounts({
        platformSigner: platformSigner.publicKey,
        mint,
        launchState: launchStatePda,
        platformReceiver: PLATFORM_WALLET,
        escrowSolVault: escrowSolVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([platformSigner])
      .rpc();

    console.log("settle_escrow_to_platform complete");

    launchState = await program.account.launchState.fetch(launchStatePda);
    assert.equal(
      launchState.escrowSettled,
      true,
      "escrow_settled flag not updated"
    );

    console.log("✅ FULL TEST PASSED");
  });
});
