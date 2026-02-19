import * as anchor from "@coral-xyz/anchor";
import { SystemProgram, PublicKey } from "@solana/web3.js";

describe("basic transfer test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("Sends 1 SOL", async () => {
    const payer = provider.wallet as anchor.Wallet;

    const to = new PublicKey(
      "4XdGNEeNGoK8afr8PLXhmpVSbVuap5JmuHP35nyptZsr"
    );

    console.log("Payer:", payer.publicKey.toBase58());
    console.log("Recipient:", to.toBase58());

    const balanceBefore = await provider.connection.getBalance(payer.publicKey);
    console.log("Payer balance before:", balanceBefore);

    const tx = await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: to,
          lamports: 1_000_000_000, // 1 SOL
        })
      ),
      []
    );

    console.log("Transfer signature:", tx);

    const balanceAfter = await provider.connection.getBalance(payer.publicKey);
    console.log("Payer balance after:", balanceAfter);

    console.log("Transfer SUCCESS");
  });
});
