import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";
const AMOUNT_SOL = 0.01;

// ---------- PURE JSON-RPC ----------
async function sendViaDrpc(base64Tx: string) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [
      base64Tx,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      },
    ],
  };

  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();

  if (json.error) {
    throw new Error(
      `RPC Error ${json.error.code}: ${json.error.message} ${
        json.error.data ? JSON.stringify(json.error.data) : ""
      }`
    );
  }

  return json.result;
}

async function main() {
  console.log("RPC:", RPC);

  const secret = JSON.parse(
    fs.readFileSync("/root/.config/solana/id.json", "utf8")
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  const recipient = new PublicKey(RECIPIENT);
  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  // 🔥 Fresh blockhash from SAME RPC
  const latest = await connection.getLatestBlockhash("confirmed");

  console.log("Blockhash:", latest.blockhash);
  console.log("LastValidBlockHeight:", latest.lastValidBlockHeight);

  // 🔥 HIGH PRIORITY FEE (aggressive)
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 200_000,
  });

  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 200_000, // HIGH priority
  });

  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports,
  });

  // 🔥 VERSIONED MESSAGE (Solana official way)
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [computeLimitIx, computePriceIx, transferIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);

  // 🔥 SIGN
  tx.sign([payer]);

  const serialized = tx.serialize();
  const base64Tx = Buffer.from(serialized).toString("base64");

  console.log("\n=== BASE64 TX ===");
  console.log(base64Tx);

  console.log("\n=== SENDING VIA DRPC ===");

  const sig = await sendViaDrpc(base64Tx);

  console.log("Signature:", sig);

  console.log("\n=== CONFIRMING ===");

  const confirm = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  console.log("Confirm result:", confirm.value);
}

main().catch((e) => {
  console.error("❌ ERROR:", e.message || e);
});
