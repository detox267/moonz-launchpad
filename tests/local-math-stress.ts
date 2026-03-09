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

const CURVE_BUY_LAMPORTS = new anchor.BN((15 * LAMPORTS_PER_SOL).toString());
const AMM_BUY_LAMPORTS = new anchor.BN((10 * LAMPORTS_PER_SOL).toString());

const CURVE_MAX_BUYS = 30;
const AMM_BUY_COUNT = 1000;
const AMM_SELL_COUNT = 50;
const AMM_LIVE_STATE = 3;

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtLamports(v: bigint | number | string): string {
  const n = typeof v === "bigint" ? v : BigInt(v);
  return (Number(n) / LAMPORTS_PER_SOL).toFixed(9);
}

function fmtTokensRaw(v: bigint | number | string, decimals = 6): string {
  const n = typeof v === "bigint" ? v : BigInt(v);

  let scale = 1n;
  for (let i = 0; i < decimals; i++) {
    scale *= 10n;
  }

  const abs = n < 0n ? -n : n;
  const whole = abs / scale;
  const frac = abs % scale;
  const sign = n < 0n ? "-" : "";

  return `${sign}${whole}.${frac.toString().padStart(decimals, "0")}`;
}

function bpsAmount(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10000n;
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
  pauseMs = 200
) {
  console.log(`${label} sig: ${signature}`);
  await confirmViaWs(connection, signature, "finalized");
  await sleep(pauseMs);
}

async function getTokenRaw(
  connection: anchor.web3.Connection,
  ata: PublicKey
): Promise<bigint> {
  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  return BigInt(bal.value.amount);
}

