import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import * as fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---------------- CONFIG ----------------
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

const WS_URL = RPC_URL.replace("https://", "wss://");

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

// hard-locked program tokenomics
const TOTAL_SUPPLY = new anchor.BN("1000000000000000"); // 1,000,000,000 * 1e6
const SALE_SUPPLY = new anchor.BN("700000000000000");   // 700,000,000 * 1e6
const LP_SUPPLY = new anchor.BN("300000000000000");     // 300,000,000 * 1e6

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Websocket confirmation helper
 */
async function confirmViaWs(
  connection: anchor.web3.Connection,
  signature: string,
  commitment: Commitment = "finalized",
  timeoutMs = 60000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Signature confirmation timeout: ${signature}`));
    }, timeoutMs);

    const subIdPromise = connection.onSignature(
      signature,
      async (notif) => {
        clearTimeout(timer);
        try {
          const subId = await subIdPromise;
          await connection.removeSignatureListener(subId).catch(() => {});
        } catch {
          // ignore unsubscribe noise
        }

        if (notif.err) {
          reject(
            new Error(`Tx failed (${signature}): ${JSON.stringify(notif.err)}`)
          );
        } else {
          resolve();
        }
      },
      commitment
    );
  });
}

async function confirmAndPause(
  connection: anchor.web3.Connection,
  signature: string,
  label: string,
  pauseMs = 1500
) {
  console.log(`${label} sig:`, signature);
  await confirmViaWs(connection, signature, "finalized");
  console.log(`${label} finalized`);
  await sleep(pauseMs);
}

describe("aaped-launch devnet paced full flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("runs full launch, dev buy, curve buy, migration, amm trade, fee claim, escrow settle", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.\nExpected: ${PLATFORM_WALLET.toBase58()}\nGot: ${platformSigner.publicKey.toBase58()}`
      );
    }

    console.log("RPC:", RPC_URL);
    console.log("WS:", WS_URL);
    console.log("Program:", program.programId.toBase58());
    console.log("User/Payer:", payer.publicKey.toBase58());
    console.log("Platform signer:", platformSigner.publicKey.toBase58());

    const logsSub = connection.onLogs(
      program.programId,
      (ev) => {
        console.log("\n================ PROGRAM LOGS ================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      // ============================================================
      // STEP 0: create mint
      // ============================================================
      const mint = await createMint(
        connection,
        payer,
        platformSigner.publicKey,
        platformSigner.publicKey,
        6
      );

      console.log("Mint:", mint.toBase58());
      await sleep(1500);

      // buyer/dev ATA
      const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
      const ataInfo = await connection.getAccountInfo(buyerAta, "confirmed");

      if (!ataInfo) {
        console.log("Creating buyer ATA:", buyerAta.toBase58());

        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey,
          buyerAta,
          payer.publicKey,
          mint
        );

        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;

        const latest = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = latest.blockhash;

        const signed = await provider.wallet.signTransaction(tx);
        const sigAta = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });

        await confirmAndPause(connection, sigAta, "ATA create", 1500);
      }

      // creator receiver is payer in this test
      const creatorReceiver = payer.publicKey;

      // seller for later sell/amm sell tests
      const seller = Keypair.generate();
      const sellerAirdrop = await connection.requestAirdrop(
        seller.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await confirmAndPause(connection, sellerAirdrop, "Seller airdrop", 2000);

      const sellerAta = getAssociatedTokenAddressSync(mint, seller.publicKey);
      const sellerAtaInfo = await connection.getAccountInfo(sellerAta, "confirmed");
      if (!sellerAtaInfo) {
        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey,
          sellerAta,
          seller.publicKey,
          mint
        );

        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed"))
          .blockhash;

        tx.partialSign();
        const signed = await provider.wallet.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });
        await confirmAndPause(connection, sig, "Seller ATA create", 1500);
      }

      // ============================================================
      // PDAs
      // ============================================================
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

      const [treasurySolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_sol"), mint.toBuffer()],
        program.programId
      );

      const [creatorSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_sol"), mint.toBuffer()],
        program.programId
      );

      const [escrowSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_sol"), mint.toBuffer()],
        program.programId
      );

      const [metadataPda, metadataBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        MPL_PROGRAM_ID
      );

      // ============================================================
      // init params
      // ============================================================
      const params = {
        creator: creatorReceiver,
        platform: PLATFORM_WALLET,
        coreAuthority: payer.publicKey,

        totalSupply: TOTAL_SUPPLY,
        saleSupply: SALE_SUPPLY,
        lpSupply: LP_SUPPLY,

        feeTotalBps: 125,
        feeCreatorBps: 105,
        feePlatformBps: 20,

        name: "AAPED TEST",
        symbol: "AAPED",
        uri: "https://example.com/meta.json",
      };

      // ============================================================
      // TX1 initializeLaunch
      // ============================================================
      const sig1 = await program.methods
        .initializeLaunch(params as any)
        .accounts({
          platformSigner: platformSigner.publicKey,
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVaultPda,
          lpVault: lpVaultPda,
          treasurySolVault,
          creatorSolVault,
          escrowSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner])
        .rpc();

      await confirmAndPause(connection, sig1, "TX1 initializeLaunch", 1800);

      // ============================================================
      // TX2 initializeMetadata
      // ============================================================
      const sig2 = await program.methods
        .initializeMetadata(metadataBump, {
          name: params.name,
          symbol: params.symbol,
          uri: params.uri,
        } as any)
        .accounts({
          payer: payer.publicKey,
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

      await confirmAndPause(connection, sig2, "TX2 initializeMetadata", 1800);

      // ============================================================
      // TX3 finalizeMintAuthorities
      // ============================================================
      const sig3 = await program.methods
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

      await confirmAndPause(connection, sig3, "TX3 finalizeMintAuthorities", 1800);

      await sleep(1000);
      const mintInfo = await getMint(connection, mint, "finalized");
      console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
      console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);

      if (mintInfo.mintAuthority !== null) {
        throw new Error("Mint authority NOT revoked");
      }
      if (mintInfo.freezeAuthority !== null) {
        throw new Error("Freeze authority NOT revoked");
      }

      // ============================================================
      // TX4 depositEscrow
      // ============================================================
      const escrowAmount = new anchor.BN(
        (1.2 * LAMPORTS_PER_SOL).toString()
      );

      const sig4 = await program.methods
        .depositEscrow(escrowAmount)
        .accounts({
          depositor: payer.publicKey,
          mint,
          escrowSolVault,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await confirmAndPause(connection, sig4, "TX4 depositEscrow", 1800);

      // ============================================================
      // TX5 dev buy start curve
      // ============================================================
      const devBuySol = new anchor.BN(1 * LAMPORTS_PER_SOL);

      const sig5 = await program.methods
        .devBuyStartCurve(devBuySol, new anchor.BN(0), "bafybeihashcidtest123")
        .accounts({
          dev: payer.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVaultPda,
          devAta: buyerAta,
          treasurySolVault,
          creatorSolVault,
          platformWallet: PLATFORM_WALLET,
          escrowSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await confirmAndPause(connection, sig5, "TX5 devBuyStartCurve", 2000);

      // ============================================================
      // TX6 regular curve sell from payer (optional curve sell coverage)
      // ============================================================
      const sig6 = await program.methods
        .sell(new anchor.BN("1000000"), new anchor.BN(0)) // sell 1 token
        .accounts({
          seller: payer.publicKey,
          launchState: launchStatePda,
          saleVault: saleVaultPda,
          sellerAta: buyerAta,
          treasurySolVault,
          creatorSolVault,
          platformWallet: PLATFORM_WALLET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await confirmAndPause(connection, sig6, "TX6 curve sell", 1800);

      // ============================================================
      // Buy until migration to AMM
      // ============================================================
      let state: any = await program.account.launchState.fetch(launchStatePda);
      let buyCount = 0;

      while (state.state !== 3) {
        buyCount += 1;
        console.log(`Curve buy #${buyCount} ...`);

        const sig = await program.methods
          .buy(new anchor.BN(25 * LAMPORTS_PER_SOL), new anchor.BN(0))
          .accounts({
            buyer: payer.publicKey,
            launchState: launchStatePda,
            saleVault: saleVaultPda,
            lpVault: lpVaultPda,
            buyerAta,
            treasurySolVault,
            creatorSolVault,
            platformWallet: PLATFORM_WALLET,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        await confirmAndPause(connection, sig, `Curve buy #${buyCount}`, 1800);

        await sleep(800);
        state = await program.account.launchState.fetch(launchStatePda);

        console.log(
          `state=${state.state}, tokensSold=${state.tokensSold.toString()}, solCollected=${state.solCollected.toString()}`
        );

        if (buyCount > 20) {
          throw new Error("Migration did not trigger within expected number of buys");
        }
      }

      console.log("AMM live reached");

      // ============================================================
      // transfer some tokens from payer ATA to seller ATA for AMM sell
      // ============================================================
      const payerTokenBalBefore = await connection.getTokenAccountBalance(buyerAta);
      console.log("Payer ATA balance:", payerTokenBalBefore.value.amount);

      const transferIx = await import("@solana/spl-token").then((m) =>
        m.createTransferInstruction(
          buyerAta,
          sellerAta,
          payer.publicKey,
          BigInt(5_000_000_000) // 5,000 tokens at 6 decimals
        )
      );

      const transferTx = new Transaction().add(transferIx);
      transferTx.feePayer = payer.publicKey;
      transferTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const signedTransfer = await provider.wallet.signTransaction(transferTx);
      const transferSig = await connection.sendRawTransaction(
        signedTransfer.serialize(),
        { skipPreflight: false }
      );

      await confirmAndPause(connection, transferSig, "Transfer payer->seller", 1800);

      // ============================================================
      // AMM buy
      // ============================================================
      const sigAmmBuy = await program.methods
        .ammBuy(new anchor.BN(0.5 * LAMPORTS_PER_SOL), new anchor.BN(0))
        .accounts({
          buyer: payer.publicKey,
          launchState: launchStatePda,
          lpVault: lpVaultPda,
          buyerAta,
          treasurySolVault,
          creatorSolVault,
          platformWallet: PLATFORM_WALLET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await confirmAndPause(connection, sigAmmBuy, "AMM buy", 1800);

      // ============================================================
      // AMM sell
      // ============================================================
      const sigAmmSell = await program.methods
        .ammSell(new anchor.BN("1000000000"), new anchor.BN(0)) // 1000 tokens
        .accounts({
          seller: seller.publicKey,
          launchState: launchStatePda,
          lpVault: lpVaultPda,
          sellerAta,
          treasurySolVault,
          creatorSolVault,
          platformWallet: PLATFORM_WALLET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      await confirmAndPause(connection, sigAmmSell, "AMM sell", 1800);

      // ============================================================
      // claim creator fees
      // ============================================================
      const sigClaim = await program.methods
        .claimFees()
        .accounts({
          launchState: launchStatePda,
          creatorSolVault,
          creatorReceiver,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await confirmAndPause(connection, sigClaim, "Claim fees", 1800);

      // ============================================================
      // settle escrow to platform
      // ============================================================
      const sigSettle = await program.methods
        .settleEscrowToPlatform()
        .accounts({
          platformSigner: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          platformReceiver: PLATFORM_WALLET,
          escrowSolVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([platformSigner])
        .rpc();

      await confirmAndPause(connection, sigSettle, "Settle escrow", 1800);

      // ============================================================
      // final checks
      // ============================================================
      const finalState: any = await program.account.launchState.fetch(launchStatePda);
      console.log("Final state:", finalState.state);
      console.log("escrowSettled:", finalState.escrowSettled);
      console.log("devBuyDone:", finalState.devBuyDone);
      console.log("migratedAt:", finalState.migratedAt.toString());

      console.log("✅ Full devnet flow completed");
    } finally {
      await connection.removeOnLogsListener(logsSub).catch(() => {});
    }
  });
});
