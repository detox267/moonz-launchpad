import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

/**
 * DRPC DEVNET RPC (yours - key is in the URL)
 * If you swap endpoints, keep it DEVNET.
 */
const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

// Recipient for test transfer
const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";

// Amount to send (SOL)
const AMOUNT_SOL = 0.01;

/**
 * OPTIONAL: set true if you want the script to actually send via JSON-RPC too.
 * If false, it ONLY prints the base64 + Postman body.
 */
const ALSO_SEND_VIA_JSONRPC = false;

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
    throw new Error(`RPC error ${j.error.code}: ${j.error.message} ${j.error.data ? JSON.stringify(j.error.data) : ""}`);
  }
  return j.result as T;
}

async function main() {
  console.log("RPC:", RPC);

  // Load CLI wallet
  const secret = JSON.parse(fs.readFileSync("/root/.config/solana/id.json", "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  // Use SAME RPC for blockhash (important)
  const connection = new Connection(RPC, "confirmed");

  const bal = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

  const recipient = new PublicKey(RECIPIENT);
  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  // Get a fresh blockhash right before signing
  const latest = await connection.getLatestBlockhash("confirmed");
  console.log("Blockhash:", latest.blockhash);
  console.log("LastValidBlockHeight:", latest.lastValidBlockHeight);

  // Build legacy transaction
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports,
    })
  );

  // Sign
  tx.sign(payer);

  // Serialize to wire bytes -> base64 (what sendTransaction expects)
  const raw = tx.serialize();
  const base64Tx = Buffer.from(raw).toString("base64");

  console.log("\n=== BASE64 TRANSACTION (PASTE INTO POSTMAN) ===");
  console.log(base64Tx);

  console.log("\n=== POSTMAN BODY (sendTransaction) ===");
  const postmanBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [
      base64Tx,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 3,
      },
    ],
  };
  console.log(JSON.stringify(postmanBody, null, 2));

  // OPTIONAL: send via JSON-RPC directly (same body as Postman)
  if (ALSO_SEND_VIA_JSONRPC) {
    console.log("\n=== SENDING VIA JSON-RPC NOW ===");
    const sig = await jsonRpc<string>(RPC, "sendTransaction", postmanBody.params);
    console.log("Signature:", sig);

    // confirm quickly using the same blockhash context
    const conf = await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
    console.log("Confirm:", conf.value);
  }
}

main().catch((e) => {
  console.error("❌ ERROR:", e?.message || e);
  process.exit(1);
});
