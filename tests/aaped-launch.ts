import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

describe("transfer-only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;

  it("sends 1 SOL using classic Transaction flow", async () => {
    try {
      const payer = (provider.wallet as anchor.Wallet).payer;

      const recipientPublicKey = new PublicKey(
        "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr"
      );

      const lamports = 1 * LAMPORTS_PER_SOL;

      // Create transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipientPublicKey,
          lamports,
        })
      );

      // Get fresh blockhash
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");

      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = payer.publicKey;

      // Sign
      transaction.sign(payer);

      console.log("=== SENDING TX ===");
      console.log("rpc:", (connection as any)._rpcEndpoint);
      console.log("from:", payer.publicKey.toBase58());
      console.log("to:", recipientPublicKey.toBase58());
      console.log("lamports:", lamports);
      console.log("blockhash:", latestBlockhash.blockhash);

      // Send
      const txid = await connection.sendTransaction(transaction, [payer], {
        skipPreflight: false,
        commitment: "confirmed",
      });

      console.log("txid:", txid);

      // Confirm
      const confirmation = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      console.log("confirm result:", confirmation.value);

      if (confirmation.value.err) {
        throw new Error("Transaction failed on-chain");
      }

      console.log("✅ SUCCESS");
    } catch (error: any) {
      console.error("❌ Error sending SOL:", error.message);
      throw error;
    }
  });
});
