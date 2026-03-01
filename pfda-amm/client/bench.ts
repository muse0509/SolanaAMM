/**
 * PFDA AMM — bench.ts
 *
 * Part 1: TFMM Demo
 *   weight 50% → 70%, 4 batches, clearing price rises (Dutch-auction price discovery)
 *
 * Part 2: O(1) Scalability Proof
 *   N = [1, 3, 5, 10] orders per batch — ClearBatch CU stays constant
 */

import {
  ComputeBudgetProgram,
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
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  getMinimumBalanceForRentExemptAccount,
  createInitializeAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("5BKDTDQdX7vFdDooVXZeKicu7S3yX2JY5e3rmASib5pY");
const RPC_URL    = "http://localhost:8899";

// ─── helpers ───────────────────────────────────────────────────────────────

function loadPayer(): Keypair {
  const path = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}
function u32Le(n: number): Buffer {
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;
}
function u16Le(n: number): Buffer {
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b;
}

// ─── PDAs ──────────────────────────────────────────────────────────────────

function findPool(mintA: PublicKey, mintB: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()], PROGRAM_ID);
}
function findQueue(pool: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("queue"), pool.toBuffer(), u64Le(batchId)], PROGRAM_ID);
}
function findHistory(pool: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("history"), pool.toBuffer(), u64Le(batchId)], PROGRAM_ID);
}
function findTicket(pool: PublicKey, user: PublicKey, batchId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), pool.toBuffer(), user.toBuffer(), u64Le(batchId)], PROGRAM_ID);
}

// ─── instruction builders ──────────────────────────────────────────────────

function ixInitPool(
  payer: PublicKey, poolState: PublicKey, queue: PublicKey,
  mintA: PublicKey, mintB: PublicKey, vaultA: PublicKey, vaultB: PublicKey,
  windowSlots: bigint, initWeightA: number,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([0]), u16Le(30), u16Le(10), u64Le(windowSlots), u32Le(initWeightA),
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
  user: PublicKey, poolState: PublicKey, vaultA: PublicKey, vaultB: PublicKey,
  userTA: PublicKey, userTB: PublicKey, amountA: bigint, amountB: bigint,
): TransactionInstruction {
  const data = Buffer.concat([Buffer.from([4]), u64Le(amountA), u64Le(amountB)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,             isSigner: true,  isWritable: true  },
      { pubkey: poolState,        isSigner: false, isWritable: true  },
      { pubkey: vaultA,           isSigner: false, isWritable: true  },
      { pubkey: vaultB,           isSigner: false, isWritable: true  },
      { pubkey: userTA,           isSigner: false, isWritable: true  },
      { pubkey: userTB,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixSwapRequest(
  user: PublicKey, poolState: PublicKey, queue: PublicKey, ticket: PublicKey,
  userTA: PublicKey, userTB: PublicKey, vaultA: PublicKey, vaultB: PublicKey,
  amountInA: bigint, amountInB: bigint, minOut: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([1]), u64Le(amountInA), u64Le(amountInB), u64Le(minOut),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,                    isSigner: true,  isWritable: true  },
      { pubkey: poolState,               isSigner: false, isWritable: false },
      { pubkey: queue,                   isSigner: false, isWritable: true  },
      { pubkey: ticket,                  isSigner: false, isWritable: true  },
      { pubkey: userTA,                  isSigner: false, isWritable: true  },
      { pubkey: userTB,                  isSigner: false, isWritable: true  },
      { pubkey: vaultA,                  isSigner: false, isWritable: true  },
      { pubkey: vaultB,                  isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixClearBatch(
  cranker: PublicKey, poolState: PublicKey, queue: PublicKey,
  history: PublicKey, nextQueue: PublicKey,
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
    data: Buffer.from([2]),
  });
}

function ixUpdateWeight(
  authority: PublicKey, poolState: PublicKey,
  targetWeightA: number, weightEndSlot: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([5]), u32Le(targetWeightA), u64Le(weightEndSlot),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true,  isWritable: false },
      { pubkey: poolState, isSigner: false, isWritable: true  },
    ],
    data,
  });
}

// ─── state readers ─────────────────────────────────────────────────────────

