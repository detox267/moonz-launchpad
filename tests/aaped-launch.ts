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
    throw new Error(
      `RPC error ${j.error.code}: ${j.error.message} ${
        j.error.data ? JSON.stringify(j.error.data) : ""
      }`
    );
  }
  return j.result as T;
}

async function main() {
  console.log("RPC:", RPC);

  const secret = JSON.parse(
    fs.readFileSync("/root/.config/solana/id.json", "utf8")
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  const bal = await connection.getBalance(payer.publicKey);
  console.log("Balance:", bal / LAMPORTS_PER_SOL, "SOL");

  const recipient = new PublicKey(RECIPIENT);
  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  const latest = await connection.getLatestBlockhash("confirmed");

  // 🔥 PRIORITY FEE INSTRUCTIONS
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 200_000,
  });

  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 50_000, // 0.00005 SOL per 1M CU (aggressive)
  });

  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports,
  });

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

  console.log("\n=== BASE64 TRANSACTION ===");
  console.log(base64Tx);

  console.log("\n=== SENDING VIA DRPC JSON-RPC ===");

  const sig = await jsonRpc<string>(RPC, "sendTransaction", [
    base64Tx,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    },
  ]);

  console.log("Signature:", sig);

  const conf = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  console.log("Confirm result:", conf.value);
}

main().catch((e) => {
  console.error("❌ ERROR:", e?.message || e);
});
