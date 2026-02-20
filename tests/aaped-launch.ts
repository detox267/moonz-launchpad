// tests/send-sol.ts
import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";

// DRPC DEVNET (your key is embedded in URL)
const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

// IMPORTANT: keep this the real recipient you want
const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";

// Amount in SOL
const AMOUNT_SOL = 0.01;

// Retry settings
const MAX_ATTEMPTS = 5;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadCliKeypair(path = "/root/.config/solana/id.json"): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  const u8 = Uint8Array.from(secret);
  return Keypair.fromSecretKey(u8);
}

async function sendSolOnce(connection: Connection, payer: Keypair, to: PublicKey, sol: number) {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);

  // Build legacy transaction exactly like your working example
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports,
    })
  );

  // Fresh blockhash
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latestBlockhash.blockhash;

  // Fee payer
  tx.feePayer = payer.publicKey;

  // Sign
  tx.sign(payer);

  // Send (THIS is the exact pattern you said works)
  const txid = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });

  return { txid, latestBlockhash };
}

async function main() {
  console.log("RPC:", RPC);

  const connection = new Connection(RPC, "confirmed");
  const payer = loadCliKeypair();

  console.log("Payer:", payer.publicKey.toBase58());

  const bal = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

  const recipient = new PublicKey(RECIPIENT);
  console.log("Recipient:", recipient.toBase58());
  console.log("Sending:", AMOUNT_SOL, "SOL");

  let lastErr: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`\n--- attempt ${attempt}/${MAX_ATTEMPTS} ---`);

      const { txid, latestBlockhash } = await sendSolOnce(
        connection,
        payer,
        recipient,
        AMOUNT_SOL
      );

      console.log("txid:", txid);

      // Confirm with the same blockhash context
      const conf = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      console.log("confirm:", conf.value);
      if (conf.value.err) throw new Error(`On-chain error: ${JSON.stringify(conf.value.err)}`);

      console.log("✅ Success");
      return;
    } catch (e: any) {
      lastErr = e;

      // If web3 throws SendTransactionError, try to print logs (when available)
      if (e instanceof SendTransactionError) {
        console.error("SendTransactionError:", e.message);
        try {
          const logs = await e.getLogs(connection);
          if (logs?.length) {
            console.error("logs:");
            for (const l of logs) console.error("  ", l);
          }
        } catch {
          // ignore
        }
      } else {
        console.error("Error:", e?.message || e);
      }

      // Small backoff
      await sleep(500 * attempt);
    }
  }

  throw lastErr ?? new Error("Failed after retries");
}

main().catch((e) => {
  console.error("❌ FINAL ERROR:", e?.message || e);
  process.exit(1);
});
