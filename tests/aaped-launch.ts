import * as anchor from "@coral-xyz/anchor";
import { SystemProgram, Transaction, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

describe("transfer-only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("sends 1 SOL and prints full tx debug", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const to = new PublicKey("4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr");
    const lamports = 1_000_000_000; // 1 SOL

    // Build instruction
    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports,
    });

    // Build transaction
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;

    // Fetch blockhash
    const bh = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;

    // LOG EVERYTHING BEFORE SIGN
    console.log("=== TX BUILD ===");
    console.log("feePayer:", tx.feePayer?.toBase58());
    console.log("recentBlockhash:", tx.recentBlockhash);
    console.log("lastValidBlockHeight:", bh.lastValidBlockHeight);
    console.log("instruction count:", tx.instructions.length);
    console.log("to:", to.toBase58(), "lamports:", lamports);

    // Sign (Anchor wallet)
    const signed = await payer.signTransaction(tx);

    // Serialize
    const raw = signed.serialize();
    const b64 = raw.toString("base64");
    console.log("serialized bytes:", raw.length);
    console.log("base64 (first 80):", b64.slice(0, 80));

    // Simulate first (this is where you'll see preflight reasons)
    console.log("=== SIMULATE ===");
    const sim = await provider.connection.simulateTransaction(signed, { commitment: "confirmed" });
    console.log("simulate.err:", sim.value.err);
    if (sim.value.logs) console.log(sim.value.logs.join("\n"));

    if (sim.value.err) throw new Error("Simulation failed (see logs above)");

    // Send & confirm
    console.log("=== SEND ===");
    const sig = await sendAndConfirmTransaction(provider.connection, signed, [], {
      commitment: "confirmed",
      skipPreflight: false,
    });

    console.log("✅ signature:", sig);
  });
});
