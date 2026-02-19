import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";

function shortB64(b64: string, n = 80) {
  return b64.length <= n ? b64 : b64.slice(0, n);
}

function isBlockhashExpired(e: any) {
  const msg = String(e?.message || e || "");
  return (
    msg.includes("block height exceeded") ||
    msg.includes("Blockhash not found") ||
    msg.includes("TransactionExpiredBlockheightExceededError")
  );
}

describe("transfer-only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  it("sends 1 SOL and prints full tx debug (retry on blockhash expiry)", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const to = new PublicKey("4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr");
    const lamports = 1 * LAMPORTS_PER_SOL;

    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ✅ ALWAYS grab a fresh blockhash per attempt
      const latest = await connection.getLatestBlockhash("processed");

      // Build instruction
      const ix = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: to,
        lamports,
      });

      // Build v0 message + tx
      const msgV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ix],
      }).compileToV0Message();

      const tx = new VersionedTransaction(msgV0);
      tx.sign([payer]);

      const serialized = tx.serialize();
      const b64 = Buffer.from(serialized).toString("base64");

      console.log("\ntransfer-only");
      console.log("=== TX BUILD ===");
      console.log("attempt:", attempt, "/", MAX_ATTEMPTS);
      console.log("rpc endpoint:", (connection as any)._rpcEndpoint || "(unknown)");
      console.log("feePayer:", payer.publicKey.toBase58());
      console.log("recentBlockhash:", latest.blockhash);
      console.log("lastValidBlockHeight:", latest.lastValidBlockHeight);
      console.log("instruction count:", msgV0.compiledInstructions.length);
      console.log("to:", to.toBase58(), "lamports:", lamports);
      console.log("serialized bytes:", serialized.length);
      console.log("base64 (first 80):", shortB64(b64, 80));

      // Optional simulate (keep it fast)
      console.log("=== SIMULATE ===");
      const sim = await connection.simulateTransaction(tx, {
        sigVerify: false,
        commitment: "processed",
      });

      console.log("simulate err:", sim.value.err);
      if (sim.value.logs?.length) {
        console.log("simulate logs:");
        for (const l of sim.value.logs) console.log("  ", l);
      }
      if (sim.value.err) throw new Error("Simulation failed (see logs above)");

      try {
        console.log("=== SEND ===");
        const sig = await connection.sendRawTransaction(serialized, {
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 5,
        });
        console.log("tx sig:", sig);

        // ✅ confirm using the SAME (fresh) blockhash pair we built with
        const conf = await connection.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );

        console.log("confirm:", conf.value);
        if (conf.value.err) throw new Error("Transaction failed on-chain");
        return; // success
      } catch (e: any) {
        // If web3 throws SendTransactionError, grab logs
        if (e instanceof SendTransactionError) {
          try {
            const logs = await e.getLogs(connection);
            if (logs?.length) {
              console.log("=== SEND ERROR LOGS ===");
              for (const l of logs) console.log("  ", l);
            }
          } catch {}
        }

        if (isBlockhashExpired(e) && attempt < MAX_ATTEMPTS) {
          console.log("Blockhash expired — retrying with fresh blockhash...");
          continue;
        }

        throw e;
      }
    }

    throw new Error("Failed after retries (blockhash kept expiring)");
  });
});
