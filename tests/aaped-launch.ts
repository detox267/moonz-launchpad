import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

function shortB64(b64: string, n = 80) {
  return b64.length <= n ? b64 : b64.slice(0, n);
}

describe("transfer-only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // If you want to test DRPC specifically, set DRPC_URL in env and use this:
  // const connection = new Connection(process.env.DRPC_URL!, "confirmed");
  // Otherwise use Anchor's connection (localnet or whatever you configured):
  const connection = provider.connection;

  it("sends 1 SOL and prints full tx debug", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer; // Keypair
    const to = new PublicKey("4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr");
    const lamports = 1 * LAMPORTS_PER_SOL;

    // --- Build ---
    const latest = await connection.getLatestBlockhash("confirmed");

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

    const tx = new VersionedTransaction(msgV0);

    // Sign (simulation can be done unsigned with sigVerify:false, but signing is fine)
    tx.sign([payer]);

    const serialized = tx.serialize();
    const b64 = Buffer.from(serialized).toString("base64");

    console.log("transfer-only");
    console.log("=== TX BUILD ===");
    console.log("rpc endpoint:", (connection as any)._rpcEndpoint || "(unknown)");
    console.log("feePayer:", payer.publicKey.toBase58());
    console.log("recentBlockhash:", latest.blockhash);
    console.log("lastValidBlockHeight:", latest.lastValidBlockHeight);
    console.log("instruction count:", msgV0.compiledInstructions.length);
    console.log("to:", to.toBase58(), "lamports:", lamports);
    console.log("serialized bytes:", serialized.length);
    console.log("base64 (first 80):", shortB64(b64, 80));

    // --- Simulate (CORRECT) ---
    console.log("=== SIMULATE ===");
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "processed",
      // replaceRecentBlockhash is optional; helpful if blockhash expires between build/sim
      // replaceRecentBlockhash: true,
    });

    console.log("simulate err:", sim.value.err);
    if (sim.value.logs?.length) {
      console.log("simulate logs:");
      for (const l of sim.value.logs) console.log("  ", l);
    }

    if (sim.value.err) {
      throw new Error("Simulation failed (see logs above)");
    }

    // --- Actually send (optional; comment out if you ONLY want simulate) ---
    console.log("=== SEND ===");
    const sig = await connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
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
  });
});
