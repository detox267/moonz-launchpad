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

function prettyPk(x: any) {
  try {
    if (!x) return String(x);
    if (typeof x === "string") return x;
    if (x instanceof PublicKey) return x.toBase58();
    if (x.publicKey && x.publicKey instanceof PublicKey) return x.publicKey.toBase58();
    return String(x);
  } catch {
    return String(x);
  }
}

function dumpAnchorErr(e: any) {
  console.log("\n========== TX FAILED ==========");
  console.log("name:", e?.name);
  console.log("message:", e?.message);

  // Anchor v0.30+ often has these:
  if (e?.error) console.log("error:", e.error);
  if (e?.error?.errorMessage) console.log("errorMessage:", e.error.errorMessage);
  if (e?.error?.errorCode) console.log("errorCode:", e.error.errorCode);

  // Solana logs:
  if (e?.logs) {
    console.log("\n--- logs ---");
    for (const l of e.logs) console.log(l);
  } else if (e?.error?.logs) {
    console.log("\n--- error.logs ---");
    for (const l of e.error.logs) console.log(l);
  }

  // Sometimes Anchor puts it here:
  if (e?.simulationResponse?.value?.logs) {
    console.log("\n--- simulationResponse.value.logs ---");
    for (const l of e.simulationResponse.value.logs) console.log(l);
  }

  console.log("================================\n");
}

describe("aaped-launch initialize only (FULL LOG)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AapedLaunch as Program<AapedLaunch>;

  it("Initializes launch correctly (with full simulate + logs)", async () => {
    const payer = provider.wallet as anchor.Wallet;

    console.log("\n========== ENV ==========");
    console.log("cluster:", provider.connection.rpcEndpoint);
    console.log("programId:", program.programId.toBase58());
    console.log("payer:", payer.publicKey.toBase58());
    console.log("=========================\n");

    // 1) Create mint
    const mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    // 2) Mint receiver ATA
    const mintReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );

    // 3) Derive PDAs
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

    const saleVault = Keypair.generate();
    const lpVault = Keypair.generate();

    // Params (log EXACT)
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

    // Accounts (log EXACT)
    const accounts = {
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
    };

    console.log("\n========== INPUTS ==========");
    console.log("mint:", mint.toBase58());
    console.log("mintReceiver ATA:", mintReceiver.address.toBase58());
    console.log("launchStatePda:", launchStatePda.toBase58());
    console.log("treasurySolVault:", treasurySolVault.toBase58());
    console.log("creatorSolVault:", creatorSolVault.toBase58());
    console.log("platformSolVault:", platformSolVault.toBase58());
    console.log("saleVault (kp):", saleVault.publicKey.toBase58());
    console.log("lpVault   (kp):", lpVault.publicKey.toBase58());

    console.log("\nparams:", {
      ...params,
      creator: params.creator.toBase58(),
      platform: params.platform.toBase58(),
      // BNs as strings:
      totalSupply: params.totalSupply.toString(),
      saleSupply: params.saleSupply.toString(),
      lpSupply: params.lpSupply.toString(),
      vSol: params.vSol.toString(),
      vTok: params.vTok.toString(),
      tailStart: params.tailStart.toString(),
      tailEnd: params.tailEnd.toString(),
      migrationSolTarget: params.migrationSolTarget.toString(),
    });

    console.log("\naccounts:", Object.fromEntries(
      Object.entries(accounts).map(([k, v]) => [k, prettyPk(v)])
    ));
    console.log("=============================\n");

    // OPTIONAL: give yourself compute headroom (harmless for init)
    const cuLimitIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const cuPriceIx = anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

    const builder = program.methods
      .initializeLaunch(params as any)
      .accounts(accounts as any)
      .signers([saleVault, lpVault])
      .preInstructions([cuLimitIx, cuPriceIx]);

    // 1) SIMULATE FIRST (prints the real reason)
    console.log("---- SIMULATING initializeLaunch ----");
    try {
      const sim = await builder.simulate();
      if (sim?.logs?.length) {
        console.log("\n--- SIM LOGS ---");
        for (const l of sim.logs) console.log(l);
      } else {
        console.log("No sim logs returned.");
      }
      console.log("---- SIM OK ----\n");
    } catch (e: any) {
      console.log("---- SIM FAILED ----");
      dumpAnchorErr(e);
      throw e; // stop here, don’t bother sending
    }

    // 2) SEND TX
    console.log("---- SENDING initializeLaunch ----");
    let sig: string;
    try {
      sig = await builder.rpc({ skipPreflight: false });
      console.log("tx sig:", sig);
      console.log("---- SENT ----\n");
    } catch (e: any) {
      console.log("---- SEND FAILED ----");
      dumpAnchorErr(e);
      throw e;
    }

    // 3) FETCH STATE + MINT INFO
    console.log("---- FETCHING STATE ----");
    const state = await program.account.launchState.fetch(launchStatePda);

    console.log("State.mint:", state.mint.toBase58());
    console.log("State.saleSupply:", state.saleSupply.toString());
    console.log("State.lpSupply:", state.lpSupply.toString());
    console.log("State.saleVault:", state.saleVault.toBase58());
    console.log("State.lpVault:", state.lpVault.toBase58());
    console.log("State.treasurySolVault:", state.treasurySolVault.toBase58());
    console.log("State.creatorSolVault:", state.creatorSolVault.toBase58());
    console.log("State.platformSolVault:", state.platformSolVault.toBase58());
    console.log("State.state(phase):", state.state);

    console.log("---- CHECKING MINT AUTHORITY ----");
    const mintInfo = await getMint(provider.connection, mint);
    console.log("mintAuthority:", mintInfo.mintAuthority);
    console.log("freezeAuthority:", mintInfo.freezeAuthority);

    if (mintInfo.mintAuthority !== null) throw new Error("Mint authority NOT revoked");
    if (mintInfo.freezeAuthority !== null) throw new Error("Freeze authority NOT revoked");

    console.log("\n✅ Initialize test PASSED\n");
  });
});
