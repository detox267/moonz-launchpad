import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import https from "https";

const DRPC_URL =
  "https://lb.drpc.live/solana-devnet/Am6pYdWf80Uoozn_L8sqt8w9-8tvQSYR8JtruuQ63qxe";

// CHANGE ME if you want
const RECIPIENT = new PublicKey("6t6zr2VA9MbZM4gpJ1Yit6YgDi6r2uozqKNtxCcQRJj4");
const SEND_SOL = 0.01;

function postJsonRpc(urlStr: string, body: any): Promise<any> {
  const u = new URL(urlStr);

  const payload = JSON.stringify(body);

  const options: https.RequestOptions = {
    hostname: u.hostname, // IMPORTANT: no https://
    path: u.pathname + u.search, // IMPORTANT: includes /solana-devnet/<key>
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${String(e)}\nRaw: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("drpc-send-legacy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Use SAME DRPC endpoint for blockhash + confirmation calls
  const connection = new Connection(DRPC_URL, "confirmed");

  it("builds legacy tx, sends via DRPC sendTransaction, then confirms", async function () {
    this.timeout(120_000);

    // Load your CLI wallet
    const secret = JSON.parse(fs.readFileSync("/root/.config/solana/id.json", "utf8"));
    const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

    console.log("RPC:", DRPC_URL);
    console.log("Wallet:", payer.publicKey.toBase58());

    const bal = await connection.getBalance(payer.publicKey, "confirmed");
    console.log("Balance:", (bal / LAMPORTS_PER_SOL).toFixed(6), "SOL");

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    console.log("blockhash:", blockhash);
    console.log("lastValidBlockHeight:", lastValidBlockHeight);

    const lamports = Math.round(SEND_SOL * LAMPORTS_PER_SOL);

    // Build LEGACY tx
    const tx = new Transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: RECIPIENT,
        lamports,
      })
    );

    tx.sign(payer);

    const raw = tx.serialize();
    const b64 = raw.toString("base64");

    console.log("sending:", SEND_SOL, "SOL =>", RECIPIENT.toBase58());
    console.log("serialized bytes:", raw.length);

    // OPTIONAL: simulate via JSON-RPC directly (helps diagnose)
    const simResp = await postJsonRpc(DRPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        b64,
        {
          encoding: "base64",
          sigVerify: false,
          commitment: "processed",
          replaceRecentBlockhash: false,
        },
      ],
    });

    if (simResp?.error) {
      console.log("simulateTransaction error:", simResp.error);
      throw new Error(`simulateTransaction RPC error: ${JSON.stringify(simResp.error)}`);
    }

    const simVal = simResp?.result?.value;
    console.log("simulate err:", simVal?.err ?? null);
    if (Array.isArray(simVal?.logs)) {
      console.log("simulate logs:");
      for (const l of simVal.logs) console.log("  ", l);
    }
    if (simVal?.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(simVal.err)}`);
    }

    // SEND via DRPC JSON-RPC
    const sendResp = await postJsonRpc(DRPC_URL, {
      jsonrpc: "2.0",
      id: 2,
      method: "sendTransaction",
      params: [
        b64,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 5,
        },
      ],
    });

    if (sendResp?.error) {
      console.log("sendTransaction error:", sendResp.error);
      throw new Error(`sendTransaction RPC error: ${JSON.stringify(sendResp.error)}`);
    }

    const sig = sendResp?.result as string;
    if (!sig || typeof sig !== "string") {
      throw new Error(`Unexpected sendTransaction result: ${JSON.stringify(sendResp)}`);
    }

    console.log("tx sig:", sig);

    // Confirm using blockhash context (prevents blockheight exceeded confusion)
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    console.log("confirm:", conf.value);
    if (conf.value.err) throw new Error(`On-chain failure: ${JSON.stringify(conf.value.err)}`);
  });
});