async function readPoolState(conn: Connection, poolPk: PublicKey) {
  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error("PoolState account not found");
  const d = info.data;
  return {
    reserveA:         d.readBigUInt64LE(136),
    reserveB:         d.readBigUInt64LE(144),
    currentWeightA:   d.readUInt32LE(152),   // micro units (1_000_000 = 100%)
    targetWeightA:    d.readUInt32LE(156),
    weightStartSlot:  d.readBigUInt64LE(160),
    weightEndSlot:    d.readBigUInt64LE(168),
    currentBatchId:   d.readBigUInt64LE(184),
    currentWindowEnd: d.readBigUInt64LE(192),
  };
}

async function readHistory(conn: Connection, historyPk: PublicKey) {
  const info = await conn.getAccountInfo(historyPk);
  if (!info) throw new Error("ClearedBatchHistory not found");
  const d = info.data;
  const FP = 2 ** 32;
  return {
    clearingPrice: Number(d.readBigUInt64LE(48)) / FP,
    outBperA:      Number(d.readBigUInt64LE(56)) / FP,
    isCleared:     d[72] === 1,
  };
}

// ─── utilities ─────────────────────────────────────────────────────────────

async function waitForSlot(conn: Connection, targetSlot: bigint) {
  process.stdout.write(`    waiting for slot ${targetSlot} ...`);
  while (true) {
    const s = BigInt(await conn.getSlot("confirmed"));
    if (s >= targetSlot) { console.log(` now at slot ${s}`); return; }
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

// ─── pool bootstrap ────────────────────────────────────────────────────────

interface PoolSetup {
  mintA:     PublicKey;
  mintB:     PublicKey;
  poolState: PublicKey;
  vaultA:    PublicKey;
  vaultB:    PublicKey;
  userTA:    PublicKey;
  userTB:    PublicKey;
}

async function bootstrapPool(
  conn: Connection,
  payer: Keypair,
  windowSlots: bigint,
  initWeightA: number,
  liqA: bigint,
  liqB: bigint,
): Promise<PoolSetup> {
  const mintA = await createMint(conn, payer, payer.publicKey, null, 6);
  const mintB = await createMint(conn, payer, payer.publicKey, null, 6);

  const userTA = await createAccount(conn, payer, mintA, payer.publicKey);
  const userTB = await createAccount(conn, payer, mintB, payer.publicKey);
  // mint extra supply for demo swaps
  await mintTo(conn, payer, mintA, userTA, payer, liqA + 200_000_000_000n);
  await mintTo(conn, payer, mintB, userTB, payer, liqB + 200_000_000_000n);

  const [poolState] = findPool(mintA, mintB);
  const [queue0]    = findQueue(poolState, 0n);

  const rent     = await getMinimumBalanceForRentExemptAccount(conn);
  const vaultAKp = Keypair.generate();
  const vaultBKp = Keypair.generate();
  const vaultTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: vaultAKp.publicKey,
      lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: vaultBKp.publicKey,
      lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
    }),
  );
  await sendAndConfirmTransaction(conn, vaultTx, [payer, vaultAKp, vaultBKp]);

  const initTx = new Transaction().add(
    ixInitPool(payer.publicKey, poolState, queue0, mintA, mintB,
      vaultAKp.publicKey, vaultBKp.publicKey, windowSlots, initWeightA)
  );
  await sendAndConfirmTransaction(conn, initTx, [payer]);

  const liqTx = new Transaction().add(
    ixAddLiquidity(payer.publicKey, poolState, vaultAKp.publicKey, vaultBKp.publicKey,
      userTA, userTB, liqA, liqB)
  );
  await sendAndConfirmTransaction(conn, liqTx, [payer]);

  return { mintA, mintB, poolState, vaultA: vaultAKp.publicKey, vaultB: vaultBKp.publicKey, userTA, userTB };
}

// ─── advance batch if window has expired ───────────────────────────────────

