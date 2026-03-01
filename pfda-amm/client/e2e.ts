/**
 * PFDA AMM — E2E Test Script
 *
 * Flow:
 *   1. Create Token A / B mints
 *   2. Create user token accounts & mint tokens
 *   3. Derive PDAs
 *   4. Pre-allocate vault accounts
 *   5. InitializePool
 *   6. AddLiquidity
 *   7. SwapRequest  (A → B)
 *   8. Wait for batch window to end
 *   9. ClearBatch   ← CU 計測のメイン対象
 *  10. Claim
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

// ─── 設定 ──────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("5BKDTDQdX7vFdDooVXZeKicu7S3yX2JY5e3rmASib5pY");
const RPC_URL    = "http://localhost:8899";

// バッチウィンドウ: 10スロット (≒ 4秒) — SwapRequest が余裕で入る長さ
const WINDOW_SLOTS    = 10n;
const BASE_FEE_BPS    = 30;       // 0.30%
const FEE_DISCOUNT    = 10;       // 0.10%
const WEIGHT_A_MICRO  = 500_000;  // 50 / 50

// ─── ユーティリティ ───────────────────────────────────────────────────────

function loadPayer(): Keypair {
  const path = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function u32Le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u16Le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function num(n: bigint): string {
  return n.toLocaleString();
}

// ─── PDA ─────────────────────────────────────────────────────────────────

function findPool(mintA: PublicKey, mintB: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
    PROGRAM_ID
  );
}
function findQueue(pool: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("queue"), pool.toBuffer(), u64Le(batchId)],
    PROGRAM_ID
  );
}
function findHistory(pool: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("history"), pool.toBuffer(), u64Le(batchId)],
    PROGRAM_ID
  );
}
function findTicket(pool: PublicKey, user: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), pool.toBuffer(), user.toBuffer(), u64Le(batchId)],
    PROGRAM_ID
  );
}

// ─── 命令ビルダー ─────────────────────────────────────────────────────────

function ixInitializePool(
  payer:      PublicKey,
  poolState:  PublicKey,
  queue:      PublicKey,
  mintA:      PublicKey,
  mintB:      PublicKey,
  vaultA:     PublicKey,
  vaultB:     PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([0]),       // discriminant
    u16Le(BASE_FEE_BPS),
    u16Le(FEE_DISCOUNT),
    u64Le(WINDOW_SLOTS),
    u32Le(WEIGHT_A_MICRO),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                   isSigner: true,  isWritable: true  },
      { pubkey: poolState,               isSigner: false, isWritable: true  },
      { pubkey: queue,                   isSigner: false, isWritable: true  },
      { pubkey: mintA,                   isSigner: false, isWritable: false },
      { pubkey: mintB,                   isSigner: false, isWritable: false },
      { pubkey: vaultA,                  isSigner: false, isWritable: true  },
      { pubkey: vaultB,                  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixAddLiquidity(
  user:       PublicKey,
  poolState:  PublicKey,
  vaultA:     PublicKey,
  vaultB:     PublicKey,
  userTokenA: PublicKey,
  userTokenB: PublicKey,
  amountA:    bigint,
  amountB:    bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([4]),   // discriminant
    u64Le(amountA),
    u64Le(amountB),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,            isSigner: true,  isWritable: true  },
      { pubkey: poolState,       isSigner: false, isWritable: true  },
      { pubkey: vaultA,          isSigner: false, isWritable: true  },
      { pubkey: vaultB,          isSigner: false, isWritable: true  },
      { pubkey: userTokenA,      isSigner: false, isWritable: true  },
      { pubkey: userTokenB,      isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixSwapRequest(
  user:       PublicKey,
  poolState:  PublicKey,
  queue:      PublicKey,
  ticket:     PublicKey,
  userTokenA: PublicKey,
  userTokenB: PublicKey,
  vaultA:     PublicKey,
  vaultB:     PublicKey,
  amountInA:  bigint,
  amountInB:  bigint,
  minOut:     bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([1]),   // discriminant
    u64Le(amountInA),
    u64Le(amountInB),
    u64Le(minOut),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,                    isSigner: true,  isWritable: true  },
      { pubkey: poolState,               isSigner: false, isWritable: false },
      { pubkey: queue,                   isSigner: false, isWritable: true  },
      { pubkey: ticket,                  isSigner: false, isWritable: true  },
      { pubkey: userTokenA,              isSigner: false, isWritable: true  },
      { pubkey: userTokenB,              isSigner: false, isWritable: true  },
      { pubkey: vaultA,                  isSigner: false, isWritable: true  },
      { pubkey: vaultB,                  isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixClearBatch(
  cranker:   PublicKey,
  poolState: PublicKey,
  queue:     PublicKey,
  history:   PublicKey,
  nextQueue: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: cranker,                 isSigner: true,  isWritable: true  },
      { pubkey: poolState,               isSigner: false, isWritable: true  },
      { pubkey: queue,                   isSigner: false, isWritable: true  },
      { pubkey: history,                 isSigner: false, isWritable: true  },
      { pubkey: nextQueue,               isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([2]),   // discriminant
  });
}

function ixClaim(
  user:       PublicKey,
  poolState:  PublicKey,
  history:    PublicKey,
  ticket:     PublicKey,
  vaultA:     PublicKey,
  vaultB:     PublicKey,
  userTokenA: PublicKey,
  userTokenB: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,            isSigner: true,  isWritable: false },
      { pubkey: poolState,       isSigner: false, isWritable: false },
      { pubkey: history,         isSigner: false, isWritable: false },
      { pubkey: ticket,          isSigner: false, isWritable: true  },
      { pubkey: vaultA,          isSigner: false, isWritable: true  },
      { pubkey: vaultB,          isSigner: false, isWritable: true  },
      { pubkey: userTokenA,      isSigner: false, isWritable: true  },
      { pubkey: userTokenB,      isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([3]),   // discriminant
  });
}

// ─── チェーン状態の読み取り ───────────────────────────────────────────────

async function readPoolState(conn: Connection, poolPk: PublicKey) {
  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error("PoolState account not found");
  const d = info.data;
  // Offsets (PoolState is repr(C), 208 bytes total)
  // 0..8   discriminator
  // 8..40  token_a_mint
  // 40..72 token_b_mint
  // 72..104 vault_a
  // 104..136 vault_b
  // 136..144 reserve_a
  // 144..152 reserve_b
  // 184..192 current_batch_id
  // 192..200 current_window_end
  return {
    reserveA:         d.readBigUInt64LE(136),
    reserveB:         d.readBigUInt64LE(144),
    currentBatchId:   d.readBigUInt64LE(184),
    currentWindowEnd: d.readBigUInt64LE(192),
  };
}

async function readClearedHistory(conn: Connection, historyPk: PublicKey) {
  const info = await conn.getAccountInfo(historyPk);
  if (!info) throw new Error("ClearedBatchHistory account not found");
  const d = info.data;
  // 0..8   discriminator
  // 8..40  pool
  // 40..48 batch_id
  // 48..56 clearing_price   ← Q32.32
  // 56..64 out_b_per_in_a   ← Q32.32
  // 64..72 out_a_per_in_b   ← Q32.32
  // 72..73 is_cleared
  const FP_ONE = 2 ** 32;
  return {
    clearingPrice:  Number(d.readBigUInt64LE(48)) / FP_ONE,
    outBperA:       Number(d.readBigUInt64LE(56)) / FP_ONE,
    outAperB:       Number(d.readBigUInt64LE(64)) / FP_ONE,
    isCleared:      d[72] === 1,
  };
}

async function waitForSlot(conn: Connection, targetSlot: bigint) {
  process.stdout.write(`  スロット ${targetSlot} を待機中 ...`);
  while (true) {
    const s = BigInt(await conn.getSlot("confirmed"));
    if (s >= targetSlot) {
      console.log(` 現在スロット: ${s}`);
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function getCU(conn: Connection, sig: string): Promise<number | null> {
  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  return tx?.meta?.computeUnitsConsumed ?? null;
}

// ─── メイン ───────────────────────────────────────────────────────────────

async function main() {
  const conn  = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║      PFDA AMM — E2E Test                 ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Wallet  : ${payer.publicKey.toBase58()}`);
  console.log(`Program : ${PROGRAM_ID.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`残高    : ${(bal / LAMPORTS_PER_SOL).toFixed(2)} SOL\n`);

  const cuLog: Record<string, number | null> = {};

  // ── 1. ミント作成 ──────────────────────────────────────────────────────
  console.log("▶ Step 1: Token A / B ミント作成");
  const mintA = await createMint(conn, payer, payer.publicKey, null, 6);
  const mintB = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log(`  Mint A : ${mintA.toBase58()}`);
  console.log(`  Mint B : ${mintB.toBase58()}\n`);

  // ── 2. ユーザートークンアカウント ────────────────────────────────────
  console.log("▶ Step 2: ユーザートークンアカウント作成 & トークン発行");
  const userTA = await createAccount(conn, payer, mintA, payer.publicKey);
  const userTB = await createAccount(conn, payer, mintB, payer.publicKey);
  const SUPPLY = 10_000_000_000n;  // 10,000 tokens (6 decimals)
  await mintTo(conn, payer, mintA, userTA, payer, SUPPLY);
  await mintTo(conn, payer, mintB, userTB, payer, SUPPLY);
  console.log(`  User Token A : ${userTA.toBase58()}`);
  console.log(`  User Token B : ${userTB.toBase58()}`);
  console.log(`  各 ${num(SUPPLY)} lamports 発行済み\n`);

  // ── 3. PDA 導出 ────────────────────────────────────────────────────────
  const [poolState]  = findPool(mintA, mintB);
  const [queue0]     = findQueue(poolState, 0n);
  const [history0]   = findHistory(poolState, 0n);
  const [queue1]     = findQueue(poolState, 1n);
  const [ticket]     = findTicket(poolState, payer.publicKey, 0n);
  console.log("▶ Step 3: PDA");
  console.log(`  PoolState    : ${poolState.toBase58()}`);
  console.log(`  BatchQueue#0 : ${queue0.toBase58()}`);
  console.log(`  History#0    : ${history0.toBase58()}\n`);

  // ── 4. Vault アカウント（未初期化）を事前作成 ──────────────────────
  console.log("▶ Step 4: Vault アカウントを事前作成");
  const vaultAKp = Keypair.generate();
  const vaultBKp = Keypair.generate();
  const rentExempt = await getMinimumBalanceForRentExemptAccount(conn);

  const createVaultsTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:      payer.publicKey,
      newAccountPubkey: vaultAKp.publicKey,
      lamports:        rentExempt,
      space:           ACCOUNT_SIZE,   // 165 bytes
      programId:       TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey:      payer.publicKey,
      newAccountPubkey: vaultBKp.publicKey,
      lamports:        rentExempt,
      space:           ACCOUNT_SIZE,
      programId:       TOKEN_PROGRAM_ID,
    }),
  );
  await sendAndConfirmTransaction(conn, createVaultsTx, [payer, vaultAKp, vaultBKp]);
  console.log(`  Vault A : ${vaultAKp.publicKey.toBase58()}`);
  console.log(`  Vault B : ${vaultBKp.publicKey.toBase58()}\n`);

  // ── 5. InitializePool ─────────────────────────────────────────────────
  console.log("▶ Step 5: InitializePool");
  const initTx  = new Transaction().add(
    ixInitializePool(payer.publicKey, poolState, queue0, mintA, mintB,
                     vaultAKp.publicKey, vaultBKp.publicKey)
  );
  const initSig = await sendAndConfirmTransaction(conn, initTx, [payer]);
  cuLog["InitializePool"] = await getCU(conn, initSig);

  const poolAfterInit = await readPoolState(conn, poolState);
  console.log(`  Tx           : ${initSig.slice(0, 20)}...`);
  console.log(`  CU           : ${cuLog["InitializePool"]?.toLocaleString()}`);
  console.log(`  BatchId      : ${poolAfterInit.currentBatchId}`);
  console.log(`  WindowEnd    : slot ${poolAfterInit.currentWindowEnd}\n`);

  const windowEndSlot = poolAfterInit.currentWindowEnd;

  // ── 6. AddLiquidity ────────────────────────────────────────────────────
  console.log("▶ Step 6: AddLiquidity");
  const LIQ = 1_000_000_000n;  // 1,000 tokens each side
  const addLiqTx  = new Transaction().add(
    ixAddLiquidity(payer.publicKey, poolState,
                   vaultAKp.publicKey, vaultBKp.publicKey,
                   userTA, userTB, LIQ, LIQ)
  );
  const addLiqSig = await sendAndConfirmTransaction(conn, addLiqTx, [payer]);
  cuLog["AddLiquidity"] = await getCU(conn, addLiqSig);

  const poolAfterLiq = await readPoolState(conn, poolState);
  console.log(`  Tx        : ${addLiqSig.slice(0, 20)}...`);
  console.log(`  CU        : ${cuLog["AddLiquidity"]?.toLocaleString()}`);
  console.log(`  reserve_a : ${num(poolAfterLiq.reserveA)}`);
  console.log(`  reserve_b : ${num(poolAfterLiq.reserveB)}\n`);

  // ── 7. SwapRequest (A → B) ────────────────────────────────────────────
  console.log("▶ Step 7: SwapRequest  (10 Token A → B)");
  const SWAP_A = 10_000_000n;  // 10 tokens
  const swapTx  = new Transaction().add(
    ixSwapRequest(payer.publicKey, poolState, queue0, ticket,
                  userTA, userTB, vaultAKp.publicKey, vaultBKp.publicKey,
                  SWAP_A, 0n, 0n)
  );
  const swapSig = await sendAndConfirmTransaction(conn, swapTx, [payer]);
  cuLog["SwapRequest"] = await getCU(conn, swapSig);
  console.log(`  Tx : ${swapSig.slice(0, 20)}...`);
  console.log(`  CU : ${cuLog["SwapRequest"]?.toLocaleString()}\n`);

  // ── 8. バッチウィンドウ終了まで待機 ──────────────────────────────────
  console.log(`▶ Step 8: バッチウィンドウ終了待ち (slot ${windowEndSlot})`);
  await waitForSlot(conn, windowEndSlot);
  console.log();

  // ── 9. ClearBatch ─────────────────────────────────────────────────────
  console.log("▶ Step 9: ClearBatch  ★ CU 計測のメイン対象");

  const clearTx = new Transaction().add(
    ixClearBatch(payer.publicKey, poolState, queue0, history0, queue1)
  );

  // シミュレーションで先に確認
  const { blockhash } = await conn.getLatestBlockhash();
  clearTx.recentBlockhash = blockhash;
  clearTx.feePayer = payer.publicKey;
  clearTx.sign(payer);

  const sim = await conn.simulateTransaction(clearTx);
  if (sim.value.err) {
    console.error("  ✗ シミュレーション失敗:", JSON.stringify(sim.value.err));
    console.error("  ログ:");
    sim.value.logs?.forEach(l => console.error("    " + l));
    process.exit(1);
  }
  console.log(`  シミュレーション CU : ${sim.value.unitsConsumed?.toLocaleString() ?? "N/A"}`);

  // 実際に送信
  const clearTx2 = new Transaction().add(
    ixClearBatch(payer.publicKey, poolState, queue0, history0, queue1)
  );
  const clearSig = await sendAndConfirmTransaction(conn, clearTx2, [payer]);
  cuLog["ClearBatch"] = await getCU(conn, clearSig);
  console.log(`  Tx                  : ${clearSig.slice(0, 20)}...`);
  console.log(`  ★ 実際の CU        : ${cuLog["ClearBatch"]?.toLocaleString()}`);

  // 清算結果を表示
  const hist = await readClearedHistory(conn, history0);
  const poolAfterClear = await readPoolState(conn, poolState);
  console.log(`  清算価格 (B/A)      : ${hist.clearingPrice.toFixed(8)}`);
  console.log(`  out_b_per_in_a      : ${hist.outBperA.toFixed(8)}`);
  console.log(`  reserve_a 更新後    : ${num(poolAfterClear.reserveA)}`);
  console.log(`  reserve_b 更新後    : ${num(poolAfterClear.reserveB)}\n`);

  // ── 10. Claim ─────────────────────────────────────────────────────────
  console.log("▶ Step 10: Claim");
  const beforeB = (await getAccount(conn, userTB)).amount;

  const claimTx  = new Transaction().add(
    ixClaim(payer.publicKey, poolState, history0, ticket,
            vaultAKp.publicKey, vaultBKp.publicKey, userTA, userTB)
  );
  const claimSig = await sendAndConfirmTransaction(conn, claimTx, [payer]);
  cuLog["Claim"] = await getCU(conn, claimSig);

  const afterB = (await getAccount(conn, userTB)).amount;
  const received = afterB - beforeB;
  console.log(`  Tx                : ${claimSig.slice(0, 20)}...`);
  console.log(`  CU                : ${cuLog["Claim"]?.toLocaleString()}`);
  console.log(`  Token B 受取量    : ${num(received)} (≈ ${(Number(received) / 1e6).toFixed(4)} tokens)\n`);

  // ── サマリー ──────────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════╗");
  console.log("║             CU サマリー                  ║");
  console.log("╠══════════════════════════════════════════╣");
  for (const [label, cu] of Object.entries(cuLog)) {
    const bar = cu ? "█".repeat(Math.min(Math.floor(cu / 2000), 20)) : "";
    console.log(`║  ${label.padEnd(15)} : ${String(cu?.toLocaleString() ?? "N/A").padStart(7)} CU  ${bar}`);
  }
  console.log("╚══════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n✗ エラー:", err);
  process.exit(1);
});
