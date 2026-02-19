import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
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

async function safeGetRpcEndpoint(connection: any) {
  return connection?._rpcEndpoint || connection?.rpcEndpoint || "(unknown)";
}

describe("transfer-only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // If you want DRPC explicitly:
  // const connection = new Connection(process.env.DRPC_URL!, { commitment: "confirmed" });
  const connection = provider.connection as Connection;

  it("sends 1 SOL and prints full tx debug", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer; // Keypair
    const to = new PublicKey("4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr");
    const lamports = 1 * LAMPORTS_PER_SOL;

    // --- Sanity: balance ---
    const bal = await connection.getBalance(payer.publicKey, "confirmed");
    const minNeeded = lamports + 20_000; // tx fee headroom
    console.log("rpc endpoint:", await safeGetRpcEndpoint(connection));
    console.log("payer:", payer.publicKey.toBase58());
    console.log("payer balance SOL:", bal / LAMPORTS_PER_SOL);

    if (bal < minNeeded) {
      throw new Error(
        `Insufficient funds: have ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL, need >= ${(minNeeded / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
    }

    // --- Build with a fresh blockhash ---
    let latest = await connection.getLatestBlockhash("confirmed");

    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports,
    });

    const msgV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ix],
    }).compileToV0Message();

    let tx = new VersionedTransaction(msgV0);
    tx.sign([payer]);

    let serialized = tx.serialize();
    let b64 = Buffer.from(serialized).toString("base64");

    console.log("=== TX BUILD ===");
    console.log("recentBlockhash:", latest.blockhash);
    console.log("lastValidBlockHeight:", latest.lastValidBlockHeight);
    console.log("instruction count:", msgV0.compiledInstructions.length);
    console.log("to:", to.toBase58(), "lamports:", lamports);
    console.log("serialized bytes:", serialized.length);
    console.log("base64 (first 80):", shortB64(b64, 80));

    // --- Simulate (optionally replace blockhash to avoid expiry mid-test) ---
    console.log("=== SIMULATE ===");
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "processed",
      replaceRecentBlockhash: true, // IMPORTANT: helps a lot when RPC is slow / blockhash expires
    });

    console.log("simulate err:", sim.value.err);
    if (sim.value.logs?.length) {
      console.log("simulate logs:");
      for (const l of sim.value.logs) console.log("  ", l);
    }
    if (sim.value.err) {
      throw new Error("Simulation failed (see logs above)");
    }

    // --- SEND ---
    console.log("=== SEND ===");

    // Refresh blockhash RIGHT before send (common fix for “unable to send transaction”)
    latest = await connection.getLatestBlockhash("confirmed");

    // Rebuild tx with the NEW blockhash and re-sign
    const msgV0b = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ix],
    }).compileToV0Message();

    tx = new VersionedTransaction(msgV0b);
    tx.sign([payer]);

    serialized = tx.serialize();

    try {
      const sig = await connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 5,
      });
      console.log("tx sig:", sig);

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
    } catch (e: any) {
      console.error("SEND ERROR:", e?.message || e);

      // This is the exact thing your error message asked for
      if (e instanceof SendTransactionError) {
        const logs = e.getLogs?.();
        if (logs?.length) {
          console.log("SendTransactionError logs:");
          for (const l of logs) console.log("  ", l);
        }
      }

      // Also try best-effort: simulate again with replaceRecentBlockhash for extra context
      try {
        const sim2 = await connection.simulateTransaction(tx, {
          sigVerify: false,
          commitment: "processed",
          replaceRecentBlockhash: true,
        });
        console.log("post-fail simulate err:", sim2.value.err);
        if (sim2.value.logs?.length) {
          console.log("post-fail simulate logs:");
          for (const l of sim2.value.logs) console.log("  ", l);
        }
      } catch {}

      throw e;
    }
  });
});