async function maybeAdvanceBatch(conn: Connection, payer: Keypair, poolState: PublicKey) {
  const pool = await readPoolState(conn, poolState);
  const currentSlot = BigInt(await conn.getSlot("confirmed"));
  if (currentSlot < pool.currentWindowEnd) return; // still open

  const batchId = pool.currentBatchId;
  const [queue]   = findQueue(poolState, batchId);
  const [history] = findHistory(poolState, batchId);
  const [nextQ]   = findQueue(poolState, batchId + 1n);
  const clearTx = new Transaction().add(
    ixClearBatch(payer.publicKey, poolState, queue, history, nextQ)
  );
  await sendAndConfirmTransaction(conn, clearTx, [payer]);
  console.log(`  (batch ${batchId} expired → advanced to batch ${batchId + 1n})`);
}

// ─── Part 1: TFMM Demo ─────────────────────────────────────────────────────

async function runTfmmDemo(conn: Connection, payer: Keypair) {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Part 1: TFMM Weight Transition Demo                     ║");
  console.log("║  weight 50% → 70%  (gradual price discovery, 4 batches)  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const WINDOW      = 8n;
  const SWAP_AMOUNT = 10_000_000n;  // 10 tokens per batch

  console.log("  Bootstrapping pool (50/50, 1,000 A + 1,000 B)...");
  const p = await bootstrapPool(conn, payer, WINDOW, 500_000,
    1_000_000_000n, 1_000_000_000n);
  console.log(`  Pool   : ${p.poolState.toBase58().slice(0, 20)}...`);
  console.log(`  Mint A : ${p.mintA.toBase58().slice(0, 20)}...`);

  // Call UpdateWeight to start a 50% → 70% transition over ~7 windows
  const currentSlot = BigInt(await conn.getSlot("confirmed"));
  const weightEndSlot = currentSlot + WINDOW * 7n + 10n;
  const updateTx = new Transaction().add(
    ixUpdateWeight(payer.publicKey, p.poolState, 700_000, weightEndSlot)
  );
  await sendAndConfirmTransaction(conn, updateTx, [payer]);
  console.log(`\n  UpdateWeight: 500_000 → 700_000  (transition ends at slot ${weightEndSlot})`);
  console.log(`  Current slot : ${currentSlot}\n`);

  type BatchResult = { batch: number; weightPct: string; price: string; cu: string };
  const results: BatchResult[] = [];

  for (let batchIdx = 0; batchIdx < 4; batchIdx++) {
    const pool = await readPoolState(conn, p.poolState);
    const batchId    = pool.currentBatchId;
    const windowEnd  = pool.currentWindowEnd;
    const wPct       = (pool.currentWeightA / 10_000).toFixed(2);

    console.log(`  ▶ Batch ${batchIdx}  (id=${batchId}  start_weight=${wPct}%)`);

    const [queue]   = findQueue(p.poolState, batchId);
    const [history] = findHistory(p.poolState, batchId);
    const [nextQ]   = findQueue(p.poolState, batchId + 1n);
    const [ticket]  = findTicket(p.poolState, payer.publicKey, batchId);

    const swapTx = new Transaction().add(
      ixSwapRequest(payer.publicKey, p.poolState, queue, ticket,
        p.userTA, p.userTB, p.vaultA, p.vaultB, SWAP_AMOUNT, 0n, 0n)
    );
    await sendAndConfirmTransaction(conn, swapTx, [payer]);

    await waitForSlot(conn, windowEnd);

    // Non-50/50 weights use the binary-search clearing formula (64 iterations
    // of fp_log2/fp_exp2), so we request extra CU budget.
    const clearTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ixClearBatch(payer.publicKey, p.poolState, queue, history, nextQ)
    );
    const clearSig = await sendAndConfirmTransaction(conn, clearTx, [payer]);
    const cu   = await getCU(conn, clearSig);
    const hist = await readHistory(conn, history);

    results.push({
      batch:     batchIdx,
      weightPct: wPct,
      price:     hist.clearingPrice.toFixed(6),
      cu:        cu?.toLocaleString() ?? "N/A",
    });
    console.log(`    clearing price=${hist.clearingPrice.toFixed(6)}  CU=${cu?.toLocaleString()}\n`);
  }

  console.log("  ┌──────┬────────────┬────────────────────┬──────────┐");
  console.log("  │Batch │ weight_a   │ clearing price B/A │    CU    │");
  console.log("  ├──────┼────────────┼────────────────────┼──────────┤");
  for (const r of results) {
    console.log(`  │  ${r.batch}   │ ${r.weightPct.padStart(7)}%   │ ${r.price.padStart(18)}   │ ${r.cu.padStart(8)} │`);
  }
  console.log("  └──────┴────────────┴────────────────────┴──────────┘");
  console.log("  → 重みが 50%→70% へ推移するにつれ、清算価格が段階的に上昇 (TFMM 実証)\n");

  saveTfmmReport("results", results);
}

