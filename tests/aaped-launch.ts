import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AapedLaunch } from "../target/types/aaped_launch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getMint,
} from "@solana/spl-token";

function dumpAnchorError(e: any) {
  console.log("\n=========== TX ERROR ===========");
  console.log("name:", e?.name);
  console.log("message:", e?.message);

  // Anchor often attaches logs here:
  if (e?.logs) {
    console.log("\n--- logs ---");
    for (const l of e.logs) console.log(l);
  }

  // AnchorError sometimes has error + errorCode
  if (e?.error) {
    console.log("\n--- anchor error ---");
    console.log(JSON.stringify(e.error, null, 2));
  }

  // Sometimes the raw RPC response is here
  if (e?.response) {
    console.log("\n--- rpc response ---");
    console.log(JSON.stringify(e.response, null, 2));
  }

  console.log("================================\n");
}

describe("aaped-launch initialize only", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Initializes launch correctly (log everything)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    console.log("RPC:", provider.connection.rpcEndpoint);
    console.log("ProgramID:", program.programId.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());

    // 1) Create mint
    console.log("\n[1] createMint...");
    const mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );
    console.log("Mint:", mint.toBase58());

    // 2) Mint receiver ATA
    console.log("\n[2] getOrCreateAssociatedTokenAccount (mintReceiver)...");
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );
    console.log("MintReceiver ATA:", mintReceiver.address.toBase58());

    // 3) Derive PDAs
    console.log("\n[3] derive PDAs...");
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

    console.log("launchStatePda:", launchStatePda.toBase58());
    console.log("treasurySolVault:", treasurySolVault.toBase58());
    console.log("creatorSolVault:", creatorSolVault.toBase58());
    console.log("platformSolVault:", platformSolVault.toBase58());

    // 4) vault accounts (these are INIT token accounts in your program)
    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();
    console.log("\n[4] saleVault keypair:", saleVault.publicKey.toBase58());
    console.log("[4] lpVault keypair  :", lpVault.publicKey.toBase58());

    const params = {
      creator: payer.publicKey,
      platform: payer.publicKey,

      totalSupply: new anchor.BN("1000000000000000"),
      saleSupply: new anchor.BN("600000000000000"),
      lpSupply: new anchor.BN("400000000000000"),

      vSol: new anchor.BN("30000000000"),
      vTok: new anchor.BN("526200000000000"),

      tailStart: new anchor.BN("583829673767736"),
      tailEnd: new anchor.BN("0"),

      migrationSolTarget: new anchor.BN("91000000000"),

      feeTotalBps: 125,
      feeCreatorBps: 80,
      feePlatformBps: 20,
      feeLpGrowthBps: 25,
    };

    console.log("\n[5] simulate first (to get logs even if rpc fails)...");
    try {
      const sim = await program.methods
        .initializeLaunch(params)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: payer.publicKey,
          mint,
          mintReceiver: mintReceiver.address,

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
        .signers([saleVault, lpVault])
        .simulate();

      console.log("SIM OK");
      if (sim?.logs?.length) {
        console.log("\n--- SIM LOGS ---");
        sim.logs.forEach((l: string) => console.log(l));
      }
    } catch (e: any) {
      console.log("SIM FAILED (this is the real error).");
      dumpAnchorError(e);
      throw e;
    }

    console.log("\n[6] send tx...");
    let sig: string;
    try {
      sig = await program.methods
        .initializeLaunch(params)
        .accounts({
          payer: payer.publicKey,
          mintAuthority: payer.publicKey,
          mint,
          mintReceiver: mintReceiver.address,

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
        .signers([saleVault, lpVault])
        .rpc();

      console.log("TX SIG:", sig);
    } catch (e: any) {
      console.log("RPC FAILED.");
      dumpAnchorError(e);
      throw e;
    }

    console.log("\n[7] fetch state...");
    const state = await program.account.launchState.fetch(launchStatePda);
    console.log("State.mint:", state.mint.toBase58());
    console.log("State.saleSupply:", state.saleSupply.toString());
    console.log("State.lpSupply:", state.lpSupply.toString());

    console.log("\n[8] verify mint authority revoked...");
    const mintInfo = await getMint(provider.connection, mint);
    console.log("Mint authority:", mintInfo.mintAuthority);

    if (mintInfo.mintAuthority !== null) {
      throw new Error("Mint authority NOT revoked");
    }

    console.log("\n✅ Initialize test PASSED");
  });
});