async function getLamports(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<bigint> {
  return BigInt(await connection.getBalance(pubkey, "confirmed"));
}

describe("aaped-launch localnet math stress", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("runs curve migration + amm continuation with detailed fee logs", async () => {
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
    console.log("Platform:", platformSigner.publicKey.toBase58());

    // --------------------------------------------------
    // Localnet funding
    // --------------------------------------------------
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

    // --------------------------------------------------
    // Create mint + ATA
    // --------------------------------------------------
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

    // --------------------------------------------------
    // TX0 escrow
    // --------------------------------------------------
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

    // --------------------------------------------------
    // TX1 initialize launch
    // --------------------------------------------------
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

    // --------------------------------------------------
    // TX5 dev buy activates curve
    // --------------------------------------------------
    const devBuySol = new anchor.BN((1 * LAMPORTS_PER_SOL).toString());

    const creatorBeforeDev = await getLamports(connection, creatorSolVault);
    const treasuryBeforeDev = await getLamports(connection, treasurySolVault);
    const platformBeforeDev = await getLamports(connection, PLATFORM_WALLET);
    const userTokenBeforeDev = await getTokenRaw(connection, userAta);

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

    const creatorAfterDev = await getLamports(connection, creatorSolVault);
    const treasuryAfterDev = await getLamports(connection, treasurySolVault);
    const platformAfterDev = await getLamports(connection, PLATFORM_WALLET);
    const userTokenAfterDev = await getTokenRaw(connection, userAta);

    const devGross = BigInt(devBuySol.toString());
    const devBaseFee = bpsAmount(devGross, 125n);
    const devPlatformFee = bpsAmount(devGross, 20n);
    const devCreatorFee = devBaseFee - devPlatformFee;
    const devNetToTreasury = devGross - devBaseFee;

    console.log("\n=== DEV BUY ACTIVATION ===");
    console.log(`sig=${sig5}`);
    console.log(`gross_sol_in=${fmtLamports(devGross)} SOL (${devGross})`);
    console.log(`expected_base_fee=${fmtLamports(devBaseFee)} SOL`);
    console.log(`expected_creator_fee=${fmtLamports(devCreatorFee)} SOL`);
    console.log(`expected_platform_fee=${fmtLamports(devPlatformFee)} SOL`);
    console.log(`expected_treasury_net=${fmtLamports(devNetToTreasury)} SOL`);
    console.log(`creator_delta=${fmtLamports(creatorAfterDev - creatorBeforeDev)} SOL`);
    console.log(`platform_delta=${fmtLamports(platformAfterDev - platformBeforeDev)} SOL`);
    console.log(`treasury_delta=${fmtLamports(treasuryAfterDev - treasuryBeforeDev)} SOL`);
    console.log(`user_token_delta=${fmtTokensRaw(userTokenAfterDev - userTokenBeforeDev)}`);

    // --------------------------------------------------
    // PHASE 1: curve buys until migration
    // --------------------------------------------------
    console.log("\n=== PHASE 1: CURVE BUYS UNTIL MIGRATION ===");

    let state: any = await program.account.launchState.fetch(launchStatePda);
    let curveBuyCount = 0;

    while (state.state !== AMM_LIVE_STATE) {
      curveBuyCount += 1;

      const launchStateBefore: any = await program.account.launchState.fetch(launchStatePda);
      const userTokenBefore = await connection.getTokenAccountBalance(userAta, "confirmed");
      const userSolBefore = await connection.getBalance(payer.publicKey, "confirmed");

      const creatorBefore = await getLamports(connection, creatorSolVault);
      const platformBefore = await getLamports(connection, PLATFORM_WALLET);
      const treasuryBefore = await getLamports(connection, treasurySolVault);
      const saleVaultBefore = await getTokenRaw(connection, saleVaultPda);

      const gross = BigInt(CURVE_BUY_LAMPORTS.toString());
      const baseFee = bpsAmount(gross, 125n);
      const platformFee = bpsAmount(gross, 20n);
      const creatorFee = baseFee - platformFee;
      const treasuryNet = gross - baseFee;

      const sig = await program.methods
        .buy(CURVE_BUY_LAMPORTS, new anchor.BN(0))
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
      state = launchStateAfter;

      const userTokenAfter = await connection.getTokenAccountBalance(userAta, "confirmed");
      const userSolAfter = await connection.getBalance(payer.publicKey, "confirmed");

      const creatorAfter = await getLamports(connection, creatorSolVault);
      const platformAfter = await getLamports(connection, PLATFORM_WALLET);
      const treasuryAfter = await getLamports(connection, treasurySolVault);
      const saleVaultAfter = await getTokenRaw(connection, saleVaultPda);

      console.log(`\n[CURVE BUY ${curveBuyCount}] sig=${sig}`);
      console.log(`gross_sol_in=${fmtLamports(gross)} SOL (${gross})`);
      console.log(`expected_base_fee=${fmtLamports(baseFee)} SOL`);
      console.log(`expected_creator_fee=${fmtLamports(creatorFee)} SOL`);
      console.log(`expected_platform_fee=${fmtLamports(platformFee)} SOL`);
      console.log(`expected_treasury_net=${fmtLamports(treasuryNet)} SOL`);
      console.log(`userToken ${userTokenBefore.value.amount} -> ${userTokenAfter.value.amount}`);
      console.log(`userSol ${userSolBefore} -> ${userSolAfter}`);
      console.log(`creator_delta=${fmtLamports(creatorAfter - creatorBefore)} SOL`);
      console.log(`platform_delta=${fmtLamports(platformAfter - platformBefore)} SOL`);
      console.log(`treasury_delta=${fmtLamports(treasuryAfter - treasuryBefore)} SOL`);
      console.log(`sale_vault_delta=${fmtTokensRaw(saleVaultAfter - saleVaultBefore)}`);
      console.log(
        `tokensSold ${launchStateBefore.tokensSold.toString()} -> ${launchStateAfter.tokensSold.toString()}`
      );
      console.log(
        `solCollected ${launchStateBefore.solCollected.toString()} -> ${launchStateAfter.solCollected.toString()}`
      );
      console.log(`state=${launchStateAfter.state}`);

      if (curveBuyCount >= CURVE_MAX_BUYS) {
        throw new Error(`Migration did not happen within ${CURVE_MAX_BUYS} curve buys`);
      }
    }

    console.log("\n✅ MIGRATION REACHED");
    console.log(`curve_buy_count=${curveBuyCount}`);
    console.log(`amm_initial_sol=${state.ammInitialSol.toString()}`);
    console.log(`amm_initial_tok=${state.ammInitialTok.toString()}`);

    // --------------------------------------------------
    // PHASE 2: AMM buys
    // --------------------------------------------------
    console.log("\n=== PHASE 2: AMM BUYS ===");

    for (let i = 1; i <= AMM_BUY_COUNT; i++) {
      const launchStateBefore: any = await program.account.launchState.fetch(launchStatePda);

      const userTokenBefore = await connection.getTokenAccountBalance(userAta, "confirmed");
      const userSolBefore = await connection.getBalance(payer.publicKey, "confirmed");

      const creatorBefore = await getLamports(connection, creatorSolVault);
      const platformBefore = await getLamports(connection, PLATFORM_WALLET);
      const treasuryBefore = await getLamports(connection, treasurySolVault);
      const lpVaultBefore = await getTokenRaw(connection, lpVaultPda);

      const gross = BigInt(AMM_BUY_LAMPORTS.toString());
      const lpFee = (gross * 6n) / 1000n;
      const creatorFee = (gross * 3n) / 1000n;
      const platformFee = (gross * 1n) / 1000n;
      const tradeSol = gross - lpFee - creatorFee - platformFee;
      const treasuryExpected = tradeSol + lpFee;

      const sig = await program.methods
        .ammBuy(AMM_BUY_LAMPORTS, new anchor.BN(0))
        .accounts({
          buyer: payer.publicKey,
          launchState: launchStatePda,
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

      const creatorAfter = await getLamports(connection, creatorSolVault);
      const platformAfter = await getLamports(connection, PLATFORM_WALLET);
      const treasuryAfter = await getLamports(connection, treasurySolVault);
      const lpVaultAfter = await getTokenRaw(connection, lpVaultPda);

      console.log(`\n[AMM BUY ${i}] sig=${sig}`);
      console.log(`gross_sol_in=${fmtLamports(gross)} SOL (${gross})`);
      console.log(`expected_trade_sol=${fmtLamports(tradeSol)} SOL`);
      console.log(`expected_lp_fee=${fmtLamports(lpFee)} SOL`);
      console.log(`expected_creator_fee=${fmtLamports(creatorFee)} SOL`);
      console.log(`expected_platform_fee=${fmtLamports(platformFee)} SOL`);
      console.log(`expected_treasury_delta=${fmtLamports(treasuryExpected)} SOL`);
      console.log(`userToken ${userTokenBefore.value.amount} -> ${userTokenAfter.value.amount}`);
      console.log(`userSol ${userSolBefore} -> ${userSolAfter}`);
      console.log(`creator_delta=${fmtLamports(creatorAfter - creatorBefore)} SOL`);
      console.log(`platform_delta=${fmtLamports(platformAfter - platformBefore)} SOL`);
      console.log(`treasury_delta=${fmtLamports(treasuryAfter - treasuryBefore)} SOL`);
      console.log(`lp_vault_delta=${fmtTokensRaw(lpVaultAfter - lpVaultBefore)}`);
      console.log(
        `tokensSold ${launchStateBefore.tokensSold.toString()} -> ${launchStateAfter.tokensSold.toString()}`
      );
      console.log(
        `solCollected ${launchStateBefore.solCollected.toString()} -> ${launchStateAfter.solCollected.toString()}`
      );
      console.log(`state=${launchStateAfter.state}`);
    }

    // --------------------------------------------------
    // PHASE 3: AMM sells
    // --------------------------------------------------
    console.log("\n=== PHASE 3: AMM SELLS ===");

    for (let i = 1; i <= AMM_SELL_COUNT; i++) {
      const launchStateBefore: any = await program.account.launchState.fetch(launchStatePda);

      const userTokenBefore = await connection.getTokenAccountBalance(userAta, "confirmed");
      const userSolBefore = await connection.getBalance(payer.publicKey, "confirmed");

      const creatorBefore = await getLamports(connection, creatorSolVault);
      const platformBefore = await getLamports(connection, PLATFORM_WALLET);
      const treasuryBefore = await getLamports(connection, treasurySolVault);
      const lpVaultBefore = await getTokenRaw(connection, lpVaultPda);

      const rawBal = BigInt(userTokenBefore.value.amount);
      if (rawBal <= 1000n) {
        console.log(`\n[AMM SELL ${i}] skipped: user balance too low (${rawBal})`);
        continue;
      }

      const sellRaw = rawBal / 20n;
      const sellAmount = new anchor.BN(sellRaw.toString());

      const sig = await program.methods
        .ammSell(sellAmount, new anchor.BN(0))
        .accounts({
          seller: payer.publicKey,
          launchState: launchStatePda,
          lpVault: lpVaultPda,
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

      const creatorAfter = await getLamports(connection, creatorSolVault);
      const platformAfter = await getLamports(connection, PLATFORM_WALLET);
      const treasuryAfter = await getLamports(connection, treasurySolVault);
      const lpVaultAfter = await getTokenRaw(connection, lpVaultPda);

      console.log(`\n[AMM SELL ${i}] sig=${sig}`);
      console.log(`tokens_in=${fmtTokensRaw(sellRaw)} (${sellRaw})`);
      console.log(`userToken ${userTokenBefore.value.amount} -> ${userTokenAfter.value.amount}`);
      console.log(`userSol ${userSolBefore} -> ${userSolAfter}`);
      console.log(`creator_delta=${fmtLamports(creatorAfter - creatorBefore)} SOL`);
      console.log(`platform_delta=${fmtLamports(platformAfter - platformBefore)} SOL`);
      console.log(`treasury_delta=${fmtLamports(treasuryAfter - treasuryBefore)} SOL`);
      console.log(`lp_vault_delta=${fmtTokensRaw(lpVaultAfter - lpVaultBefore)}`);
      console.log(
        `tokensSold ${launchStateBefore.tokensSold.toString()} -> ${launchStateAfter.tokensSold.toString()}`
      );
      console.log(
        `solCollected ${launchStateBefore.solCollected.toString()} -> ${launchStateAfter.solCollected.toString()}`
      );
      console.log(`state=${launchStateAfter.state}`);
    }

    const finalState: any = await program.account.launchState.fetch(launchStatePda);
    console.log("\n=== FINAL STATE ===");
    console.log(`state=${finalState.state}`);
    console.log(`tokensSold=${finalState.tokensSold.toString()}`);
    console.log(`solCollected=${finalState.solCollected.toString()}`);

    console.log("✅ Detailed local math stress test complete");
  });
});