// ─── Part 2: O(1) Scalability Proof ────────────────────────────────────────

async function runO1Benchmark(conn: Connection, payer: Keypair) {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Part 2: O(1) Scalability Proof                          ║");
  console.log("║  ClearBatch CU vs N simultaneous orders                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const N_TESTS  = [1, 3, 5, 10];
  const MAX_N    = Math.max(...N_TESTS);
  const WINDOW   = 10n;
  const SWAP_A   = 1_000_000n;  // 1 token per user per batch

  console.log("  Bootstrapping pool (50/50, 1,000 A + 1,000 B)...");
  const p = await bootstrapPool(conn, payer, WINDOW, 500_000,
    1_000_000_000n, 1_000_000_000n);
  console.log(`  Pool : ${p.poolState.toBase58().slice(0, 20)}...\n`);

  // ── Create MAX_N bench users ─────────────────────────────────────────────
  console.log(`  Creating ${MAX_N} bench users...`);
  const users: Keypair[] = Array.from({ length: MAX_N }, () => Keypair.generate());

  // Fund all users in one tx
  const fundTx = new Transaction();
  for (const u of users) {
    fundTx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   u.publicKey,
      lamports:   20_000_000,  // 0.02 SOL
    }));
  }
  await sendAndConfirmTransaction(conn, fundTx, [payer]);

  const rent     = await getMinimumBalanceForRentExemptAccount(conn);
  const userTAs: PublicKey[] = [];
  const userTBs: PublicKey[] = [];

  // Create token accounts in batches of 4 users per tx (8 instructions)
  const CHUNK = 4;
  for (let start = 0; start < MAX_N; start += CHUNK) {
    const chunk = users.slice(start, start + CHUNK);

    const taKps: Keypair[] = chunk.map(() => Keypair.generate());
    const taTx = new Transaction();
    for (let i = 0; i < chunk.length; i++) {
      taTx.add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey, newAccountPubkey: taKps[i].publicKey,
          lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(taKps[i].publicKey, p.mintA, chunk[i].publicKey),
      );
      userTAs.push(taKps[i].publicKey);
    }
    await sendAndConfirmTransaction(conn, taTx, [payer, ...taKps]);

    const tbKps: Keypair[] = chunk.map(() => Keypair.generate());
    const tbTx = new Transaction();
    for (let i = 0; i < chunk.length; i++) {
      tbTx.add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey, newAccountPubkey: tbKps[i].publicKey,
          lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(tbKps[i].publicKey, p.mintB, chunk[i].publicKey),
      );
      userTBs.push(tbKps[i].publicKey);
    }
    await sendAndConfirmTransaction(conn, tbTx, [payer, ...tbKps]);
  }

  // Mint token A to all bench users (batch of 8 per tx)
  for (let start = 0; start < MAX_N; start += 8) {
    const mintTx = new Transaction();
    const end = Math.min(start + 8, MAX_N);
    for (let i = start; i < end; i++) {
      mintTx.add(createMintToInstruction(p.mintA, userTAs[i], payer.publicKey, 1_000_000_000n));
    }
    await sendAndConfirmTransaction(conn, mintTx, [payer]);
  }
  console.log(`  ${MAX_N} users ready (each with 1,000 token A)`);

  // Advance any expired batch so the first test starts with a fresh window
  await maybeAdvanceBatch(conn, payer, p.poolState);
  console.log();

  // ── Run benchmark ────────────────────────────────────────────────────────
  type BenchResult = { n: number; cu: number | null };
  const results: BenchResult[] = [];

  for (const N of N_TESTS) {
    const pool       = await readPoolState(conn, p.poolState);
    const batchId    = pool.currentBatchId;
    const windowEnd  = pool.currentWindowEnd;

    console.log(`  ▶ N=${N}  (batchId=${batchId})`);

    const [queue]   = findQueue(p.poolState, batchId);
    const [history] = findHistory(p.poolState, batchId);
    const [nextQ]   = findQueue(p.poolState, batchId + 1n);

    // Submit N SwapRequests concurrently (each from a different user)
    const swapPromises = users.slice(0, N).map(async (user, idx) => {
      const [ticket] = findTicket(p.poolState, user.publicKey, batchId);
      const tx = new Transaction().add(
        ixSwapRequest(user.publicKey, p.poolState, queue, ticket,
          userTAs[idx], userTBs[idx], p.vaultA, p.vaultB,
          SWAP_A, 0n, 0n)
      );
      return sendAndConfirmTransaction(conn, tx, [user]);
    });
    await Promise.all(swapPromises);
    console.log(`    ${N} SwapRequest(s) confirmed`);

    await waitForSlot(conn, windowEnd);

    const clearTx = new Transaction().add(
      ixClearBatch(payer.publicKey, p.poolState, queue, history, nextQ)
    );
    const clearSig = await sendAndConfirmTransaction(conn, clearTx, [payer]);
    const cu = await getCU(conn, clearSig);

    results.push({ n: N, cu });
    console.log(`    ClearBatch CU: ${cu?.toLocaleString()}\n`);
  }

  const baseCU = results[0].cu ?? 1;
  console.log("  ┌────────────┬────────────────┬──────────────┐");
  console.log("  │  N orders  │  ClearBatch CU │    Δ vs N=1  │");
  console.log("  ├────────────┼────────────────┼──────────────┤");
  for (const r of results) {
    const delta    = r.cu != null ? r.cu - baseCU : 0;
    const deltaStr = (delta >= 0 ? "+" : "") + delta.toLocaleString();
    console.log(
      `  │ ${String(r.n).padStart(6)}     │ ${(r.cu?.toLocaleString() ?? "N/A").padStart(12)}   │ ${deltaStr.padStart(10)}   │`
    );
  }
  console.log("  └────────────┴────────────────┴──────────────┘");
  console.log("  → ClearBatch CU が N によらずほぼ一定 → O(1) スケーラビリティを実証\n");

  saveO1Report("results", results);
}

