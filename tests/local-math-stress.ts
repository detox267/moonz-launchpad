import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";

import { AapedLaunch } from "../target/types/aaped_launch";

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const PLATFORM_KEYPAIR_PATH = "/root/.config/solana/id.json";

const TOTAL_SUPPLY = new anchor.BN("1000000000000000"); // 1,000,000,000 * 1e6
const SALE_SUPPLY = new anchor.BN("820000000000000");   // 820,000,000 * 1e6
const LP_SUPPLY = new anchor.BN("180000000000000");     // 180,000,000 * 1e6

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    let subId: number | undefined;

    subId = connection.onSignature(
      signature,
      async (notif) => {
        clearTimeout(timer);

        if (subId !== undefined) {
          try {
            await connection.removeSignatureListener(subId);
          } catch {}
        }

        if (notif.err) {
          reject(new Error(`Tx failed (${signature}): ${JSON.stringify(notif.err)}`));
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
  pauseMs = 200
) {
  console.log(`${label} sig:`, signature);
  await confirmViaWs(connection, signature, "finalized");
  await sleep(pauseMs);
}

describe("aaped-launch localnet math stress", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("runs 1000 buy/sell iterations with console logs", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const platformSigner = loadKeypair(PLATFORM_KEYPAIR_PATH);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.\nExpected: ${PLATFORM_WALLET.toBase58()}\nGot: ${platformSigner.publicKey.toBase58()}`
      );
    }

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());

    // airdrop localnet SOL
    const airdrop1 = await connection.requestAirdrop(
      payer.publicKey,
      50 * LAMPORTS_PER_SOL
    );
    await confirmAndPause(connection, airdrop1, "payer airdrop");

    const airdrop2 = await connection.requestAirdrop(
      platformSigner.publicKey,
      20 * LAMPORTS_PER_SOL
    );
    await confirmAndPause(connection, airdrop2, "platform airdrop");

    // create mint
    const mint = await createMint(
      connection,
      payer,
      platformSigner.publicKey,
      platformSigner.publicKey,
      6
    );

    console.log("Mint:", mint.toBase58());

    const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const ataInfo = await connection.getAccountInfo(userAta, "confirmed");

    if (!ataInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userAta,
        payer.publicKey,
        mint
      );

      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signed = await provider.wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });

      await confirmAndPause(connection, sig, "create ATA");
    }

    // PDAs
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

    // TX0 escrow
    const escrowAmount = new anchor.BN((2 * LAMPORTS_PER_SOL).toString());

    const sig0 = await program.methods
      .depositEscrow(escrowAmount)
      .accounts({
        depositor: payer.publicKey,
        mint,
        escrowSolVault,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await confirmAndPause(connection, sig0, "TX0 depositEscrow");

    // TX1 initialize launch
    const params = {
      creator: payer.publicKey,
      platform: PLATFORM_WALLET,
      coreAuthority: payer.publicKey,

      totalSupply: TOTAL_SUPPLY,
      saleSupply: SALE_SUPPLY,
      lpSupply: LP_SUPPLY,

      feeTotalBps: 125,
      feeCreatorBps: 105,
      feePlatformBps: 20,

      name: "AAPED LOCAL",
      symbol: "AAPED",
      uri: "https://example.com/meta.json",
    };

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

    await confirmAndPause(connection, sig1, "TX1 initializeLaunch");

    // TX5 dev buy to activate curve
    const devBuySol = new anchor.BN((1 * LAMPORTS_PER_SOL).toString());

    const sig5 = await program.methods
      .devBuyStartCurve(devBuySol, new anchor.BN(0), "localcid123")
      .accounts({
        dev: payer.publicKey,
        mint,
        launchState: launchStatePda,
        saleVault: saleVaultPda,
        devAta: userAta,
        treasurySolVault,
        creatorSolVault,
        platformWallet: PLATFORM_WALLET,
        escrowSolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await confirmAndPause(connection, sig5, "TX5 devBuyStartCurve");

    console.log("=== STARTING 1000 ITERATIONS ===");

    for (let i = 1; i <= 1000; i++) {
      const launchStateBefore: any = await program.account.launchState.fetch(launchStatePda);
      const userTokenBefore = await connection.getTokenAccountBalance(userAta, "confirmed");
      const userSolBefore = await connection.getBalance(payer.publicKey, "confirmed");

      try {
        if (i % 2 === 1) {
          // BUY
          const buyLamports = new anchor.BN((0.01 * LAMPORTS_PER_SOL).toString());

          const sig = await program.methods
            .buy(buyLamports, new anchor.BN(0))
            .accounts({
              buyer: payer.publicKey,
              launchState: launchStatePda,
              saleVault: saleVaultPda,
              lpVault: lpVaultPda,
              buyerAta: userAta,
              treasurySolVault,
              creatorSolVault,
              platformWallet: PLATFORM_WALLET,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          await confirmViaWs(connection, sig, "finalized");

          const launchStateAfter: any = await program.account.launchState.fetch(launchStatePda);
          const userTokenAfter = await connection.getTokenAccountBalance(userAta, "confirmed");
          const userSolAfter = await connection.getBalance(payer.publicKey, "confirmed");

          console.log(
            `[${i}] BUY | sig=${sig} | tokensSold ${launchStateBefore.tokensSold.toString()} -> ${launchStateAfter.tokensSold.toString()} | solCollected ${launchStateBefore.solCollected.toString()} -> ${launchStateAfter.solCollected.toString()} | userToken ${userTokenBefore.value.amount} -> ${userTokenAfter.value.amount} | userSol ${userSolBefore} -> ${userSolAfter}`
          );
        } else {
          // SELL a small chunk if balance exists
          const rawBal = BigInt(userTokenBefore.value.amount);

          if (rawBal > 1000n) {
            const sellAmount = rawBal > 1000000n ? new anchor.BN("1000000") : new anchor.BN(rawBal.toString());

            const sig = await program.methods
              .sell(sellAmount, new anchor.BN(0))
              .accounts({
                seller: payer.publicKey,
                launchState: launchStatePda,
                saleVault: saleVaultPda,
                sellerAta: userAta,
                treasurySolVault,
                creatorSolVault,
                platformWallet: PLATFORM_WALLET,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              })
              .rpc();

            await confirmViaWs(connection, sig, "finalized");

            const launchStateAfter: any = await program.account.launchState.fetch(launchStatePda);
            const userTokenAfter = await connection.getTokenAccountBalance(userAta, "confirmed");
            const userSolAfter = await connection.getBalance(payer.publicKey, "confirmed");

            console.log(
              `[${i}] SELL | sig=${sig} | tokensSold ${launchStateBefore.tokensSold.toString()} -> ${launchStateAfter.tokensSold.toString()} | solCollected ${launchStateBefore.solCollected.toString()} -> ${launchStateAfter.solCollected.toString()} | userToken ${userTokenBefore.value.amount} -> ${userTokenAfter.value.amount} | userSol ${userSolBefore} -> ${userSolAfter}`
            );
          } else {
            console.log(`[${i}] SELL SKIPPED | token balance too low: ${userTokenBefore.value.amount}`);
          }
        }
      } catch (err: any) {
        console.log(`[${i}] ERROR | ${err.message || err.toString()}`);
      }
    }

    const finalState: any = await program.account.launchState.fetch(launchStatePda);
    console.log("=== FINAL STATE ===");
    console.log("state:", finalState.state);
    console.log("tokensSold:", finalState.tokensSold.toString());
    console.log("solCollected:", finalState.solCollected.toString());

    console.log("✅ 1000-iteration math stress test complete");
  });
});
