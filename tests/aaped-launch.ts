import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";

const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";
const AMOUNT_SOL = 0.01;

// Retry policy
const MAX_ATTEMPTS = 5;

// Priority fee ladder (microLamports per CU) – escalates per attempt.
// These are intentionally aggressive for testing.
const MICRO_LAMPORTS_LADDER = [
  50_000,   // attempt 1
  100_000,  // attempt 2
  200_000,  // attempt 3
  400_000,  // attempt 4
  800_000,  // attempt 5
];

// CU limit (simple transfer needs very little, but this is fine)
const CU_LIMIT = 200_000;

function shortB64(b64: string, n = 90) {
  return b64.length <= n ? b64 : b64.slice(0, n) + "...";
}

async function jsonRpc<T>(rpcUrl: string, method: string, params: any[] = []): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await res.json();
  if (j.error) {
    const msg = `sendTransaction error: ${j.error.message}${
      j.error.data ? " " + JSON.stringify(j.error.data) : ""
    }`;
    throw new Error(msg);
  }
  return j.result as T;
}

async function main() {
  console.log("RPC:", RPC);

  // Load CLI wallet
  const secret = JSON.parse(fs.readFileSync("/root/.config/solana/id.json", "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  const balLamports = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("Balance:", (balLamports / LAMPORTS_PER_SOL).toFixed(6), "SOL");

  const recipient = new PublicKey(RECIPIENT);
  console.log("Recipient:", recipient.toBase58());

  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);
  console.log("Amount:", AMOUNT_SOL, "SOL =", lamports, "lamports");

  let lastErr: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const microLamports =
      MICRO_LAMPORTS_LADDER[Math.min(attempt - 1, MICRO_LAMPORTS_LADDER.length - 1)];

    console.log("\n==============================");
    console.log(`ATTEMPT ${attempt}/${MAX_ATTEMPTS}`);
    console.log("Priority fee (microLamports/CU):", microLamports);
    console.log("CU limit:", CU_LIMIT);

    try {
      // Always fetch fresh blockhash RIGHT before signing
      const latest = await connection.getLatestBlockhash("confirmed");
      console.log("Blockhash:", latest.blockhash);
      console.log("LastValidBlockHeight:", latest.lastValidBlockHeight);

      // Priority fee Ixs
      const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT });
      const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

      // Transfer Ix
      const transferIx = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports,
      });

      // Build legacy tx (SOL transfer is legacy-style)
      const tx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: latest.blockhash,
      })
        .add(computeLimitIx)
        .add(computePriceIx)
        .add(transferIx);

      tx.sign(payer);

      const raw = tx.serialize();
      const base64Tx = Buffer.from(raw).toString("base64");

      console.log("serialized bytes:", raw.length);
      console.log("base64 first 90:", shortB64(base64Tx, 90));

      // This is exactly the Postman payload
      const params = [
        base64Tx,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 5,
        },
      ];

      // Send via DRPC JSON-RPC
      const sig = await jsonRpc<string>(RPC, "sendTransaction", params);
      console.log("Signature:", sig);

      // Confirm using the SAME blockhash context
      const conf = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );

      console.log("Confirm:", conf.value);

      if (conf.value.err) {
        // If confirmed but failed, retry with higher fee
        throw new Error(`On-chain failure: ${JSON.stringify(conf.value.err)}`);
      }

      console.log("✅ SUCCESS");
      return;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);

      console.error("❌ FAIL:", msg);

      // Common devnet issues:
      // - blockhash not found / block height exceeded => rebuild next attempt (we do)
      // - unable to send transaction => often fee/leader/health; retry with higher priority
      // - simulation failed => could be account issues, insufficient funds, invalid recipient, etc.
      // We always retry with fresh blockhash + higher fee.

      // Small delay so we don't hammer the endpoint
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
  }

  throw lastErr || new Error("Failed after retries");
}

main().catch((e) => {
  console.error("\n🔥 FINAL ERROR:", e?.message || e);
  process.exit(1);
});
