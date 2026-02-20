import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";

import fs from "fs";

async function main() {
  // 🔥 DRPC DEVNET
  const RPC = "https://lb.drpc.live/solana/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";
  const connection = new Connection(RPC, "confirmed");

  console.log("RPC:", RPC);

  // 🔥 Load CLI wallet directly
  const secret = JSON.parse(
    fs.readFileSync("/root/.config/solana/id.json", "utf8")
  );

  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log("Wallet:", payer.publicKey.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  // 🔥 Recipient (can be any valid pubkey)
  const recipient = new PublicKey(
    "6t6zr2VA9MbZM4gpJ1Yit6YgDi6r2uozqKNtxCcQRJj4"
  );

  const lamports = 0.01 * LAMPORTS_PER_SOL;

  // 🔥 Build transaction
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports
    })
  );

  console.log("Sending 0.01 SOL...");

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer],
    {
      skipPreflight: false,
      commitment: "confirmed"
    }
  );

  console.log("✅ Transaction Signature:", signature);
}

main().catch((err) => {
  console.error("❌ ERROR:", err);
});