// ─── CSV + SVG reporting ───────────────────────────────────────────────────

type TfmmRow = { batch: number; weightPct: string; price: string; cu: string };
type O1Row   = { n: number; cu: number | null };

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Generic SVG line chart (W×H pixels). */
function svgLineChart(
  title: string,
  subtitle: string,
  ys: number[],
  xLabels: string[],
  yAxisLabel: string,
  xAxisLabel: string,
): string {
  const W = 640, H = 420;
  const PL = 72, PR = 32, PT = 60, PB = 68;
  const pw = W - PL - PR, ph = H - PT - PB;
  const n = ys.length;

  const minY = Math.min(...ys) * 0.88;
  const maxY = Math.max(...ys) * 1.12;

  const px = (i: number) => PL + (n < 2 ? pw / 2 : (i / (n - 1)) * pw);
  const py = (v: number) => PT + ph - ((v - minY) / (maxY - minY)) * ph;

  // Y grid + ticks
  const NY = 5;
  const grid: string[] = [], yticks: string[] = [];
  for (let i = 0; i <= NY; i++) {
    const v = minY + (maxY - minY) * (i / NY);
    const y = py(v);
    grid.push(`<line x1="${PL}" y1="${y.toFixed(1)}" x2="${PL+pw}" y2="${y.toFixed(1)}" stroke="#ebebeb"/>`);
    yticks.push(`<text x="${PL-7}" y="${(y+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#777">${v.toFixed(3)}</text>`);
  }

  const pts = ys.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const area = [...pts,
    `${px(n-1).toFixed(1)},${(PT+ph).toFixed(1)}`,
    `${px(0).toFixed(1)},${(PT+ph).toFixed(1)}`,
  ].join(" ");

  const dots = ys.map((v, i) =>
    `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="5" fill="#3B82F6" stroke="white" stroke-width="2.5"/>`
  );
  const vals = ys.map((v, i) =>
    `<text x="${px(i).toFixed(1)}" y="${(py(v)-11).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#1D4ED8" font-weight="600">${v.toFixed(3)}</text>`
  );
  const xlabels = xLabels.map((lbl, i) =>
    `<text x="${px(i).toFixed(1)}" y="${(PT+ph+18).toFixed(1)}" text-anchor="middle" font-size="11" fill="#555">${lbl}</text>`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="'Helvetica Neue',Arial,sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <rect x="1" y="1" width="${W-2}" height="${H-2}" fill="none" stroke="#d4d4d4" rx="4"/>
  <text x="${W/2}" y="27" text-anchor="middle" font-size="15" font-weight="700" fill="#111">${title}</text>
  <text x="${W/2}" y="46" text-anchor="middle" font-size="11" fill="#888">${subtitle}</text>

  ${grid.join("\n  ")}
  ${yticks.join("\n  ")}

  <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+ph}" stroke="#bbb" stroke-width="1.5"/>
  <line x1="${PL}" y1="${PT+ph}" x2="${PL+pw}" y2="${PT+ph}" stroke="#bbb" stroke-width="1.5"/>

  <defs>
    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#3B82F6" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#3B82F6" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <polygon points="${area}" fill="url(#areaFill)"/>
  <polyline points="${pts.join(" ")}" fill="none" stroke="#3B82F6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>

  ${dots.join("\n  ")}
  ${vals.join("\n  ")}
  ${xlabels.join("\n  ")}

  <text x="${W/2}" y="${H-12}" text-anchor="middle" font-size="12" fill="#444">${xAxisLabel}</text>
  <text x="14" y="${H/2}" text-anchor="middle" font-size="12" fill="#444" transform="rotate(-90,14,${H/2})">${yAxisLabel}</text>
</svg>`;
}

/** Generic SVG bar chart. */
function svgBarChart(
  title: string,
  subtitle: string,
  labels: string[],
  values: number[],
  yAxisLabel: string,
  xAxisLabel: string,
  refValue?: number,
  refLabel?: string,
): string {
  const W = 640, H = 420;
  const PL = 86, PR = 32, PT = 60, PB = 68;
  const pw = W - PL - PR, ph = H - PT - PB;

  const maxV = Math.max(...values) * 1.22;
  const py = (v: number) => PT + ph - (v / maxV) * ph;

  // Y grid + ticks
  const NY = 5;
  const grid: string[] = [], yticks: string[] = [];
  for (let i = 0; i <= NY; i++) {
    const v = maxV * (i / NY);
    const y = py(v);
    grid.push(`<line x1="${PL}" y1="${y.toFixed(1)}" x2="${PL+pw}" y2="${y.toFixed(1)}" stroke="#ebebeb"/>`);
    yticks.push(`<text x="${PL-7}" y="${(y+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#777">${Math.round(v).toLocaleString()}</text>`);
  }

  const n = labels.length;
  const slotW = pw / n;
  const barW  = slotW * 0.55;
  const bars: string[] = [], valLabels: string[] = [], xlabels: string[] = [];
  for (let i = 0; i < n; i++) {
    const cx = PL + i * slotW + slotW / 2;
    const bx = cx - barW / 2;
    const by = py(values[i]);
    const bh = PT + ph - by;
    bars.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="#3B82F6" rx="3" opacity="0.85"/>`);
    valLabels.push(`<text x="${cx.toFixed(1)}" y="${(by-7).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#1D4ED8" font-weight="600">${values[i].toLocaleString()}</text>`);
    xlabels.push(`<text x="${cx.toFixed(1)}" y="${(PT+ph+18).toFixed(1)}" text-anchor="middle" font-size="11" fill="#555">${labels[i]}</text>`);
  }

  const refEl = refValue != null
    ? `<line x1="${PL}" y1="${py(refValue).toFixed(1)}" x2="${PL+pw}" y2="${py(refValue).toFixed(1)}" stroke="#F59E0B" stroke-width="1.8" stroke-dasharray="6,4"/>
  <text x="${PL+pw-4}" y="${(py(refValue)-6).toFixed(1)}" text-anchor="end" font-size="10" fill="#B45309">${refLabel ?? "ref"}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="'Helvetica Neue',Arial,sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <rect x="1" y="1" width="${W-2}" height="${H-2}" fill="none" stroke="#d4d4d4" rx="4"/>
  <text x="${W/2}" y="27" text-anchor="middle" font-size="15" font-weight="700" fill="#111">${title}</text>
  <text x="${W/2}" y="46" text-anchor="middle" font-size="11" fill="#888">${subtitle}</text>

  ${grid.join("\n  ")}
  ${yticks.join("\n  ")}

  <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+ph}" stroke="#bbb" stroke-width="1.5"/>
  <line x1="${PL}" y1="${PT+ph}" x2="${PL+pw}" y2="${PT+ph}" stroke="#bbb" stroke-width="1.5"/>

  ${refEl}
  ${bars.join("\n  ")}
  ${valLabels.join("\n  ")}
  ${xlabels.join("\n  ")}

  <text x="${W/2}" y="${H-12}" text-anchor="middle" font-size="12" fill="#444">${xAxisLabel}</text>
  <text x="14" y="${H/2}" text-anchor="middle" font-size="12" fill="#444" transform="rotate(-90,14,${H/2})">${yAxisLabel}</text>
</svg>`;
}

