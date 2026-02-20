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
 * DRPC DEVNET RPC (your key is embedded in URL)
 */
const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

// Recipient for test transfer
const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";

// Amount to send (SOL)
const AMOUNT_SOL = 0.01;

// If true, will POST sendTransaction to DRPC automatically.
// If false, only prints base64 + Postman JSON.
const ALSO_SEND_VIA_JSONRPC = true;

type JsonRpcOk<T> = { jsonrpc: "2.0"; id: number; result: T };
type JsonRpcErr = {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: any };
};

async function jsonRpc<T>(rpcUrl: string, method: string, params: any[] = []): Promise<T> {
  const body = { jsonrpc: "2.0", id: 1, method, params };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = (await res.json()) as JsonRpcOk<T> | JsonRpcErr;
  if ("error" in j) {
    throw new Error(
      `RPC error ${j.error.code}: ${j.error.message}${
        j.error.data ? ` | data=${JSON.stringify(j.error.data)}` : ""
      }`
    );
  }
  return j.result;
}

function loadCliKeypair(path = "/root/.config/solana/id.json") {
  const raw = fs.readFileSync(path, "utf8");
  const secret = JSON.parse(raw);

  // Solana CLI id.json is usually an array of 64 bytes.
  const bytes = Uint8Array.from(secret);

  if (bytes.length !== 64) {
    throw new Error(`bad secret key size: expected 64, got ${bytes.length}`);
  }

  return Keypair.fromSecretKey(bytes);
}

async function main() {
  console.log("RPC:", RPC);

  const payer = loadCliKeypair();
  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  const bal = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("Balance:", (bal / LAMPORTS_PER_SOL).toFixed(6), "SOL");

  const recipient = new PublicKey(RECIPIENT);
  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  // IMPORTANT: get a fresh blockhash right before signing/sending
  const latest = await connection.getLatestBlockhash("confirmed");
  console.log("Blockhash:", latest.blockhash);
  console.log("LastValidBlockHeight:", latest.lastValidBlockHeight);

  // Build legacy tx (SOL transfer)
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

  // Serialize to base64
  const raw = tx.serialize(); // requires signature present
  const base64Tx = Buffer.from(raw).toString("base64");

  console.log("\n=== BASE64 TRANSACTION (PASTE INTO POSTMAN) ===");
  console.log(base64Tx);

  const postmanBody = {
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

  console.log("\n=== POSTMAN BODY ===");
  console.log(JSON.stringify(postmanBody, null, 2));

  if (!ALSO_SEND_VIA_JSONRPC) return;

  // Send via JSON-RPC (same as Postman)
  console.log("\n=== SENDING VIA DRPC JSON-RPC ===");
  const sig = await jsonRpc<string>(RPC, "sendTransaction", postmanBody.params);
  console.log("Signature:", sig);

  // Confirm using the SAME blockhash context
  console.log("\n=== CONFIRM (blockhash context) ===");
  const conf = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  console.log("Confirm result:", conf.value);

  // If it failed or didn’t confirm, pull status + logs hints
  console.log("\n=== STATUS CHECK ===");
  const status = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
  console.log(JSON.stringify(status.value[0], null, 2));

  // Try fetch transaction (may be null if dropped)
  console.log("\n=== GET TRANSACTION (if landed) ===");
  const txInfo = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!txInfo) {
    console.log("Transaction not found on-chain (likely dropped / blockhash expired / not forwarded).");
  } else {
    console.log("slot:", txInfo.slot);
    console.log("meta.err:", txInfo.meta?.err ?? null);
    if (txInfo.meta?.logMessages?.length) {
      console.log("logs:");
      for (const l of txInfo.meta.logMessages) console.log("  ", l);
    }
  }

  if (conf.value.err) throw new Error("Transaction failed on-chain (see status/logs above).");
}

main().catch((e) => {
  console.error("❌ ERROR:", e?.message || e);
  process.exit(1);
});
