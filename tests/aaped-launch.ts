import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

/**
 * DRPC DEVNET (key is embedded in URL; that IS the auth)
 * If you switch endpoints, keep it devnet.
 */
const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

// must exist
const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";

// SOL to send
const AMOUNT_SOL = 0.01;

// priority fee ladder (microLamports per CU) — each retry bumps this
const PRIORITY_FEE_LADDER = [50_000, 150_000, 400_000, 800_000]; // aggressive
const CU_LIMIT = 200_000;

// how long we poll for confirmation (ms)
const CONFIRM_TIMEOUT_MS = 45_000;
const POLL_EVERY_MS = 1_500;

type RpcError = {
  code: number;
  message: string;
  data?: any;
};

async function jsonRpc<T>(rpcUrl: string, method: string, params: any[] = []): Promise<T> {
  const body = { jsonrpc: "2.0", id: 1, method, params };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await res.json();
  if (j?.error) {
    const e: RpcError = j.error;
    const extra = e.data ? ` ${JSON.stringify(e.data)}` : "";
    throw new Error(`sendTransaction error: ${e.message}${extra}`);
  }
  return j.result as T;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableSendError(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("block height exceeded") ||
    m.includes("blockhash not found") ||
    m.includes("expired") ||
    m.includes("node is behind") ||
    m.includes("unable to send transaction") ||
    m.includes("transaction was not confirmed") ||
    m.includes("timed out") ||
    m.includes("429") ||
    m.includes("too many requests")
  );
}

async function waitForSignatureConfirmed(rpcUrl: string, signature: string) {
  const start = Date.now();

  while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
    // getSignatureStatuses expects [ [sig], {searchTransactionHistory?: boolean} ]
    const result = await jsonRpc<any>(rpcUrl, "getSignatureStatuses", [[signature]]);

    const st = result?.value?.[0];
    // st can be null if not seen yet
    if (st) {
      if (st.err) {
        throw new Error(`On-chain failure: ${JSON.stringify(st.err)}`);
      }
      // confirmationStatus: processed/confirmed/finalized
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        return { ok: true, status: st.confirmationStatus };
      }
    }

    await sleep(POLL_EVERY_MS);
  }

  throw new Error("Confirm timeout: signature not confirmed in time (may still land later).");
}

async function buildBase64V0TransferTx(params: {
  connection: Connection;
  payer: Keypair;
  to: PublicKey;
  lamports: number;
  cuLimit: number;
  microLamports: number;
}) {
  const { connection, payer, to, lamports, cuLimit, microLamports } = params;

  // ALWAYS fetch fresh blockhash right before compile+sign
  const latest = await connection.getLatestBlockhash("confirmed");

  const ixComputeLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit });
  const ixComputePrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const ixTransfer = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: to,
    lamports,
  });

  const msgV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [ixComputeLimit, ixComputePrice, ixTransfer],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msgV0);
  tx.sign([payer]);

  const raw = tx.serialize();
  const base64Tx = Buffer.from(raw).toString("base64");

  return {
    base64Tx,
    latestBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    serializedBytes: raw.length,
  };
}

async function main() {
  console.log("RPC:", RPC);

  // Load payer from Solana CLI wallet
  const secret = JSON.parse(fs.readFileSync("/root/.config/solana/id.json", "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  const bal = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("Balance:", (bal / LAMPORTS_PER_SOL).toFixed(6), "SOL");

  const to = new PublicKey(RECIPIENT);
  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  console.log(`Sending ${AMOUNT_SOL} SOL -> ${to.toBase58()}`);
  console.log(`Lamports: ${lamports}`);

  let lastErr: any = null;

  for (let attempt = 0; attempt < PRIORITY_FEE_LADDER.length; attempt++) {
    const microLamports = PRIORITY_FEE_LADDER[attempt];
    console.log(`\n=== ATTEMPT ${attempt + 1}/${PRIORITY_FEE_LADDER.length} ===`);
    console.log("Compute unit limit:", CU_LIMIT);
    console.log("Compute unit price (microLamports):", microLamports);

    try {
      // Build + serialize v0 tx
      const built = await buildBase64V0TransferTx({
        connection,
        payer,
        to,
        lamports,
        cuLimit: CU_LIMIT,
        microLamports,
      });

      console.log("Blockhash:", built.latestBlockhash);
      console.log("LastValidBlockHeight:", built.lastValidBlockHeight);
      console.log("Serialized bytes:", built.serializedBytes);

      // Send via DRPC JSON-RPC (THIS is what you wanted)
      const sig = await jsonRpc<string>(RPC, "sendTransaction", [
        built.base64Tx,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 3,
        },
      ]);

      console.log("Signature:", sig);

      // Confirm by polling signature statuses (no blockhash-context confirmTransaction)
      const conf = await waitForSignatureConfirmed(RPC, sig);
      console.log("✅ Confirmed:", conf);

      // done
      return;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      console.error("❌ Error:", msg);

      if (!isRetryableSendError(msg)) {
        console.error("Not retryable. Stopping.");
        break;
      }

      console.log("Retrying with higher priority fee + fresh blockhash...");
      await sleep(750);
    }
  }

  throw lastErr || new Error("All attempts failed");
}

main().catch((e) => {
  console.error("\n=== FINAL FAILURE ===");
  console.error(e?.message || e);
  process.exit(1);
});
