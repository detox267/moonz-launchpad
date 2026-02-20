import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

const RPC =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

const RECIPIENT = "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr";

async function jsonRpc(rpcUrl: string, method: string, params: any[]) {
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
      `RPC ERROR ${j.error.code}: ${j.error.message} ${JSON.stringify(
        j.error.data || ""
      )}`
    );
  }

  return j.result;
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

  // 🔥 0.1 SOL transfer
  const lamports = 0.1 * LAMPORTS_PER_SOL;

  // 🔥 Fresh blockhash from SAME RPC
  const latest = await connection.getLatestBlockhash("confirmed");

  console.log("Blockhash:", latest.blockhash);

  // 🔥 0.1 SOL priority fee
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 200_000,
  });

  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 500_000, // ~0.1 SOL priority
  });

  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports,
  });

  // Build v0 message
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [computeLimitIx, computePriceIx, transferIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);

  // Sign
  tx.sign([payer]);

  const serialized = tx.serialize();
  const base64Tx = Buffer.from(serialized).toString("base64");

  console.log("\n=== BASE64 ===");
  console.log(base64Tx);

  console.log("\n=== SENDING VIA DRPC ===");

  const sig = await jsonRpc(RPC, "sendTransaction", [
    base64Tx,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    },
  ]);

  console.log("Signature:", sig);

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

main().catch((err) => {
  console.error("❌ ERROR:", err.message);
});
