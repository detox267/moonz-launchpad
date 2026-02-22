import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getMint } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AapedLaunch } from "../target/types/aaped_launch";

// ---- CONFIG ----
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=b9def4e2-ecb7-4d4f-b30f-4437c21842cb";

// For most providers, ws is wss:// + same host/path
const WS_URL = RPC_URL.replace("https://", "wss://");

const PLATFORM_WALLET = new PublicKey(
  "BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL"
);

const MPL_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function defaultPlatformKeypairPath(): string {
  // Expand "~/.config/solana/id.json" -> "/home/<user>/.config/solana/id.json"
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

describe("initialize-launch (3 tx flow) + events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // IMPORTANT: set wsEndpoint so onLogs actually works reliably
  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: WS_URL,
  });

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("TX1 -> TX2 -> TX3 (platform mint authority) + logsSubscribe", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;

    // -----------------------------
    // Load PLATFORM mint authority signer
    // Default: ~/.config/solana/id.json
    // Optional override: PLATFORM_KEYPAIR=/path/to/keypair.json
    // -----------------------------
    const kpPath = process.env.PLATFORM_KEYPAIR || defaultPlatformKeypairPath();

    if (!fs.existsSync(kpPath)) {
      throw new Error(
        `Platform keypair file not found: ${kpPath}\n` +
          `Set PLATFORM_KEYPAIR to override, or ensure ~/.config/solana/id.json exists.`
      );
    }

    const platformSigner = loadKeypair(kpPath);

    if (!platformSigner.publicKey.equals(PLATFORM_WALLET)) {
      throw new Error(
        `Platform keypair mismatch.\n` +
          `Path:     ${kpPath}\n` +
          `Expected: ${PLATFORM_WALLET.toBase58()}\n` +
          `Got:      ${platformSigner.publicKey.toBase58()}`
      );
    }

    console.log("RPC:", RPC_URL);
    console.log("WS:", WS_URL);
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("Platform (mint authority):", platformSigner.publicKey.toBase58());
    console.log("Platform keypair path:", kpPath);

    const bal = await connection.getBalance(payer.publicKey);
    console.log("Payer Balance:", bal / LAMPORTS_PER_SOL, "SOL");

    // -----------------------------
    // Subscribe to program logs (captures emit! events)
    // -----------------------------
    const subId = connection.onLogs(
      program.programId,
      (ev) => {
        console.log("\n================= PROGRAM LOGS =================");
        console.log("Signature:", ev.signature);
        for (const line of ev.logs) console.log(line);
      },
      "confirmed"
    );

    try {
      // ---------------------------------------
      // 1️⃣ CREATE MINT (platform is authority)
      // ---------------------------------------
      const mint = await createMint(
        connection,
        payer, // fee payer for creating the mint account
        platformSigner.publicKey, // mint authority = platform
        platformSigner.publicKey, // freeze authority = platform
        6
      );

      console.log("Mint:", mint.toBase58());

      // ---------------------------------------
      // 2️⃣ Derive PDAs
      // ---------------------------------------
      const [launchStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("launch_state"), mint.toBuffer()],
        program.programId
      );

      const [treasurySolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_sol"), mint.toBuffer()],
        program.programId
      );

      const [creatorSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_sol"), mint.toBuffer()],
        program.programId
      );

      const [platformSolVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("platform_sol"), mint.toBuffer()],
        program.programId
      );

      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        MPL_PROGRAM_ID
      );

      const saleVault = Keypair.generate();
      const lpVault = Keypair.generate();

      const fakeName = "AAPED TEST";
      const fakeSymbol = "AAPED";
      const fakeUri = "https://example.com/aaped/meta.json";

      // NOTE:
      // - params.platform MUST equal PLATFORM_WALLET (hardcoded validation)
      // - ctx.accounts.mintAuthority MUST equal PLATFORM_WALLET (your new enforcement)
      const params = {
        creator: payer.publicKey,
        platform: PLATFORM_WALLET,
        coreAuthority: payer.publicKey,

        totalSupply: new anchor.BN("1000000000000000"),
        saleSupply: new anchor.BN("600000000000000"),
        lpSupply: new anchor.BN("400000000000000"),

        vSol: new anchor.BN("30000000000"),
        vTok: new anchor.BN("526200000000000"),

        migrationSolTarget: new anchor.BN((89 * LAMPORTS_PER_SOL).toString()),

        feeTotalBps: 125,
        feeCreatorBps: 80,
        feePlatformBps: 20,
        feeLpGrowthBps: 25,

        name: fakeName,
        symbol: fakeSymbol,
        uri: fakeUri,
      };

      // ---------------------------------------
      // TX1 initialize_launch
      // MUST be signed by platformSigner
      // ---------------------------------------
      const sig1 = await program.methods
        .initializeLaunch(params as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          saleVault: saleVault.publicKey,
          lpVault: lpVault.publicKey,
          treasurySolVault,
          creatorSolVault,
          platformSolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner, saleVault, lpVault])
        .rpc();

      console.log("TX1 sig:", sig1);

      const st1: any = await program.account.launchState.fetch(launchStatePda);
      if (!st1.metadata.equals(metadataPda)) throw new Error("Metadata PDA mismatch");

      // ---------------------------------------
      // TX2 initialize_metadata
      // MUST be signed by platformSigner (mint authority)
      // ---------------------------------------
      const sig2 = await program.methods
        .initializeMetadata({
          name: fakeName,
          symbol: fakeSymbol,
          uri: fakeUri,
        } as any)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenMetadataProgram: MPL_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([platformSigner])
        .rpc();

      console.log("TX2 sig:", sig2);

      // ---------------------------------------
      // TX3 finalize_mint_authorities
      // MUST be signed by platformSigner (current authority)
      // ---------------------------------------
      const sig3 = await program.methods
        .finalizeMintAuthorities()
        .accounts({
          mintAuthority: platformSigner.publicKey,
          mint,
          launchState: launchStatePda,
          metadata: metadataPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([platformSigner])
        .rpc();

      console.log("TX3 sig:", sig3);

      // ---------------------------------------
      // VERIFY AUTHORITIES REVOKED
      // ---------------------------------------
      const mintInfo = await getMint(connection, mint);

      console.log("mintAuthority:", mintInfo.mintAuthority?.toBase58() || null);
      console.log("freezeAuthority:", mintInfo.freezeAuthority?.toBase58() || null);

      if (mintInfo.mintAuthority !== null) throw new Error("Mint authority NOT revoked");
      if (mintInfo.freezeAuthority !== null) throw new Error("Freeze authority NOT revoked");
    } finally {
      await connection.removeOnLogsListener(subId);
    }
  });
});
