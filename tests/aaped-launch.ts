import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} from "@solana/web3.js";

async function main() {
  // 🔴 DRPC DEVNET WITH API KEY INLINE (TEST ONLY)
  const DRPC_URL = "https://lb.drpc.live/solana/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

  const connection = new Connection(DRPC_URL, {
    commitment: "confirmed"
  });

  console.log("RPC:", DRPC_URL);

  // ⚠️ Replace with your existing funded devnet keypair
  // Example: load from file or hardcode secret array
  const secret = Uint8Array.from([
    // paste your wallet secret key array here
  ]);

  const sender = Keypair.fromSecretKey(secret);

  const recipient = new PublicKey("6t6zr2VA9MbZM4gpJ1Yit6YgDi6r2uozqKNtxCcQRJj4");

  console.log("Sender:", sender.publicKey.toBase58());

  const balance = await connection.getBalance(sender.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  if (balance < 0.02 * LAMPORTS_PER_SOL) {
    throw new Error("Not enough SOL for test.");
  }

  const lamports = 0.01 * LAMPORTS_PER_SOL;

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports
    })
  );

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = sender.publicKey;

  console.log("Blockhash:", latestBlockhash.blockhash);
  console.log("LastValidHeight:", latestBlockhash.lastValidBlockHeight);

  tx.sign(sender);

  console.log("Sending transaction...");

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [sender],
    {
      skipPreflight: false,
      commitment: "confirmed"
    }
  );

  console.log("✅ SUCCESS");
  console.log("TX:", signature);
}

main().catch((err) => {
  console.error("❌ ERROR:", err);
});