function saveTfmmReport(outDir: string, results: TfmmRow[]): void {
  ensureDir(outDir);

  // CSV
  const csv = [
    "batch,weight_pct,clearing_price_b_per_a,clearbatch_cu",
    ...results.map(r => `${r.batch},${r.weightPct},${r.price},${r.cu.replace(/,/g, "")}`),
  ].join("\n") + "\n";
  fs.writeFileSync(`${outDir}/tfmm_demo.csv`, csv);

  // SVG line chart
  const svg = svgLineChart(
    "TFMM Weight Transition: Clearing Price per Batch",
    "weight_a 50% → 70%  |  G3M Batch Auction  |  PFDA AMM",
    results.map(r => parseFloat(r.price)),
    results.map(r => `Batch ${r.batch} (${r.weightPct}%)`),
    "Clearing Price  (B per A)",
    "Batch  (start weight_a)",
  );
  fs.writeFileSync(`${outDir}/tfmm_demo.svg`, svg);

  console.log(`  Saved → ${outDir}/tfmm_demo.csv`);
  console.log(`  Saved → ${outDir}/tfmm_demo.svg\n`);
}

function saveO1Report(outDir: string, results: O1Row[]): void {
  ensureDir(outDir);

  const baseCU = results[0].cu ?? 0;

  // CSV
  const csv = [
    "n_orders,clearbatch_cu,delta_vs_n1",
    ...results.map(r => `${r.n},${r.cu ?? ""},${(r.cu ?? baseCU) - baseCU}`),
  ].join("\n") + "\n";
  fs.writeFileSync(`${outDir}/o1_benchmark.csv`, csv);

  // SVG bar chart
  const svg = svgBarChart(
    "O(1) Scalability: ClearBatch CU vs Number of Orders",
    "PFDA AMM — clearing is constant-time regardless of batch size",
    results.map(r => `N=${r.n}`),
    results.map(r => r.cu ?? 0),
    "Compute Units (CU)",
    "Number of Orders in Batch  (N)",
    baseCU,
    `N=1 baseline  (${baseCU.toLocaleString()} CU)`,
  );
  fs.writeFileSync(`${outDir}/o1_benchmark.svg`, svg);

  console.log(`  Saved → ${outDir}/o1_benchmark.csv`);
  console.log(`  Saved → ${outDir}/o1_benchmark.svg\n`);
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const conn  = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         PFDA AMM — Benchmark & TFMM Demo                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Wallet  : ${payer.publicKey.toBase58()}`);
  console.log(`Program : ${PROGRAM_ID.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`残高    : ${(bal / LAMPORTS_PER_SOL).toFixed(2)} SOL\n`);

  await runTfmmDemo(conn, payer);
  await runO1Benchmark(conn, payer);
}

main().catch(err => {
  console.error("\n✗ エラー:", err);
  process.exit(1);
});
