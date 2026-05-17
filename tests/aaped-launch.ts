import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";

import { AapedLaunch } from "../target/types/aaped_launch";

/**
 * AAPED / Moonz localnet test helper.
 *
 * This file is designed for the current one-signature launch program shape:
 * - bonding buy/sell uses WSOL token accounts
 * - AMM SOL buy/sell uses WSOL token accounts
 * - AMM USDC buy/sell uses USDC token accounts
 * - LaunchState fields use treasuryWsolVault / treasuryUsdcVault
 *
 * Usage examples:
 *
 * Print launch state only:
 * TARGET_MINT=<mint> anchor test --skip-deploy
 *
 * Buy with SOL during bonding or AMM SOL mode:
 * TARGET_MINT=<mint> TEST_BUY_SOL=0.1 anchor test --skip-deploy
 *
 * Sell all wallet tokens during bonding or AMM mode:
 * TARGET_MINT=<mint> TEST_SELL_ALL=true anchor test --skip-deploy
 *
 * AMM USDC buy:
 * TARGET_MINT=<mint> TEST_USDC_BUY=10 anchor test --skip-deploy
 *
 * AMM USDC sell all:
 * TARGET_MINT=<mint> TEST_USDC_SELL_ALL=true anchor test --skip-deploy
 */

const PROGRAM_ID = new PublicKey(
  process.env.AAPED_PROGRAM_ID ||
    process.env.PROGRAM_ID ||
    "9rXdqU4PS9acsUVU8VsJ2zV3ejEV9JpYPiP1y7hSwuSm"
);

// Must match PLATFORM_WALLET in lib.rs.
const PLATFORM_WALLET = new PublicKey(
  process.env.PLATFORM_WALLET ||
    "ELZ5aiHLxnaTmbazgbmoSCVS6SyvJ7DbXTDxq682PuKt"
);

// Must match USDC_MINT in lib.rs.
// On localnet this account only exists if you clone/create it for tests.
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

const TARGET_MINT = process.env.TARGET_MINT
  ? new PublicKey(process.env.TARGET_MINT)
  : null;

const PHASE = {
  PENDING_DEV_BUY: 0,
  BONDING: 1,
  MIGRATION_PENDING: 2,
  AMM_LIVE: 3,
  MIGRATED: 4,
  SWITCHING: 5,
} as const;

const QUOTE = {
  SOL: 0,
  USDC: 1,
} as const;

function requireTargetMint(): PublicKey {
  if (!TARGET_MINT) {
    throw new Error("Missing TARGET_MINT env var");
  }
  return TARGET_MINT;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function envNumber(name: string, fallback = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return n;
}

function phaseName(v: number): string {
  switch (v) {
    case PHASE.PENDING_DEV_BUY:
      return "pending_dev_buy";
    case PHASE.BONDING:
      return "bonding";
    case PHASE.MIGRATION_PENDING:
      return "migration_pending";
    case PHASE.AMM_LIVE:
      return "amm_live";
    case PHASE.MIGRATED:
      return "migrated";
    case PHASE.SWITCHING:
      return "switching";
    default:
      return `unknown_${v}`;
  }
}

function quoteName(v: number): string {
  if (v === QUOTE.SOL) return "SOL/WSOL";
  if (v === QUOTE.USDC) return "USDC";
  return `unknown_${v}`;
}

function bnToString(v: any): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v.toString === "function") return v.toString();
  return String(v);
}

function solToLamportsBn(sol: number): anchor.BN {
  return new anchor.BN(Math.floor(sol * anchor.web3.LAMPORTS_PER_SOL).toString());
}

function usdcToBaseBn(usdc: number): anchor.BN {
  return new anchor.BN(Math.floor(usdc * 1_000_000).toString());
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

async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  return Boolean(await connection.getAccountInfo(pubkey, "confirmed"));
}

async function maybeCreateAtaIx(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false);

  if (await accountExists(connection, ata)) {
    return { ata, ix: null };
  }

  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
  };
}

function pushMaybe(ixs: TransactionInstruction[], ix: TransactionInstruction | null) {
  if (ix) ixs.push(ix);
}

async function getTokenRawBalance(
  connection: anchor.web3.Connection,
  ata: PublicKey
): Promise<string> {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return "0";

  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  return bal.value.amount;
}

