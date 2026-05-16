/**
 * Axis Vault — E2E Test on Devnet
 * Tests: create_etf → deposit (mint ETF tokens) → withdraw (burn ETF tokens)
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, createAccount, createInitializeAccountInstruction,
  mintTo, getAccount, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, MINT_SIZE,
  getMinimumBalanceForRentExemptAccount, getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "DeeUnCHcnPG8arbjGTLhTKeDhpPUBper3TDrpFPHnCwy");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ETF_NAME = process.env.ETF_NAME ?? `AX${Date.now().toString(36).toUpperCase().slice(-10)}`;
// Ticker: ASCII upper/digits only, 2..=10 bytes (v1.1, was 2..=16 in v1.0).
// 10 matches Metaplex MAX_SYMBOL_LENGTH so the inner CPI can't reject late
// with `SymbolTooLong`.
const ETF_TICKER = process.env.ETF_TICKER ?? `AX${Date.now().toString(36).toUpperCase().slice(-4)}`;
// v1.1: Metaplex Token Metadata URI. Empty string is valid and produces a
// metadata account with no off-chain JSON pointer. Default stays empty so
// the local validator doesn't need to reach off-host.
const ETF_URI = process.env.ETF_URI ?? "";
// Metaplex Token Metadata Program ID — same on mainnet, devnet, localnet.
const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);
const TOKEN_COUNT = 3;
const WEIGHTS = [3334, 3333, 3333]; // ~33.3% each, sums to 10000

// Offsets in EtfState — confirmed via `cargo test print_sizes -- --nocapture`.
// total_supply at 408 is unchanged across #37; name/ticker/created_at_slot
// are appended after bump.
const OFFSET_TOTAL_SUPPLY = 408;
const OFFSET_NAME = 452;
const OFFSET_TICKER = 484;
const OFFSET_CREATED_AT_SLOT = 504;

function loadPayer(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"))));
}
function u64Le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function u16Le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }

async function getCU(conn: Connection, sig: string): Promise<number | null> {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  return tx?.meta?.computeUnitsConsumed ?? null;
}

/// v1.1: derive the Metaplex Token Metadata PDA and append the trailing
/// `[uri_len][uri]` bytes + the two new accounts (metadata_pda,
/// metaplex_program). Use for every hand-rolled CreateEtf in this file.
function metadataPdaFor(etfMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      etfMint.toBuffer(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  )[0];
}
const URI_LEN_ZERO = Buffer.from([0]); // empty URI is valid (v1.1)
function v1_1MetaKeys(etfMint: PublicKey) {
  return [
    { pubkey: metadataPdaFor(etfMint), isSigner: false, isWritable: true },
    { pubkey: METAPLEX_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();

  console.log("=== Axis Vault E2E Test (Devnet) ===");
  console.log("Wallet:", payer.publicKey.toBase58());
  console.log("ETF Name:", ETF_NAME);
  console.log("Balance:", (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL\n");

  // 1. Create basket token mints + user accounts
  console.log("> Creating 3 basket tokens...");
  const mints: PublicKey[] = [];
  const userTokens: PublicKey[] = [];
  for (let i = 0; i < TOKEN_COUNT; i++) {
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    mints.push(mint);
    const ata = await createAccount(conn, payer, mint, payer.publicKey);
    await mintTo(conn, payer, mint, ata, payer, 100_000_000_000n);
    userTokens.push(ata);
  }

  // 2. Derive ETF state PDA
  const nameBytes = Buffer.from(ETF_NAME);
  const [etfState, etfBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("etf"), payer.publicKey.toBuffer(), nameBytes],
    PROGRAM_ID
  );
  console.log("ETF State PDA:", etfState.toBase58());

  // 3. Create ETF mint account (uninitialized — program will call InitializeMint2)
  const etfMintKp = Keypair.generate();
  const mintRent = await getMinimumBalanceForRentExemptMint(conn);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: etfMintKp.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    })
  ), [payer, etfMintKp]);
  console.log("ETF Mint:", etfMintKp.publicKey.toBase58());

  // 4. Create vault accounts (uninitialized — program will call InitializeAccount3)
  const vaultKps: Keypair[] = [];
  const vaults: PublicKey[] = [];
  const vaultRent = await getMinimumBalanceForRentExemptAccount(conn);
  const createVaultsTx = new Transaction();
  for (let i = 0; i < TOKEN_COUNT; i++) {
    const kp = Keypair.generate();
    vaultKps.push(kp);
    vaults.push(kp.publicKey);
    createVaultsTx.add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports: vaultRent,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }));
  }
  await sendAndConfirmTransaction(conn, createVaultsTx, [payer, ...vaultKps]);

  // 5. Create treasury keypair (separate from depositor to avoid ATA collision)
  const treasuryKp = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasuryKp.publicKey, lamports: LAMPORTS_PER_SOL / 10 })
  ), [payer]);

  // 6. CreateEtf (v1.1: ticker before name, uri appended; metadata PDA
  //    + Metaplex program tail-appended to accounts).
  console.log("\n> CreateEtf");
  const tickerBytes = Buffer.from(ETF_TICKER);
  const uriBytes = Buffer.from(ETF_URI);
  const weightsBuf = Buffer.alloc(TOKEN_COUNT * 2);
  for (let i = 0; i < TOKEN_COUNT; i++) weightsBuf.writeUInt16LE(WEIGHTS[i], i * 2);

  // Metaplex metadata PDA: [b"metadata", METAPLEX_PROGRAM_ID, etf_mint].
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      etfMintKp.publicKey.toBuffer(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  );

  const createData = Buffer.concat([
    Buffer.from([0]),                   // disc = CreateEtf
    Buffer.from([TOKEN_COUNT]),         // token_count
    weightsBuf,                         // weights
    Buffer.from([tickerBytes.length]),  // ticker_len
    tickerBytes,                        // ticker
    Buffer.from([nameBytes.length]),    // name_len
    nameBytes,                          // name
    Buffer.from([uriBytes.length]),     // uri_len (v1.1)
    uriBytes,                           // uri (v1.1)
  ]);

  const createSig = await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: etfState, isSigner: false, isWritable: true },
      { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: false }, // treasury
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // basket mints
      ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
      // vault accounts
      ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      // v1.1: Metaplex metadata PDA (created by CPI) + Metaplex program
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: METAPLEX_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: createData,
  })), [payer]);
  console.log("  CU:", await getCU(conn, createSig));
  console.log("  Metadata PDA:", metadataPda.toBase58());

  // Verify ETF state (#37: also check stored metadata).
  const etfInfo = await conn.getAccountInfo(etfState);
  const totalSupply = etfInfo!.data.readBigUInt64LE(OFFSET_TOTAL_SUPPLY);
  const storedName = etfInfo!.data
    .subarray(OFFSET_NAME, OFFSET_NAME + 32)
    .toString("utf8")
    .replace(/\0+$/, "");
  const storedTicker = etfInfo!.data
    .subarray(OFFSET_TICKER, OFFSET_TICKER + 16)
    .toString("ascii")
    .replace(/\0+$/, "");
  const storedCreatedAt = etfInfo!.data.readBigUInt64LE(OFFSET_CREATED_AT_SLOT);
  if (storedName !== ETF_NAME) {
    throw new Error(`Stored name mismatch: on-chain='${storedName}' expected='${ETF_NAME}'`);
  }
  if (storedTicker !== ETF_TICKER) {
    throw new Error(`Stored ticker mismatch: on-chain='${storedTicker}' expected='${ETF_TICKER}'`);
  }
  if (storedCreatedAt === 0n) {
    throw new Error(`created_at_slot is 0 — should be captured from Clock sysvar`);
  }
  console.log("  Total supply:", totalSupply.toString());
  console.log(`  Stored metadata: ticker='${storedTicker}', name='${storedName}', slot=${storedCreatedAt}`);

  // 7. Create user's ETF token account + treasury ETF token account
  const userEtfAta = await createAccount(conn, payer, etfMintKp.publicKey, payer.publicKey);
  const treasuryEtfAta = await createAccount(conn, payer, etfMintKp.publicKey, treasuryKp.publicKey);

  // 7. Deposit — deposit 1000 tokens (base amount, scaled by weights)
  console.log("\n> Deposit (1000 base amount)");
  const depositData = Buffer.concat([
    Buffer.from([1]),                     // disc = Deposit
    u64Le(1_000_000_000n),               // amount (1000 tokens with 6 decimals)
    u64Le(0n),                           // min_mint_out (0 = no slippage check)
    Buffer.from([nameBytes.length]),
    nameBytes,
  ]);

  const depositSig = await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: etfState, isSigner: false, isWritable: true },
      { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: userEtfAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: treasuryEtfAta, isSigner: false, isWritable: true }, // treasury ETF ATA
      // user basket token accounts (source)
      ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      // vault accounts (destination)
      ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
    ],
    data: depositData,
  })), [payer]);
  console.log("  CU:", await getCU(conn, depositSig));

  // Check ETF token balance
  const etfBalance = (await getAccount(conn, userEtfAta)).amount;
  console.log("  ETF tokens minted:", etfBalance.toString());

  // Check vault balances
  for (let i = 0; i < TOKEN_COUNT; i++) {
    const vaultBal = (await getAccount(conn, vaults[i])).amount;
    console.log(`  Vault ${i} balance: ${vaultBal.toLocaleString()}`);
  }

  // Fee assertion: first deposit is 1_000_000_000 base; fee_bps=30 (0.3%)
  // so treasury should hold 3_000_000 ETF tokens. Because this is the
  // first deposit into a fresh ETF, MINIMUM_LIQUIDITY (=1_000) is also
  // locked virtually in total_supply — so the user receives
  // 1_000_000_000 - 3_000_000 (fee) - 1_000 (lock) = 996_999_000. The
  // MINIMUM_LIQUIDITY tokens are not minted to any holder; they're just
  // counted in total_supply to keep proportional math bounded (see
  // issue #35 / constants.rs).
  {
    const treasuryBal = (await getAccount(conn, treasuryEtfAta)).amount;
    const expectedFee = 3_000_000n;
    const expectedNet = 996_999_000n;
    if (treasuryBal !== expectedFee) {
      throw new Error(`Deposit fee mismatch: treasury=${treasuryBal}, expected=${expectedFee}`);
    }
    if (etfBalance !== expectedNet) {
      throw new Error(`Net mint mismatch: user=${etfBalance}, expected=${expectedNet}`);
    }
    console.log(`  Treasury fee received: ${treasuryBal} (30 bps of 1_000_000_000)`);
    console.log(`  MINIMUM_LIQUIDITY locked: 1_000 (virtual, never withdrawable)`);
  }

  // 8. Withdraw — burn half the ETF tokens
  const burnAmount = etfBalance / 2n;
  console.log(`\n> Withdraw (burn ${burnAmount} ETF tokens)`);
  const withdrawData = Buffer.concat([
    Buffer.from([2]),                     // disc = Withdraw
    u64Le(burnAmount),
    u64Le(0n),                           // min_tokens_out (0 = no slippage check)
    Buffer.from([nameBytes.length]),
    nameBytes,
  ]);

  const beforeBalances: bigint[] = [];
  for (let i = 0; i < TOKEN_COUNT; i++) {
    beforeBalances.push((await getAccount(conn, userTokens[i])).amount);
  }

  const withdrawSig = await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: etfState, isSigner: false, isWritable: true },
      { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: userEtfAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: treasuryEtfAta, isSigner: false, isWritable: true }, // treasury ETF ATA (fee recipient)
      // vault accounts (source)
      ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      // user basket token accounts (destination)
      ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
    ],
    data: withdrawData,
  })), [payer]);
  console.log("  CU:", await getCU(conn, withdrawSig));

  // Check what was returned
  const etfAfter = (await getAccount(conn, userEtfAta)).amount;
  console.log("  ETF tokens remaining:", etfAfter.toString());
  for (let i = 0; i < TOKEN_COUNT; i++) {
    const after = (await getAccount(conn, userTokens[i])).amount;
    const received = after - beforeBalances[i];
    console.log(`  Token ${i} received back: ${received.toLocaleString()}`);
  }

  // Withdraw fee assertion: etfBalance=996_999_000 (post-#35 MINIMUM_LIQUIDITY
  // lock), so burnAmount = etfBalance/2 = 498_499_500. fee_bps=30 →
  // fee = floor(498_499_500 * 30 / 10_000) = 1_495_498 (Rust integer
  // div on 14_954_985_000 / 10_000 truncates the .5). Treasury already
  // had 3_000_000 from Deposit, so its balance should now be
  // 3_000_000 + 1_495_498 = 4_495_498. Asserting the delta proves the
  // withdraw fee transfer actually hit the treasury.
  {
    const treasuryBalAfter = (await getAccount(conn, treasuryEtfAta)).amount;
    const expected = 4_495_498n;
    if (treasuryBalAfter !== expected) {
      throw new Error(`Withdraw fee mismatch: treasury=${treasuryBalAfter}, expected=${expected}`);
    }
    console.log(`  Treasury total after withdraw fee: ${treasuryBalAfter}`);
  }

  // 9. Test: CreateEtf with duplicate mints → DuplicateMint error (9011 / 0x2333)
  console.log("\n> Test: CreateEtf with duplicate mints (expect error)");
  try {
    const dupName = Buffer.from("DUPTEST");
    const [dupEtfState] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), dupName],
      PROGRAM_ID,
    );

    // Create a fresh ETF mint (uninitialized) for the dup test
    const dupMintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: dupMintKp.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      })
    ), [payer, dupMintKp]);

    // Create 3 vault accounts for the dup basket
    const dupVaultKps: Keypair[] = [];
    const dupVaults: PublicKey[] = [];
    const dupVaultsTx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      dupVaultKps.push(kp);
      dupVaults.push(kp.publicKey);
      dupVaultsTx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports: vaultRent,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, dupVaultsTx, [payer, ...dupVaultKps]);

    // Use mints[0] twice: [mints[0], mints[0], mints[2]]
    const dupMints = [mints[0], mints[0], mints[2]];
    const dupWeights = [3334, 3333, 3333];
    const dupWeightsBuf = Buffer.alloc(TOKEN_COUNT * 2);
    for (let i = 0; i < TOKEN_COUNT; i++) dupWeightsBuf.writeUInt16LE(dupWeights[i], i * 2);

    const dupTicker = Buffer.from("DUP1");
    const dupCreateData = Buffer.concat([
      Buffer.from([0]),                 // disc = CreateEtf
      Buffer.from([TOKEN_COUNT]),       // token_count
      dupWeightsBuf,                    // weights
      Buffer.from([dupTicker.length]),  // ticker_len
      dupTicker,                        // ticker
      Buffer.from([dupName.length]),    // name_len
      dupName,                          // name
      URI_LEN_ZERO,                     // v1.1: empty uri
    ]);

    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: dupEtfState, isSigner: false, isWritable: true },
        { pubkey: dupMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // basket mints (with duplicate)
        ...dupMints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        // vault accounts
        ...dupVaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(dupMintKp.publicKey),
      ],
      data: dupCreateData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // DuplicateMint = 9011 = 0x2333
    if (msg.includes("0x2333") || msg.includes("9011")) {
      console.log("  Correctly rejected with DuplicateMint error:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9011");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("CreateEtf with duplicate mints should have failed but succeeded");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 10. Test: Withdraw more than total_supply → Overflow / InsufficientBalance error
  console.log("\n> Test: Withdraw exceeding total_supply (expect error)");
  try {
    const hugeAmount = 999_999_999_999_999n;
    const badWithdrawData = Buffer.concat([
      Buffer.from([2]),
      u64Le(hugeAmount),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);

    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: badWithdrawData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // Accept Overflow (9007 / 0x232F) or InsufficientBalance (9005 / 0x232D)
    if (msg.includes("0x232f") || msg.includes("0x232d") || msg.includes("9007") || msg.includes("9005")) {
      console.log("  Correctly rejected with error:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "overflow/insufficient");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Withdraw with huge amount should have failed but succeeded");
    } else {
      // Any other program error is acceptable — the point is it must not succeed
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 11. Test: Deposit with wrong etf_mint → MintMismatch (9009 / 0x2331)
  console.log("\n> Test: Deposit with wrong etf_mint (expect MintMismatch)");
  try {
    const fakeMint = await createMint(conn, payer, payer.publicKey, null, 6);
    const badDepositData = Buffer.concat([
      Buffer.from([1]),
      u64Le(100_000_000n),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: fakeMint, isSigner: false, isWritable: true }, // WRONG mint
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: badDepositData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // MintMismatch = 9009 = 0x2331
    if (msg.includes("0x2331") || msg.includes("9009")) {
      console.log("  Correctly rejected with MintMismatch:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9009");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Deposit with wrong etf_mint should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 12. Test: Deposit with wrong vault → VaultMismatch (9013 / 0x2335)
  console.log("\n> Test: Deposit with wrong vault account (expect VaultMismatch)");
  try {
    // Use vaults[1] at slot 0 — valid token account, owned by the real
    // EtfState PDA, so SPL token pre-checks pass and my VaultMismatch
    // guard (which checks slot key against stored token_vaults[0]) fires
    // first. Using a payer-owned fake vault here causes SPL Token to
    // reject with "Provided owner is not allowed" before my check runs.
    const wrongVaults = [vaults[1], vaults[1], vaults[2]];
    const badDepositData = Buffer.concat([
      Buffer.from([1]),
      u64Le(100_000_000n),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...wrongVaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: badDepositData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // VaultMismatch = 9013 = 0x2335
    if (msg.includes("0x2335") || msg.includes("9013")) {
      console.log("  Correctly rejected with VaultMismatch:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9013");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Deposit with wrong vault should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 13. Test: Withdraw with fake etf_state (wrong program owner) → InvalidProgramOwner (9014 / 0x2336)
  console.log("\n> Test: Withdraw with non-program-owned etf_state (expect InvalidProgramOwner)");
  try {
    // Any account not owned by the vault program — use the ETF mint account (owned by token program)
    const fakeState = etfMintKp.publicKey;
    const badWithdrawData = Buffer.concat([
      Buffer.from([2]),
      u64Le(1_000n),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: fakeState, isSigner: false, isWritable: true }, // WRONG: not program-owned
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: badWithdrawData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // InvalidProgramOwner = 9014 = 0x2336
    if (msg.includes("0x2336") || msg.includes("9014")) {
      console.log("  Correctly rejected with InvalidProgramOwner:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9014");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Withdraw with non-program-owned etf_state should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 14. Test: Second deposit (subsequent-depositor proportional-math path)
  // After Step 7 the pool had total_supply>0; Step 8 halved it. A third
  // deposit here must go through the `if total_supply != 0` branch and
  // mint proportional to vault balances (not the base-amount first-deposit path).
  console.log("\n> Test: Subsequent deposit hits proportional-math path");
  {
    const supplyBefore = (await getAccount(conn, userEtfAta)).amount;
    const totalSupplyBefore = (await conn.getAccountInfo(etfState))!.data.readBigUInt64LE(408);
    const secondDepositData = Buffer.concat([
      Buffer.from([1]),
      u64Le(500_000_000n),  // 500 tokens base
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: secondDepositData,
    })), [payer]);
    const supplyAfter = (await getAccount(conn, userEtfAta)).amount;
    const totalSupplyAfter = (await conn.getAccountInfo(etfState))!.data.readBigUInt64LE(408);
    const minted = supplyAfter - supplyBefore;
    if (minted === 0n || totalSupplyAfter <= totalSupplyBefore) {
      throw new Error(`Subsequent deposit didn't mint or total_supply didn't grow (minted=${minted}, before=${totalSupplyBefore}, after=${totalSupplyAfter})`);
    }
    console.log(`  Minted on 2nd deposit: ${minted}, total_supply: ${totalSupplyBefore} → ${totalSupplyAfter}`);
    console.log("  Correctly routed through proportional path");
  }

  // 15. Test: Withdraw with wrong etf_mint → MintMismatch (9009 / 0x2331)
  // Mirrors Test 11 on the Withdraw side. Must run while total_supply > 0,
  // otherwise the DivisionByZero check in withdraw.rs fires first.
  console.log("\n> Test: Withdraw with wrong etf_mint (expect MintMismatch)");
  try {
    const fakeMint = await createMint(conn, payer, payer.publicKey, null, 6);
    const badWithdrawData = Buffer.concat([
      Buffer.from([2]),
      u64Le(1_000n),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: fakeMint, isSigner: false, isWritable: true }, // WRONG mint
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: badWithdrawData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // MintMismatch = 9009 = 0x2331
    if (msg.includes("0x2331") || msg.includes("9009")) {
      console.log("  Correctly rejected with MintMismatch:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9009");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Withdraw with wrong etf_mint should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 16. Test: Withdraw with wrong vault → VaultMismatch (9013 / 0x2335)
  // Mirrors Test 12 on the Withdraw side. Withdraw's account layout puts
  // vaults in [5..5+N] (opposite of Deposit), so swap the first vault here.
  console.log("\n> Test: Withdraw with wrong vault account (expect VaultMismatch)");
  try {
    // Same rationale as the Deposit wrong-vault test: swap to vaults[1]
    // at slot 0 so SPL Token accepts the account and my VaultMismatch
    // guard is what fires.
    const wrongVaults = [vaults[1], vaults[1], vaults[2]];
    const badWithdrawData = Buffer.concat([
      Buffer.from([2]),
      u64Le(1_000n),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...wrongVaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: badWithdrawData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // VaultMismatch = 9013 = 0x2335
    if (msg.includes("0x2335") || msg.includes("9013")) {
      console.log("  Correctly rejected with VaultMismatch:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9013");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Withdraw with wrong vault should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // TODO(#33 follow-up): Once axis-vault exposes a SetPaused instruction,
  // add paused-pool tests for both Deposit and Withdraw. Expected behavior:
  // etf.paused != 0 → PoolPaused (9012 / 0x2334) on both code paths.

  // 16a. Test: Deposit with min_mint_out too high → SlippageExceeded (9015 / 0x2337)
  // Exercises the Deposit slippage guard. The expected mint is bounded by
  // the vault's proportional math; we set min_mint_out above any possible
  // result to force rejection without relying on price movement.
  console.log("\n> Test: Deposit with min_mint_out too high (expect SlippageExceeded)");
  try {
    const slipData = Buffer.concat([
      Buffer.from([1]),
      u64Le(100_000_000n),
      u64Le(999_999_999_999_999n), // unreachable min_mint_out
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: slipData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("0x2337") || msg.includes("9015")) {
      console.log("  Correctly rejected with SlippageExceeded:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9015");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Deposit with unreachable min_mint_out should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 16b. Test: Withdraw with min_tokens_out too high → SlippageExceeded (9015 / 0x2337)
  console.log("\n> Test: Withdraw with min_tokens_out too high (expect SlippageExceeded)");
  try {
    const slipData = Buffer.concat([
      Buffer.from([2]),
      u64Le(1_000n),                   // tiny burn → tiny total output
      u64Le(999_999_999_999_999n),     // unreachable min_tokens_out
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: slipData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("0x2337") || msg.includes("9015")) {
      console.log("  Correctly rejected with SlippageExceeded:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9015");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("Withdraw with unreachable min_tokens_out should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 16c. Test: Deposit with skewed vault balances → NavDeviationExceeded (9016 / 0x2338)
  // The Deposit NAV check bounds the spread between per-vault mint candidates.
  // We deliberately inflate vault[0]'s balance (by minting extra basket tokens
  // directly into it, bypassing the Deposit path) so the vault ratios no
  // longer match target weights; a subsequent Deposit must fail.
  console.log("\n> Test: Deposit with skewed vault balances (expect NavDeviationExceeded)");
  {
    // Inflate vault[0] by ~50 % so candidate[0] is materially lower than
    // candidate[1..]. Any spread > 3 % (MAX_NAV_DEVIATION_BPS=300) trips.
    const vault0BalBefore = (await getAccount(conn, vaults[0])).amount;
    const skewAmount = vault0BalBefore / 2n;
    await mintTo(conn, payer, mints[0], vaults[0], payer, skewAmount);
    try {
      const navData = Buffer.concat([
        Buffer.from([1]),
        u64Le(100_000_000n),
        u64Le(0n),
        Buffer.from([nameBytes.length]),
        nameBytes,
      ]);
      await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: etfState, isSigner: false, isWritable: true },
          { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: userEtfAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
          ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
          ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ],
        data: navData,
      })), [payer]);
      throw new Error("Should have failed but succeeded");
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes("0x2338") || msg.includes("9016")) {
        console.log("  Correctly rejected with NavDeviationExceeded:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9016");
      } else if (msg === "Should have failed but succeeded") {
        throw new Error("Deposit with skewed vault should have failed NavDeviation");
      } else {
        console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
      }
    }
  }

  // 17. Test: Full user-balance withdrawal → user goes to 0, total_supply
  // shrinks by effective_burn (post-fee). With the fee mechanism the fee
  // portion transfers to treasury rather than burning, so total_supply
  // retains the treasury's ETF balance plus the virtual MINIMUM_LIQUIDITY
  // lock set on the first deposit (#35). Invariant asserted:
  //   total_supply == treasury_etf_balance + MINIMUM_LIQUIDITY (=1_000)
  console.log("\n> Test: Full withdrawal; total_supply should equal treasury balance + MINIMUM_LIQUIDITY");
  {
    const remaining = (await getAccount(conn, userEtfAta)).amount;
    const fullWithdrawData = Buffer.concat([
      Buffer.from([2]),
      u64Le(remaining),
      u64Le(0n),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: userEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
      ],
      data: fullWithdrawData,
    })), [payer]);
    const etfEnd = (await getAccount(conn, userEtfAta)).amount;
    const treasuryEnd = (await getAccount(conn, treasuryEtfAta)).amount;
    const totalSupplyEnd = (await conn.getAccountInfo(etfState))!.data.readBigUInt64LE(408);
    if (etfEnd !== 0n) {
      throw new Error(`Full withdrawal left user ETF balance > 0: ${etfEnd}`);
    }
    const MINIMUM_LIQUIDITY = 1_000n;
    if (totalSupplyEnd !== treasuryEnd + MINIMUM_LIQUIDITY) {
      throw new Error(
        `Supply/treasury mismatch after full withdraw: supply=${totalSupplyEnd}, ` +
        `treasury=${treasuryEnd}, expected supply == treasury + ${MINIMUM_LIQUIDITY}`
      );
    }
    console.log(`  Burned ${remaining}; user=0, total_supply=${totalSupplyEnd} (== treasury + MIN_LIQ)`);
  }

  // 18. Test: CreateEtf with token_count < 2 → InvalidBasketSize (9002 / 0x232A)
  console.log("\n> Test: CreateEtf with token_count=1 (expect InvalidBasketSize)");
  try {
    const badName = Buffer.from("BADSIZE1");
    const [badPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), badName],
      PROGRAM_ID,
    );
    const badMintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: badMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, badMintKp]);
    const badVaultKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: badVaultKp.publicKey,
      lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, badVaultKp]);

    // token_count=1, weights=[10000] — valid weight sum but basket too small
    const badTicker = Buffer.from("BADSZ");
    const badData = Buffer.concat([
      Buffer.from([0]), Buffer.from([1]), u16Le(10000),
      Buffer.from([badTicker.length]), badTicker,
      Buffer.from([badName.length]), badName,
      URI_LEN_ZERO,                     // v1.1
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: badPda, isSigner: false, isWritable: true },
        { pubkey: badMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: mints[0], isSigner: false, isWritable: false },
        { pubkey: badVaultKp.publicKey, isSigner: false, isWritable: true },
        ...v1_1MetaKeys(badMintKp.publicKey),
      ],
      data: badData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // InvalidBasketSize = 9002 = 0x232A
    if (msg.includes("0x232a") || msg.includes("9002")) {
      console.log("  Correctly rejected with InvalidBasketSize:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9002");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("CreateEtf token_count=1 should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 19. Test: CreateEtf with weights summing ≠ 10_000 → WeightsMismatch (9003 / 0x232B)
  console.log("\n> Test: CreateEtf with weights summing to 9999 (expect WeightsMismatch)");
  try {
    const badName = Buffer.from("BADWT01");
    const [badPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), badName],
      PROGRAM_ID,
    );
    const badMintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: badMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, badMintKp]);
    const badVaultKps: Keypair[] = [];
    const badVaultsTx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      badVaultKps.push(kp);
      badVaultsTx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, badVaultsTx, [payer, ...badVaultKps]);

    // weights sum to 9999 (not 10000)
    const badWeights = [3333, 3333, 3333];
    const wbuf = Buffer.alloc(TOKEN_COUNT * 2);
    for (let i = 0; i < TOKEN_COUNT; i++) wbuf.writeUInt16LE(badWeights[i], i * 2);
    const badTicker = Buffer.from("BADWT");
    const badData = Buffer.concat([
      Buffer.from([0]), Buffer.from([TOKEN_COUNT]), wbuf,
      Buffer.from([badTicker.length]), badTicker,
      Buffer.from([badName.length]), badName,
      URI_LEN_ZERO,                     // v1.1
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: badPda, isSigner: false, isWritable: true },
        { pubkey: badMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        ...badVaultKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(badMintKp.publicKey),
      ],
      data: badData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // WeightsMismatch = 9003 = 0x232B
    if (msg.includes("0x232b") || msg.includes("9003")) {
      console.log("  Correctly rejected with WeightsMismatch:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9003");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("CreateEtf weights=9999 should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 20. Test: CreateEtf duplicate-init (same PDA twice) → AlreadyInitialized or system-level failure
  // The original ETF PDA (etfState) is already initialized from Step 5. Attempt another CreateEtf
  // targeting the same PDA — must not succeed.
  console.log("\n> Test: CreateEtf duplicate-init on existing PDA (expect error)");
  try {
    const dupMintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: dupMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, dupMintKp]);
    const dupVaultKps: Keypair[] = [];
    const dupVaultsTx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      dupVaultKps.push(kp);
      dupVaultsTx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, dupVaultsTx, [payer, ...dupVaultKps]);

    const dupData = Buffer.concat([
      Buffer.from([0]), Buffer.from([TOKEN_COUNT]), weightsBuf,
      Buffer.from([tickerBytes.length]), tickerBytes,
      Buffer.from([nameBytes.length]), nameBytes, // same name as Step 5 → same PDA
      URI_LEN_ZERO,                     // v1.1
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },       // already-init'd PDA
        { pubkey: dupMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        ...dupVaultKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(dupMintKp.publicKey),
      ],
      data: dupData,
    })), [payer]);
    throw new Error("Should have failed but succeeded");
  } catch (err: any) {
    const msg = err.message || String(err);
    // AlreadyInitialized = 9001 = 0x2329. Accept either the custom code
    // or the system-level "account already in use" since CreateAccount
    // may fail first depending on execution order.
    if (msg.includes("0x2329") || msg.includes("9001") || msg.includes("already in use")) {
      console.log("  Correctly rejected:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "already-initialized");
    } else if (msg === "Should have failed but succeeded") {
      throw new Error("CreateEtf duplicate-init should have failed");
    } else {
      console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
    }
  }

  // 21-22 — Issue #35 (first-depositor inflation/donation DoS).
  //
  // Each #35 test needs its own fresh ETF because the guards only
  // apply when total_supply == 0. We factor the setup into a helper
  // to avoid scrolling past 200 lines of createAccount boilerplate.
  async function spinUpFreshEtf(label: string) {
    const name = Buffer.from(`${label}${Date.now().toString(36).slice(-4).toUpperCase()}`);
    const [state] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), name],
      PROGRAM_ID,
    );
    const mintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, mintKp]);
    const vKps: Keypair[] = [];
    const vPks: PublicKey[] = [];
    const vtx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      vKps.push(kp);
      vPks.push(kp.publicKey);
      vtx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, vtx, [payer, ...vKps]);
    const treasuryKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasuryKp.publicKey, lamports: LAMPORTS_PER_SOL / 20 })
    ), [payer]);

    // CreateEtf v1.1 (ticker precedes name; uri appended; metadata accounts).
    const wbuf = Buffer.alloc(TOKEN_COUNT * 2);
    for (let i = 0; i < TOKEN_COUNT; i++) wbuf.writeUInt16LE(WEIGHTS[i], i * 2);
    const tickerBytes = Buffer.from("AX");
    const cdata = Buffer.concat([
      Buffer.from([0]), Buffer.from([TOKEN_COUNT]), wbuf,
      Buffer.from([tickerBytes.length]), tickerBytes,
      Buffer.from([name.length]), name,
      URI_LEN_ZERO,                     // v1.1
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        ...vPks.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(mintKp.publicKey),
      ],
      data: cdata,
    })), [payer]);

    const userEtf = await createAccount(conn, payer, mintKp.publicKey, payer.publicKey);
    const treasuryEtf = await createAccount(conn, payer, mintKp.publicKey, treasuryKp.publicKey);
    return { name, state, mintKp, vPks, userEtf, treasuryEtf };
  }

  // 21. Fresh ETF + first deposit below MIN_FIRST_DEPOSIT → InsufficientFirstDeposit (9018 / 0x233A)
  console.log("\n> Test: First deposit below MIN_FIRST_DEPOSIT (expect InsufficientFirstDeposit)");
  {
    const fresh = await spinUpFreshEtf("MINDEP");
    try {
      // amount = 1 (the attacker's cheap seed in the #35 scenario).
      const data = Buffer.concat([
        Buffer.from([1]),
        u64Le(1n),
        u64Le(0n),
        Buffer.from([fresh.name.length]),
        fresh.name,
      ]);
      await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: fresh.state, isSigner: false, isWritable: true },
          { pubkey: fresh.mintKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: fresh.userEtf, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: fresh.treasuryEtf, isSigner: false, isWritable: true },
          ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
          ...fresh.vPks.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        ],
        data,
      })), [payer]);
      throw new Error("Should have failed but succeeded");
    } catch (err: any) {
      const msg = err.message || String(err);
      // InsufficientFirstDeposit = 9018 = 0x233A
      if (msg.includes("0x233a") || msg.includes("9018")) {
        console.log("  Correctly rejected with InsufficientFirstDeposit:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9018");
      } else if (msg === "Should have failed but succeeded") {
        throw new Error("Tiny first deposit should have failed");
      } else {
        console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
      }
    }
  }

  // 22. Inflation/donation attack: after a legit first deposit at
  // MIN_FIRST_DEPOSIT, an attacker donates basket tokens straight into
  // the vault ATAs (bypassing Deposit) to try to brick the pool. With
  // total_supply already >= MIN_FIRST_DEPOSIT, a normal-sized victim
  // deposit must round to a non-zero mint (not ZeroDeposit), proving
  // the pool is no longer DoS'd. Also confirms MINIMUM_LIQUIDITY is
  // counted in total_supply but not in circulating SPL supply.
  console.log("\n> Test: Donation attack — victim deposit must still mint > 0");
  {
    const fresh = await spinUpFreshEtf("DONATE");

    // Legit first deposit at exactly MIN_FIRST_DEPOSIT (0.01 ETF @ 6 dp).
    const firstData = Buffer.concat([
      Buffer.from([1]),
      u64Le(10_000n),
      u64Le(0n),
      Buffer.from([fresh.name.length]),
      fresh.name,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: fresh.state, isSigner: false, isWritable: true },
        { pubkey: fresh.mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: fresh.userEtf, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: fresh.treasuryEtf, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...fresh.vPks.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: firstData,
    })), [payer]);

    const supplyAfterFirst = (await conn.getAccountInfo(fresh.state))!.data.readBigUInt64LE(408);
    const userBalAfterFirst = (await getAccount(conn, fresh.userEtf)).amount;
    console.log(`  First deposit: total_supply=${supplyAfterFirst}, user=${userBalAfterFirst}`);

    // Attacker donates basket tokens straight into the vault ATAs
    // (bypasses Deposit) at the target weight ratio so NAV deviation
    // does not fire. Scale = 10_000x the legit leg amounts.
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const legitLeg = 10_000n * BigInt(WEIGHTS[i]) / 10_000n;
      const donation = legitLeg * 10_000n;
      await mintTo(conn, payer, mints[i], fresh.vPks[i], payer, donation);
    }

    // Victim deposits 100 tokens. Without #35, every candidate would
    // round to 0 and the tx would revert with ZeroDeposit. With the
    // MIN_FIRST_DEPOSIT floor keeping total_supply bounded, the
    // proportional math rounds to a real non-zero mint.
    const victimData = Buffer.concat([
      Buffer.from([1]),
      u64Le(100_000_000n),
      u64Le(0n),
      Buffer.from([fresh.name.length]),
      fresh.name,
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: fresh.state, isSigner: false, isWritable: true },
        { pubkey: fresh.mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: fresh.userEtf, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: fresh.treasuryEtf, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...fresh.vPks.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
      ],
      data: victimData,
    })), [payer]);

    const userBalAfterVictim = (await getAccount(conn, fresh.userEtf)).amount;
    const mintedToVictim = userBalAfterVictim - userBalAfterFirst;
    if (mintedToVictim === 0n) {
      throw new Error("Victim deposit rounded to 0 — donation attack succeeded in bricking the pool");
    }
    console.log(`  Victim deposit after donation attack minted: ${mintedToVictim} (>0 → pool not DoS'd)`);
  }

  // 25-28 — Issue #37 (on-chain ETF metadata validation).
  //
  // Ticker must be ASCII upper/digit and 2..=16 bytes; name must be
  // UTF-8 and 1..=32 bytes. Each negative case tries a CreateEtf with
  // otherwise-valid inputs and asserts the program rejects with the
  // correct error code.
  async function tryBadCreate(label: string, badTicker: Buffer, badName: Buffer): Promise<string> {
    const pdaName = Buffer.concat([Buffer.from(`${label}_`), badName]).subarray(0, 32);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), pdaName],
      PROGRAM_ID,
    );
    const mintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, mintKp]);
    const vKps: Keypair[] = [];
    const vtx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      vKps.push(kp);
      vtx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, vtx, [payer, ...vKps]);

    const wbuf = Buffer.alloc(TOKEN_COUNT * 2);
    for (let i = 0; i < TOKEN_COUNT; i++) wbuf.writeUInt16LE(WEIGHTS[i], i * 2);
    // The instruction uses a u8 length prefix, so a 300-byte ticker
    // won't even fit — cap at 255 to still exercise the instruction
    // handler rather than breaking on parse.
    const cappedTicker = badTicker.subarray(0, Math.min(badTicker.length, 255));
    const cappedName = badName.subarray(0, Math.min(badName.length, 255));
    const data = Buffer.concat([
      Buffer.from([0]), Buffer.from([TOKEN_COUNT]), wbuf,
      Buffer.from([cappedTicker.length]), cappedTicker,
      Buffer.from([cappedName.length]), cappedName,
      URI_LEN_ZERO,                     // v1.1
    ]);
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        ...vKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(mintKp.publicKey),
      ],
      data,
    })), [payer]);
    return "";
  }

  const expectError = async (label: string, expectedHex: string, expectedCode: string,
                             badTicker: Buffer, badName: Buffer) => {
    console.log(`\n> Test: ${label} (expect ${expectedCode})`);
    try {
      await tryBadCreate(label, badTicker, badName);
      throw new Error("Should have failed but succeeded");
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes(expectedHex) || msg.includes(expectedCode)) {
        console.log(`  Correctly rejected with ${expectedCode}:`, msg.match(/0x[0-9a-f]+/i)?.[0] ?? expectedCode);
      } else if (msg === "Should have failed but succeeded") {
        throw new Error(`${label} should have failed`);
      } else {
        console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
      }
    }
  };

  // 25. Empty ticker — length 0 is below the 2-byte minimum.
  // InvalidTicker = 9019 = 0x233B
  await expectError(
    "CreateEtf with empty ticker",
    "0x233b", "InvalidTicker",
    Buffer.from(""),
    Buffer.from(`NAME${Date.now().toString(36)}`).subarray(0, 20),
  );

  // 26. Overlong ticker (17 bytes > 16 max).
  await expectError(
    "CreateEtf with ticker > 16 bytes",
    "0x233b", "InvalidTicker",
    Buffer.from("A".repeat(17)),
    Buffer.from(`NAME${Date.now().toString(36)}`).subarray(0, 20),
  );

  // 27. Non-ASCII-upper ticker — lowercase letters must be rejected so
  // on-chain tickers stay canonicalized.
  await expectError(
    "CreateEtf with lowercase ticker",
    "0x233b", "InvalidTicker",
    Buffer.from("axbtc"),
    Buffer.from(`NAME${Date.now().toString(36)}`).subarray(0, 20),
  );

  // 28. Overlong name (33 bytes > 32 max). InvalidName = 9020 = 0x233C
  await expectError(
    "CreateEtf with name > 32 bytes",
    "0x233c", "InvalidName",
    Buffer.from("AXOK"),
    Buffer.from("X".repeat(33)),
  );

  // 29 — Issue #38 (on-chain SweepTreasury instruction).
  //
  // After Step 17 the user fully withdrew, leaving the treasury as the
  // only ETF holder (total_supply == treasury_etf_balance). SweepTreasury
  // is the treasury's redemption path: it burns the treasury's full ETF
  // balance and forwards the proportional basket tokens to treasury-owned
  // basket ATAs (no fee, no slippage guard — this is an admin op, not a
  // trade). Steps 18-20 are fresh-ETF error tests that don't touch the
  // main ETF, so this state still holds going into the sweep.
  console.log("\n> Test: SweepTreasury redeems accumulated fees");
  {
    // Treasury's destination basket ATAs — one per basket leg, owned by
    // the treasury pubkey. Separate from the payer's userTokens so we
    // can assert the sweep delivered tokens to the right owner.
    const treasuryBasketAtas: PublicKey[] = [];
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const ata = await createAccount(conn, payer, mints[i], treasuryKp.publicKey);
      treasuryBasketAtas.push(ata);
    }

    const treasuryEtfBefore = (await getAccount(conn, treasuryEtfAta)).amount;
    const totalSupplyBefore = (await conn.getAccountInfo(etfState))!.data.readBigUInt64LE(408);
    const vaultBefore: bigint[] = [];
    for (let i = 0; i < TOKEN_COUNT; i++) {
      vaultBefore.push((await getAccount(conn, vaults[i])).amount);
    }
    console.log(`  Pre-sweep: treasury_etf=${treasuryEtfBefore}, total_supply=${totalSupplyBefore}`);

    const sweepData = Buffer.concat([
      Buffer.from([3]), // disc = SweepTreasury
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]);
    const sweepTx = new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: treasuryKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: etfState, isSigner: false, isWritable: true },
        { pubkey: etfMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // vaults (source)
        ...vaults.map(v => ({ pubkey: v, isSigner: false, isWritable: true })),
        // treasury basket dests
        ...treasuryBasketAtas.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
      ],
      data: sweepData,
    }));
    await sendAndConfirmTransaction(conn, sweepTx, [payer, treasuryKp]);

    const treasuryEtfAfter = (await getAccount(conn, treasuryEtfAta)).amount;
    const totalSupplyAfter = (await conn.getAccountInfo(etfState))!.data.readBigUInt64LE(408);
    if (treasuryEtfAfter !== 0n) {
      throw new Error(`Post-sweep treasury ETF balance should be 0, got ${treasuryEtfAfter}`);
    }
    const MINIMUM_LIQUIDITY = 1_000n;
    if (totalSupplyAfter !== MINIMUM_LIQUIDITY) {
      throw new Error(`Post-sweep total_supply should be ${MINIMUM_LIQUIDITY} (MINIMUM_LIQUIDITY lock), got ${totalSupplyAfter}`);
    }
    for (let i = 0; i < TOKEN_COUNT; i++) {
      // Payout = vault_balance * burn_amount / total_supply (u128 truncation).
      // With MINIMUM_LIQUIDITY locked in total_supply, the vault is NOT fully
      // drained — a residual of vault_balance * MINIMUM_LIQUIDITY / total_supply
      // stays behind. Compute the expected payout with the same formula and
      // allow off-by-one for integer truncation.
      const destBal = (await getAccount(conn, treasuryBasketAtas[i])).amount;
      const expectedPayout = (vaultBefore[i] * treasuryEtfBefore) / totalSupplyBefore;
      const diff = destBal > expectedPayout ? destBal - expectedPayout : expectedPayout - destBal;
      if (diff > 1n) {
        throw new Error(
          `Vault ${i}: expected ≈${expectedPayout} to treasury, got ${destBal} (diff ${diff})`
        );
      }
    }
    console.log(`  Swept ${treasuryEtfBefore} ETF tokens; treasury basket ATAs funded`);
  }

  // 30. Rejection: non-treasury signer can't sweep.
  // Uses a fresh ETF so the sweep target is isolated. SweepForbidden = 9021 = 0x233D
  console.log("\n> Test: SweepTreasury signed by non-treasury (expect SweepForbidden)");
  {
    // Minimal fresh ETF to exercise the signer check only. We don't need
    // any deposits — reusing the main-ETF treasury would require another
    // round-trip to accrue fees.
    const forbidName = Buffer.from(`FORBID${Date.now().toString(36).slice(-4).toUpperCase()}`);
    const [forbidPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("etf"), payer.publicKey.toBuffer(), forbidName],
      PROGRAM_ID,
    );
    const forbidMintKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: forbidMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    })), [payer, forbidMintKp]);
    const forbidVaultKps: Keypair[] = [];
    const forbidVaultsTx = new Transaction();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const kp = Keypair.generate();
      forbidVaultKps.push(kp);
      forbidVaultsTx.add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        lamports: vaultRent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }));
    }
    await sendAndConfirmTransaction(conn, forbidVaultsTx, [payer, ...forbidVaultKps]);
    const forbidTreasuryKp = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: forbidTreasuryKp.publicKey, lamports: LAMPORTS_PER_SOL / 20 })
    ), [payer]);

    const forbidWbuf = Buffer.alloc(TOKEN_COUNT * 2);
    for (let i = 0; i < TOKEN_COUNT; i++) forbidWbuf.writeUInt16LE(WEIGHTS[i], i * 2);
    const forbidTickerBytes = Buffer.from("AX");
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: forbidPda, isSigner: false, isWritable: true },
        { pubkey: forbidMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: forbidTreasuryKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...mints.map(m => ({ pubkey: m, isSigner: false, isWritable: false })),
        ...forbidVaultKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
        ...v1_1MetaKeys(forbidMintKp.publicKey),
      ],
      data: Buffer.concat([
        Buffer.from([0]), Buffer.from([TOKEN_COUNT]), forbidWbuf,
        Buffer.from([forbidTickerBytes.length]), forbidTickerBytes,
        Buffer.from([forbidName.length]), forbidName,
        URI_LEN_ZERO,                     // v1.1
      ]),
    })), [payer]);

    // To exercise the SweepForbidden path we need a populated treasury
    // ETF ATA. Create it, deposit once to accrue a fee, then try to
    // sweep with the wrong signer (payer, not the stored treasury).
    const forbidTreasuryEtf = await createAccount(
      conn, payer, forbidMintKp.publicKey, forbidTreasuryKp.publicKey,
    );
    const forbidUserEtf = await createAccount(
      conn, payer, forbidMintKp.publicKey, payer.publicKey,
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: forbidPda, isSigner: false, isWritable: true },
        { pubkey: forbidMintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: forbidUserEtf, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: forbidTreasuryEtf, isSigner: false, isWritable: true },
        ...userTokens.map(u => ({ pubkey: u, isSigner: false, isWritable: true })),
        ...forbidVaultKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.concat([
        Buffer.from([1]),
        u64Le(100_000_000n),
        u64Le(0n),
        Buffer.from([forbidName.length]), forbidName,
      ]),
    })), [payer]);

    // Wrong-signer sweep: payer signs, but payer.publicKey != etf.treasury.
    const forbidBasketAtas: PublicKey[] = [];
    for (let i = 0; i < TOKEN_COUNT; i++) {
      forbidBasketAtas.push(await createAccount(conn, payer, mints[i], forbidTreasuryKp.publicKey));
    }
    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // WRONG signer
          { pubkey: forbidPda, isSigner: false, isWritable: true },
          { pubkey: forbidMintKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: forbidTreasuryEtf, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...forbidVaultKps.map(kp => ({ pubkey: kp.publicKey, isSigner: false, isWritable: true })),
          ...forbidBasketAtas.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
        ],
        data: Buffer.concat([
          Buffer.from([3]), Buffer.from([forbidName.length]), forbidName,
        ]),
      })), [payer]);
      throw new Error("Should have failed but succeeded");
    } catch (err: any) {
      const msg = err.message || String(err);
      // SweepForbidden = 9021 = 0x233D
      if (msg.includes("0x233d") || msg.includes("9021")) {
        console.log("  Correctly rejected with SweepForbidden:", msg.match(/0x[0-9a-f]+/i)?.[0] ?? "9021");
      } else if (msg === "Should have failed but succeeded") {
        throw new Error("SweepTreasury with wrong signer should have failed");
      } else {
        console.log("  Rejected with error (unexpected code):", msg.slice(0, 120));
      }
    }
  }

  console.log("\n=== Vault E2E PASSED ===");
}
main().catch(err => { console.error("Error:", err.message || err); process.exit(1); });
