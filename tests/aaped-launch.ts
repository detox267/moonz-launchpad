import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---------------- CONFIG ----------------
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

const WS_URL = RPC_URL.replace("https://", "wss://");

const PROGRAM_ID = new PublicKey(
  "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk"
);

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

// mint you want to drain/sell
const TARGET_MINT = new PublicKey(
  "2tSLPxuTTBy5Q9WSbGXDGrfDE76wFSqdZycMbkdbZCZg"
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmViaWs(
  connection: anchor.web3.Connection,
  signature: string,
  commitment: Commitment = "finalized",
  timeoutMs = 60000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Signature confirmation timeout: ${signature}`));
    }, timeoutMs);

    let subId: number | undefined;

    subId = connection.onSignature(
      signature,
      async (notif) => {
        clearTimeout(timer);

        if (subId !== undefined) {
          try {
            await connection.removeSignatureListener(subId);
          } catch {
            // ignore unsubscribe noise
          }
        }

        if (notif.err) {
          reject(
            new Error(`Tx failed (${signature}): ${JSON.stringify(notif.err)}`)
          );
        } else {
          resolve();
        }
      },
      commitment
    );
  });
}

describe("drain wallet token balance via ammSell", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = new Program<AapedLaunch>(
    require("../target/idl/aaped_launch.json"),
    provider
  ) as Program<AapedLaunch>;

  it("sells entire wallet balance for target mint", async () => {
    const seller = (provider.wallet as anchor.Wallet).payer;

    console.log("RPC:", RPC_URL);
    console.log("Program:", PROGRAM_ID.toBase58());
    console.log("Seller:", seller.publicKey.toBase58());
    console.log("Mint:", TARGET_MINT.toBase58());

    const logsSub = connection.onLogs(
      PROGRAM_ID,
      (ev) => {
        console.log("\n================ PROGRAM LOGS ================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      // --------------------------------------------------
      // PDAs
      // --------------------------------------------------
      const [launchStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("launch_state"), TARGET_MINT.toBuffer()],
        PROGRAM_ID
      );

      const launchState: any = await program.account.launchState.fetch(launchStatePda);

      console.log("Launch state PDA:", launchStatePda.toBase58());
      console.log("Launch phase/state:", launchState.state);

      // AMM live should be 3 based on your enum
      if (launchState.state !== 3) {
        throw new Error(
          `Launch is not in AmmLive state. Current state=${launchState.state}`
        );
      }

      const lpVault = new PublicKey(launchState.lpVault);
      const treasurySolVault = new PublicKey(launchState.treasurySolVault);
      const creatorSolVault = new PublicKey(launchState.creatorSolVault);

      // --------------------------------------------------
      // Seller ATA
      // --------------------------------------------------
      const sellerAta = getAssociatedTokenAddressSync(
        TARGET_MINT,
        seller.publicKey
      );

      console.log("Seller ATA:", sellerAta.toBase58());

      const ataInfo = await connection.getAccountInfo(sellerAta, "confirmed");
      if (!ataInfo) {
        throw new Error("Seller ATA does not exist for this mint");
      }

      const tokenBal = await connection.getTokenAccountBalance(sellerAta, "confirmed");
      const rawAmountStr = tokenBal.value.amount;
      const uiAmountStr = tokenBal.value.uiAmountString ?? "0";

      console.log("Wallet token raw amount:", rawAmountStr);
      console.log("Wallet token UI amount:", uiAmountStr);

      if (rawAmountStr === "0") {
        throw new Error("Wallet holds 0 tokens for this mint");
      }

      const tokensIn = new anchor.BN(rawAmountStr);

      // --------------------------------------------------
      // Pre balances
      // --------------------------------------------------
      const sellerSolBefore = await connection.getBalance(seller.publicKey, "confirmed");
      const treasuryBefore = await connection.getBalance(treasurySolVault, "confirmed");

      console.log("Seller SOL before:", sellerSolBefore);
      console.log("Treasury SOL before:", treasuryBefore);

      // --------------------------------------------------
      // Sell everything
      // --------------------------------------------------
      const sig = await program.methods
        .ammSell(tokensIn, new anchor.BN(0))
        .accounts({
          seller: seller.publicKey,
          launchState: launchStatePda,
          lpVault,
          sellerAta,
          treasurySolVault,
          creatorSolVault,
          platformWallet: PLATFORM_WALLET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      console.log("ammSell sig:", sig);
      await confirmViaWs(connection, sig, "finalized");
      console.log("ammSell finalized");

      await sleep(1500);

      // --------------------------------------------------
      // Post balances
      // --------------------------------------------------
      const tokenBalAfter = await connection.getTokenAccountBalance(
        sellerAta,
        "confirmed"
      );
      const sellerSolAfter = await connection.getBalance(seller.publicKey, "confirmed");
      const treasuryAfter = await connection.getBalance(treasurySolVault, "confirmed");

      console.log("Wallet token raw after:", tokenBalAfter.value.amount);
      console.log("Wallet token UI after:", tokenBalAfter.value.uiAmountString ?? "0");
      console.log("Seller SOL after:", sellerSolAfter);
      console.log("Treasury SOL after:", treasuryAfter);
      console.log("Seller SOL delta:", sellerSolAfter - sellerSolBefore);

      if (tokenBalAfter.value.amount !== "0") {
        throw new Error(
          `Drain incomplete. Remaining raw token amount=${tokenBalAfter.value.amount}`
        );
      }

      console.log("✅ Sold entire wallet token balance through AMM");
    } finally {
      try {
        await connection.removeOnLogsListener(logsSub);
      } catch {
        // ignore
      }
    }
  });
});
