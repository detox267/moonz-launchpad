// tests/drpc-send.ts
import fs from "fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// --------- CONFIG ---------
const DRPC_URL =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";
// If DRPC uses a different format for you, swap it here.
// Examples some providers use:
// - https://solana-devnet.drpc.org/?api-key=YOUR_KEY
// - https://solana-devnet.drpc.org/YOUR_KEY

const FROM_KEYPAIR_PATH = "/root/.config/solana/id.json";

// recipient (any devnet pubkey)
const TO = new PublicKey("6t6zr2VA9MbZM4gpJ1Yit6YgDi6r2uozqKNtxCcQRJj4");

// keep tiny while testing
const AMOUNT_SOL = 0.001;

// --------- JSON-RPC helper ---------
async function rpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const r = await fetch(DRPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const j = await r.json();
  if (j.error) {
    throw new Error(`${method} error: ${j.error.message || JSON.stringify(j.error)}`);
  }
  return j.result as T;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirmSig(signature: string, timeoutMs = 60_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const statuses = await rpc<any>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const st = statuses?.value?.[0];

    if (st) {
      if (st.err) return { ok: false, err: st.err, status: st };
      // confirmationStatus: "processed" | "confirmed" | "finalized"
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        return { ok: true, status: st };
      }
    }
    await sleep(1200);
  }

  return { ok: false, err: "timeout_confirming_signature" };
}

async function main() {
  console.log("DRPC:", DRPC_URL);

  // Load payer
  const secret = JSON.parse(fs.readFileSync(FROM_KEYPAIR_PATH, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Wallet:", payer.publicKey.toBase58());

  // Balance (JSON-RPC)
  const bal = await rpc<number>("getBalance", [payer.publicKey.toBase58(), { commitment: "confirmed" }]);
  console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

  // Latest blockhash (JSON-RPC)
  const latest = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = latest.value.blockhash;
  console.log("Blockhash:", blockhash);

  // Build LEGACY tx (SOL transfers are fine as legacy)
  const lamports = Math.floor(AMOUNT_SOL * LAMPORTS_PER_SOL);

  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: TO,
      lamports,
    })
  );

  tx.sign(payer);

  const raw = tx.serialize(); // Buffer
  const b64 = raw.toString("base64");

  console.log("Sending", AMOUNT_SOL, "SOL to", TO.toBase58());
  console.log("serialized bytes:", raw.length);
  console.log("base64 first 80:", b64.slice(0, 80));

  // OPTIONAL: simulate first
  const sim = await rpc<any>("simulateTransaction", [
    b64,
    {
      encoding: "base64",
      sigVerify: false,
      commitment: "processed",
      replaceRecentBlockhash: true, // helps if blockhash is close to expiring
    },
  ]);

  if (sim.value?.err) {
    console.log("SIM ERR:", sim.value.err);
    console.log("SIM LOGS:", sim.value.logs || []);
    throw new Error("Simulation failed; see logs above");
  } else {
    console.log("Sim OK");
  }

  // Send transaction via JSON-RPC
  const sig = await rpc<string>("sendTransaction", [
    b64,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 5,
    },
  ]);

  console.log("SIG:", sig);

  // Confirm by polling
  const conf = await confirmSig(sig, 60_000);
  console.log("CONFIRM:", conf);

  if (!conf.ok) {
    throw new Error(`Not confirmed: ${JSON.stringify(conf.err)}`);
  }

  console.log("✅ Success");
}

main().catch((e) => {
  console.error("❌ ERROR:", e.message || e);
  process.exit(1);
});