describe("aaped-launch localnet trade test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  const program = new Program<AapedLaunch>(
    require("../target/idl/aaped_launch.json"),
    provider
  ) as Program<AapedLaunch>;

  it("prints state and optionally tests buy/sell routes", async () => {
    const mint = requireTargetMint();
    const wallet = provider.wallet as anchor.Wallet;
    const user = wallet.payer;

    console.log("RPC:", connection.rpcEndpoint);
    console.log("Program:", PROGRAM_ID.toBase58());
    console.log("Wallet:", user.publicKey.toBase58());
    console.log("Target mint:", mint.toBase58());
    console.log("Platform wallet:", PLATFORM_WALLET.toBase58());

    const logsSub = connection.onLogs(
      PROGRAM_ID,
      (ev) => {
        console.log("\n================ PROGRAM LOGS ================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      const [launchStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("launch_state"), mint.toBuffer()],
        PROGRAM_ID
      );

      const launchState: any = await program.account.launchState.fetch(launchStatePda);

      const state = Number(launchState.state);
      const quoteAsset = Number(launchState.quoteAsset);

      const saleVault = new PublicKey(launchState.saleVault);
      const lpVault = new PublicKey(launchState.lpVault);
      const treasuryWsolVault = new PublicKey(launchState.treasuryWsolVault);
      const treasuryUsdcVault = new PublicKey(launchState.treasuryUsdcVault);
      const creator = new PublicKey(launchState.creator);

      console.log("Launch state PDA:", launchStatePda.toBase58());
      console.log("Phase:", state, phaseName(state));
      console.log("Quote asset:", quoteAsset, quoteName(quoteAsset));
      console.log("Creator:", creator.toBase58());
      console.log("Sale vault:", saleVault.toBase58());
      console.log("LP vault:", lpVault.toBase58());
      console.log("Treasury WSOL vault:", treasuryWsolVault.toBase58());
      console.log("Treasury USDC vault:", treasuryUsdcVault.toBase58());
      console.log("Tokens sold:", bnToString(launchState.tokensSold));
      console.log("SOL collected:", bnToString(launchState.solCollected));

      if (state === PHASE.SWITCHING) {
        console.log("Trading is paused because launch is switching quote assets.");
        return;
      }

      const buySol = envNumber("TEST_BUY_SOL", 0);
      const sellAll = envBool("TEST_SELL_ALL", false);
      const buyUsdc = envNumber("TEST_USDC_BUY", 0);
      const sellAllUsdc = envBool("TEST_USDC_SELL_ALL", false);

      const userTokenAtaResult = await maybeCreateAtaIx(
        connection,
        user.publicKey,
        user.publicKey,
        mint
      );

      if (buySol > 0) {
        if (state !== PHASE.BONDING && state !== PHASE.AMM_LIVE) {
          throw new Error(`Cannot SOL buy in phase ${phaseName(state)}`);
        }

        if (state === PHASE.AMM_LIVE && quoteAsset !== QUOTE.SOL) {
          throw new Error(`Cannot SOL buy while AMM quote is ${quoteName(quoteAsset)}`);
        }

        const ixs: TransactionInstruction[] = [];

        pushMaybe(ixs, userTokenAtaResult.ix);

        const userWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          user.publicKey,
          NATIVE_MINT
        );

        const creatorWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          creator,
          NATIVE_MINT
        );

        const platformWsol = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          PLATFORM_WALLET,
          NATIVE_MINT
        );

        pushMaybe(ixs, userWsol.ix);
        pushMaybe(ixs, creatorWsol.ix);
        pushMaybe(ixs, platformWsol.ix);

        const lamports = solToLamportsBn(buySol);

        ixs.push(
          SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey: userWsol.ata,
            lamports: lamports.toNumber(),
          })
        );

        ixs.push(createSyncNativeInstruction(userWsol.ata));

        const method =
          state === PHASE.BONDING
            ? program.methods.buy(lamports, new anchor.BN(0)).accounts({
                buyer: user.publicKey,
                launchState: launchStatePda,
                saleVault,
                lpVault,
                buyerAta: userTokenAtaResult.ata,
                buyerWsolAta: userWsol.ata,
                treasuryWsolVault,
                creatorWsolAta: creatorWsol.ata,
                platformWsolAta: platformWsol.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
            : program.methods.ammBuy(lamports, new anchor.BN(0)).accounts({
                buyer: user.publicKey,
                launchState: launchStatePda,
                lpVault,
                buyerAta: userTokenAtaResult.ata,
                buyerWsolAta: userWsol.ata,
                treasuryWsolVault,
                creatorWsolAta: creatorWsol.ata,
                platformWsolAta: platformWsol.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
              });

        const sig = await method.preInstructions(ixs).rpc();

        console.log(`${state === PHASE.BONDING ? "buy" : "ammBuy"} sig:`, sig);
        await confirmViaWs(connection, sig, "finalized");
        await sleep(1000);
      }

      if (buyUsdc > 0) {
        if (state !== PHASE.AMM_LIVE || quoteAsset !== QUOTE.USDC) {
          throw new Error("USDC buy is only valid in AMM live USDC mode");
        }

        const ixs: TransactionInstruction[] = [];

        pushMaybe(ixs, userTokenAtaResult.ix);

        const userUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          user.publicKey,
          USDC_MINT
        );

        const creatorUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          creator,
          USDC_MINT
        );

        const platformUsdc = await maybeCreateAtaIx(
          connection,
          user.publicKey,
          PLATFORM_WALLET,
          USDC_MINT
        );

        pushMaybe(ixs, userUsdc.ix);
        pushMaybe(ixs, creatorUsdc.ix);
        pushMaybe(ixs, platformUsdc.ix);

        const usdcIn = usdcToBaseBn(buyUsdc);

        const sig = await program.methods
          .ammBuyUsdc(usdcIn, new anchor.BN(0))
          .accounts({
            buyer: user.publicKey,
            launchState: launchStatePda,
            lpVault,
            buyerAta: userTokenAtaResult.ata,
            buyerUsdcAta: userUsdc.ata,
            treasuryUsdcVault,
            creatorUsdcAta: creatorUsdc.ata,
            platformUsdcAta: platformUsdc.ata,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions(ixs)
          .rpc();

        console.log("ammBuyUsdc sig:", sig);
        await confirmViaWs(connection, sig, "finalized");
        await sleep(1000);
      }

      if (sellAll || sellAllUsdc) {
        const tokenBalRaw = await getTokenRawBalance(connection, userTokenAtaResult.ata);

        if (tokenBalRaw === "0") {
          throw new Error("Wallet holds 0 tokens for this mint");
        }

        const tokensIn = new anchor.BN(tokenBalRaw);

        if (sellAllUsdc) {
          if (state !== PHASE.AMM_LIVE || quoteAsset !== QUOTE.USDC) {
            throw new Error("USDC sell is only valid in AMM live USDC mode");
          }

          const ixs: TransactionInstruction[] = [];

          const userUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            user.publicKey,
            USDC_MINT
          );

          const creatorUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            creator,
            USDC_MINT
          );

          const platformUsdc = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            PLATFORM_WALLET,
            USDC_MINT
          );

          pushMaybe(ixs, userUsdc.ix);
          pushMaybe(ixs, creatorUsdc.ix);
          pushMaybe(ixs, platformUsdc.ix);

          const sig = await program.methods
            .ammSellUsdc(tokensIn, new anchor.BN(0))
            .accounts({
              seller: user.publicKey,
              launchState: launchStatePda,
              lpVault,
              sellerAta: userTokenAtaResult.ata,
              sellerUsdcAta: userUsdc.ata,
              treasuryUsdcVault,
              creatorUsdcAta: creatorUsdc.ata,
              platformUsdcAta: platformUsdc.ata,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .preInstructions(ixs)
            .rpc();

          console.log("ammSellUsdc sig:", sig);
          await confirmViaWs(connection, sig, "finalized");
          await sleep(1000);
        } else {
          if (state !== PHASE.BONDING && state !== PHASE.AMM_LIVE) {
            throw new Error(`Cannot SOL sell in phase ${phaseName(state)}`);
          }

          if (state === PHASE.AMM_LIVE && quoteAsset !== QUOTE.SOL) {
            throw new Error(`Cannot SOL sell while AMM quote is ${quoteName(quoteAsset)}`);
          }

          const ixs: TransactionInstruction[] = [];

          const userWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            user.publicKey,
            NATIVE_MINT
          );

          const creatorWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            creator,
            NATIVE_MINT
          );

          const platformWsol = await maybeCreateAtaIx(
            connection,
            user.publicKey,
            PLATFORM_WALLET,
            NATIVE_MINT
          );

          pushMaybe(ixs, userWsol.ix);
          pushMaybe(ixs, creatorWsol.ix);
          pushMaybe(ixs, platformWsol.ix);

          const method =
            state === PHASE.BONDING
              ? program.methods.sell(tokensIn, new anchor.BN(0)).accounts({
                  seller: user.publicKey,
                  launchState: launchStatePda,
                  saleVault,
                  sellerAta: userTokenAtaResult.ata,
                  sellerWsolAta: userWsol.ata,
                  treasuryWsolVault,
                  creatorWsolAta: creatorWsol.ata,
                  platformWsolAta: platformWsol.ata,
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
              : program.methods.ammSell(tokensIn, new anchor.BN(0)).accounts({
                  seller: user.publicKey,
                  launchState: launchStatePda,
                  lpVault,
                  sellerAta: userTokenAtaResult.ata,
                  sellerWsolAta: userWsol.ata,
                  treasuryWsolVault,
                  creatorWsolAta: creatorWsol.ata,
                  platformWsolAta: platformWsol.ata,
                  tokenProgram: TOKEN_PROGRAM_ID,
                });

          const sig = await method.preInstructions(ixs).rpc();

          console.log(`${state === PHASE.BONDING ? "sell" : "ammSell"} sig:`, sig);
          console.log("WSOL output remains in user WSOL ATA:", userWsol.ata.toBase58());
          await confirmViaWs(connection, sig, "finalized");
          await sleep(1000);
        }

        const tokenBalAfter = await getTokenRawBalance(connection, userTokenAtaResult.ata);
        console.log("Token balance after sell:", tokenBalAfter);
      }

      const refreshed: any = await program.account.launchState.fetch(launchStatePda);
      console.log("Refreshed phase:", Number(refreshed.state), phaseName(Number(refreshed.state)));
      console.log("Refreshed quote:", Number(refreshed.quoteAsset), quoteName(Number(refreshed.quoteAsset)));
      console.log("Refreshed tokens sold:", bnToString(refreshed.tokensSold));
      console.log("Refreshed SOL collected:", bnToString(refreshed.solCollected));

      console.log("✅ Test file completed");
    } finally {
      try {
        await connection.removeOnLogsListener(logsSub);
      } catch {}
    }
  });
});
