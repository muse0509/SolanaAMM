import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  SOL_MINT,
  deserializeIx,
  fetchAltAccounts,
  getSwapInstructions,
  type JupiterQuoteResponse,
} from "./jupiter";
import {
  buildJupiterSeedPreview,
  liveJupiterQuoteClient,
  type JupiterQuoteClient,
  type JupiterSeedPreview,
} from "./jupiterSeed";
import { u64Le } from "./ix";

/// Solana protocol-defined upper bound on a single transaction's CU
/// limit. Multi-leg Jupiter routes will easily push us against this.
export const SOLANA_MAX_TX_CU = 1_400_000;
/// Wire-encoded versioned-tx size cap (signatures + message).
export const SOLANA_MAX_TX_BYTES = 1232;
/// Lamports of priority fee per CU when Jupiter doesn't supply one.
const FALLBACK_PRIORITY_MICRO_LAMPORTS = 50_000;
/// Mirrors `axis-vault` constants: `MIN_FIRST_DEPOSIT = 10_000`
/// (= 0.01 ETF at 6 decimals). On-chain Deposit rejects with
/// `InsufficientFirstDeposit` (0x233a) if `total_supply == 0` and
/// `amount < MIN_FIRST_DEPOSIT_BASE`. We mirror the constant here so a
/// doomed plan fails before a Jupiter swap tx burns user funds.
export const MIN_FIRST_DEPOSIT_BASE = 10_000n;

export interface DepositSolPlanArgs {
  conn: Connection;
  user: PublicKey;
  programId: PublicKey;
  etfName: string;
  etfState: PublicKey;
  etfMint: PublicKey;
  treasury: PublicKey;
  treasuryEtfAta: PublicKey;
  basketMints: PublicKey[];
  weights: number[];
  vaults: PublicKey[];
  solIn: bigint;
  minEtfOut: bigint;
  slippageBps?: number;
  /// Cap on accounts per leg's Jupiter swap ix. Default 16; lower
  /// values force simpler routes that are more likely to fit in one tx.
  maxAccounts?: number;
  /// Pre-fetched ETF totalSupply, if known. When > 0 the plan skips
  /// the `MIN_FIRST_DEPOSIT_BASE` floor (only first deposits are
  /// gated). Defaults to undefined → assume first deposit.
  existingEtfTotalSupply?: bigint;
  /// Override Jupiter's per-CU priority fee. Leave undefined to inherit
  /// the higher of (Jupiter's default, FALLBACK_PRIORITY_MICRO_LAMPORTS).
  priorityMicroLamports?: number;
  quoteClient?: JupiterQuoteClient;
}

export interface DepositSolPlan {
  /// "single" — one v0 tx covering swap + Deposit (preferred).
  /// "split" — two v0 txs because the combined message blew past
  /// the 1232-byte wire cap. tx0 wraps SOL + runs Jupiter swaps to land
  /// basket tokens in the user's basket ATAs; tx1 calls axis Deposit.
  /// Caller signs and sends them in order; if the user aborts between
  /// them, basket tokens stay in the user's ATAs and they can re-run
  /// the Deposit half (or sweep the tokens manually).
  mode: "single" | "split";
  versionedTx: VersionedTransaction;
  /// Set on `mode === "split"` only: the second tx (axis Deposit).
  depositTx?: VersionedTransaction;
  altAccounts: AddressLookupTableAccount[];
  quotes: JupiterQuoteResponse[];
  depositAmount: bigint;
  expectedBasketAmounts: bigint[];
  seedPreview: JupiterSeedPreview;
  ixCount: number;
  /// Serialized v0-message size. Useful for surfacing "tx too large"
  /// errors before the user signs.
  txBytes: number;
  /// Total CU limit set on the tx. May hit SOLANA_MAX_TX_CU on
  /// 3-leg flows; that's the protocol max, so further reduction
  /// requires splitting into two transactions.
  computeUnitLimit: number;
  computeUnitPrice: number;
}

function buildAxisDepositIx(
  programId: PublicKey,
  user: PublicKey,
  etfState: PublicKey,
  etfMint: PublicKey,
  userEtfAta: PublicKey,
  treasuryEtfAta: PublicKey,
  userBasketAtas: PublicKey[],
  vaults: PublicKey[],
  etfName: string,
  amount: bigint,
  minMintOut: bigint,
): TransactionInstruction {
  const nameBytes = Buffer.from(etfName);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: etfState, isSigner: false, isWritable: true },
      { pubkey: etfMint, isSigner: false, isWritable: true },
      { pubkey: userEtfAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: treasuryEtfAta, isSigner: false, isWritable: true },
      ...userBasketAtas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
      ...vaults.map((v) => ({ pubkey: v, isSigner: false, isWritable: true })),
    ],
    data: Buffer.concat([
      Buffer.from([1]),
      u64Le(amount),
      u64Le(minMintOut),
      Buffer.from([nameBytes.length]),
      nameBytes,
    ]),
  });
}

/// Decode the values Jupiter encodes in its compute-budget instructions
/// so we can merge them across legs and override safely.
interface DecodedComputeBudget {
  cuLimit: number | null;
  microLamportsPerCu: number | null;
}

function decodeComputeBudgetIx(ix: TransactionInstruction): DecodedComputeBudget {
  const data = ix.data;
  if (data.length === 0) return { cuLimit: null, microLamportsPerCu: null };
  // ComputeBudgetProgram opcodes:
  //   0x02 = SetComputeUnitLimit(units: u32)
  //   0x03 = SetComputeUnitPrice(micro_lamports: u64)
  if (data[0] === 0x02 && data.length >= 5) {
    return { cuLimit: data.readUInt32LE(1), microLamportsPerCu: null };
  }
  if (data[0] === 0x03 && data.length >= 9) {
    // Jupiter prices are u64 but always fit in u32 for any reasonable fee.
    const lo = data.readUInt32LE(1);
    const hi = data.readUInt32LE(5);
    return { cuLimit: null, microLamportsPerCu: lo + hi * 0x1_0000_0000 };
  }
  return { cuLimit: null, microLamportsPerCu: null };
}

/// Sum Jupiter's per-leg CU budgets, max out at the protocol cap, and
/// pick the highest priority price across legs (Jupiter often sets a
/// dynamic value derived from getRecentPrioritizationFees on the route's
/// accounts; the highest leg is the right floor to clear all of them).
function buildComputeBudgetIxs(
  legBudgets: DecodedComputeBudget[][],
  override?: number,
): { ixs: TransactionInstruction[]; cuLimit: number; cuPrice: number } {
  let cuSum = 0;
  let microLamportsMax = 0;
  for (const leg of legBudgets) {
    for (const item of leg) {
      if (item.cuLimit !== null) cuSum += item.cuLimit;
      if (item.microLamportsPerCu !== null && item.microLamportsPerCu > microLamportsMax) {
        microLamportsMax = item.microLamportsPerCu;
      }
    }
  }
  // 100k headroom for axis-vault Deposit + ATA creates + wrap/sync/close.
  const cuLimit = Math.min(SOLANA_MAX_TX_CU, Math.max(400_000, cuSum + 100_000));
  const cuPrice =
    override !== undefined
      ? override
      : Math.max(microLamportsMax, FALLBACK_PRIORITY_MICRO_LAMPORTS);
  return {
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ],
    cuLimit,
    cuPrice,
  };
}

/// Stable key for ix-level dedup. Idempotent ATA creates and Jupiter's
/// shared-account setup ixs sometimes appear with identical data but
/// out-of-order keys; sorting writability flags out is too aggressive,
/// so we keep the (pubkey, isSigner, isWritable) tuple intact and rely
/// on programId+keys+data byte-equality but also fold ATA-creation
/// duplicates by inspecting the destination ATA pubkey explicitly.
function ixDedupKey(ix: TransactionInstruction): string {
  return [
    ix.programId.toBase58(),
    ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 1 : 0}:${k.isWritable ? 1 : 0}`).join("|"),
    ix.data.toString("base64"),
  ].join("#");
}

export async function buildDepositSolPlan(
  args: DepositSolPlanArgs,
): Promise<DepositSolPlan> {
  const n = args.basketMints.length;
  if (n !== args.weights.length || n !== args.vaults.length) {
    throw new Error("basketMints / weights / vaults length mismatch");
  }
  const weightSum = args.weights.reduce((a, b) => a + b, 0);
  if (weightSum !== 10_000) {
    throw new Error(`weights must sum to 10_000, got ${weightSum}`);
  }
  if (args.solIn <= 0n) {
    throw new Error("SOL input must be greater than zero");
  }
  if (n < 2 || n > 5) {
    throw new Error(`basket size must be 2..5; got ${n}`);
  }

  // Pre-flight: user must have enough SOL for the deposit + tx fees +
  // wSOL ATA rent (≈ 0.00203928 SOL). We add a 0.005 SOL slack for tx
  // fee + priority fees (priority fee ≈ 70_000 lamports at 50k μL/CU).
  const RENT_WSOL_ATA = 2_039_280n;
  const RESERVE_FOR_FEES = 5_000_000n;
  const balanceLamports = BigInt(await args.conn.getBalance(args.user, "confirmed"));
  if (balanceLamports < args.solIn + RENT_WSOL_ATA + RESERVE_FOR_FEES) {
    throw new Error(
      `Insufficient SOL: need ${(
        args.solIn + RENT_WSOL_ATA + RESERVE_FOR_FEES
      ).toString()} lamports (deposit + wSOL rent + fee reserve), have ${balanceLamports.toString()}`,
    );
  }

  const slippageBps = args.slippageBps ?? 50;
  const maxAccounts = args.maxAccounts ?? 16;
  const userBasketAtas = args.basketMints.map((m) =>
    getAssociatedTokenAddressSync(m, args.user, false),
  );
  const userEtfAta = getAssociatedTokenAddressSync(args.etfMint, args.user, false);
  const userWsolAta = getAssociatedTokenAddressSync(SOL_MINT, args.user, false);

  // If the user already has a wSOL ATA with a non-zero balance (e.g. they
  // are using wSOL as collateral elsewhere), do NOT close it at the end:
  // closing would unwrap their pre-existing wSOL back to native SOL,
  // disturbing state outside of this transaction.
  const wsolInfo = await args.conn.getAccountInfo(userWsolAta, "confirmed");
  let preExistingWsolBalance = 0n;
  if (wsolInfo) {
    try {
      const bal = await args.conn.getTokenAccountBalance(userWsolAta, "confirmed");
      preExistingWsolBalance = BigInt(bal.value.amount);
    } catch {
      preExistingWsolBalance = 0n;
    }
  }
  const closeWsolAtEnd = preExistingWsolBalance === 0n;

  // Quote the legs. Surfaces per-leg failure with the leg index so the
  // panel can render "leg 2 (USDC) failed" instead of a bare HTTP error.
  let seedPreview: JupiterSeedPreview;
  try {
    seedPreview = await buildJupiterSeedPreview({
      basketMints: args.basketMints,
      weights: args.weights,
      solIn: args.solIn,
      slippageBps,
      maxAccounts,
      quoteClient: args.quoteClient ?? liveJupiterQuoteClient,
    });
  } catch (e) {
    throw new Error(
      `Jupiter quote failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const quotes = seedPreview.legs.map((leg) => leg.quote);

  // First-deposit floor. Catch this BEFORE swap-instructions so a
  // doomed plan never burns the user a Jupiter swap tx. The on-chain
  // check is `etf.total_supply == 0 && amount < MIN_FIRST_DEPOSIT` →
  // `InsufficientFirstDeposit (0x233a)`; subsequent deposits are
  // unconstrained.
  const isFirstDeposit = (args.existingEtfTotalSupply ?? 0n) === 0n;
  if (isFirstDeposit && seedPreview.depositAmount < MIN_FIRST_DEPOSIT_BASE) {
    // Linear projection: scale the SOL input proportionally to clear
    // the floor, plus a 10 % safety margin for route price drift.
    const suggestedLamports =
      (args.solIn * MIN_FIRST_DEPOSIT_BASE * 11n) /
      (seedPreview.depositAmount * 10n);
    throw new Error(
      `First deposit must yield ≥ ${MIN_FIRST_DEPOSIT_BASE} base units (0.01 ETF). ` +
        `At ${args.solIn} lamports (${(Number(args.solIn) / 1e9).toFixed(6)} SOL) the bottleneck floor is ` +
        `${seedPreview.depositAmount} base. Increase SOL seed to at least ` +
        `~${suggestedLamports} lamports (≈ ${(Number(suggestedLamports) / 1e9).toFixed(4)} SOL) and retry. ` +
        `Bottleneck leg: ${seedPreview.legs[seedPreview.bottleneckIndex].mint.toBase58()}.`,
    );
  }

  // Per-leg swap-instructions. wrapAndUnwrapSol must be FALSE because we
  // wrap once into userWsolAta below; otherwise leg N's setup would
  // create a fresh wSOL ATA that conflicts with leg N+1's read.
  const swapBundles = await Promise.all(
    quotes.map((quote, i) =>
      getSwapInstructions({
        quote,
        userPublicKey: args.user,
        destinationTokenAccount: userBasketAtas[i],
        wrapAndUnwrapSol: false,
      }).catch((e) => {
        throw new Error(
          `Jupiter swap-instructions failed for leg ${i} (${args.basketMints[i].toBase58().slice(0, 8)}…): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }),
    ),
  );

  const depositAmount = seedPreview.depositAmount;

  // Compute budget: aggregate Jupiter's per-leg estimate, top up for our
  // own ix surface (axis Deposit, ATA creates, wrap/sync/close), cap at
  // protocol max.
  const legBudgets = swapBundles.map((b) =>
    b.computeBudgetInstructions.map((raw) => decodeComputeBudgetIx(deserializeIx(raw))),
  );
  const cb = buildComputeBudgetIxs(legBudgets, args.priorityMicroLamports);

  // Build the ix sequence. We try to fit everything in one tx; if that
  // overflows the 1232-byte wire cap we re-split into two: tx0 = wrap +
  // swaps (lands basket tokens in user's basket ATAs), tx1 = axis
  // Deposit (consumes them).
  const ataCreates = [
    createAssociatedTokenAccountIdempotentInstruction(
      args.user,
      userWsolAta,
      args.user,
      SOL_MINT,
    ),
    ...args.basketMints.map((mint, i) =>
      createAssociatedTokenAccountIdempotentInstruction(
        args.user,
        userBasketAtas[i],
        args.user,
        mint,
      ),
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      args.user,
      userEtfAta,
      args.user,
      args.etfMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      args.user,
      args.treasuryEtfAta,
      args.treasury,
      args.etfMint,
    ),
  ];

  const wrapIxs = [
    SystemProgram.transfer({
      fromPubkey: args.user,
      toPubkey: userWsolAta,
      lamports: Number(args.solIn),
    }),
    createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID),
  ];

  const swapIxs: TransactionInstruction[] = [];
  const seen = new Set<string>();
  const pushDedup = (target: TransactionInstruction[], ix: TransactionInstruction) => {
    const key = ixDedupKey(ix);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(ix);
    }
  };
  for (const bundle of swapBundles) {
    for (const raw of bundle.setupInstructions) pushDedup(swapIxs, deserializeIx(raw));
    pushDedup(swapIxs, deserializeIx(bundle.swapInstruction));
    if (bundle.cleanupInstruction) {
      pushDedup(swapIxs, deserializeIx(bundle.cleanupInstruction));
    }
  }

  const closeWsolIxs = closeWsolAtEnd
    ? [createCloseAccountInstruction(userWsolAta, args.user, args.user, [], TOKEN_PROGRAM_ID)]
    : [];

  const depositIx = buildAxisDepositIx(
    args.programId,
    args.user,
    args.etfState,
    args.etfMint,
    userEtfAta,
    args.treasuryEtfAta,
    userBasketAtas,
    args.vaults,
    args.etfName,
    depositAmount,
    args.minEtfOut,
  );

  const altAccounts = await fetchAltAccounts(
    args.conn,
    swapBundles.flatMap((b) => b.addressLookupTableAddresses),
  );
  const { blockhash } = await args.conn.getLatestBlockhash("confirmed");

  // Try the single-tx path first.
  const singleIxs = [
    ...cb.ixs,
    ...ataCreates,
    ...wrapIxs,
    ...swapIxs,
    depositIx,
    ...closeWsolIxs,
  ];
  const singleAttempt = tryCompileV0(args.user, blockhash, singleIxs, altAccounts);

  if (singleAttempt.ok) {
    return {
      mode: "single",
      versionedTx: new VersionedTransaction(singleAttempt.message),
      altAccounts,
      quotes,
      depositAmount,
      expectedBasketAmounts: quotes.map((q) => BigInt(q.outAmount)),
      seedPreview,
      ixCount: singleIxs.length,
      txBytes: singleAttempt.bytes,
      computeUnitLimit: cb.cuLimit,
      computeUnitPrice: cb.cuPrice,
    };
  }

  // Fallback: split. tx0 wraps + swaps + (optional) close; tx1 is the
  // axis Deposit alone. The Deposit is small enough to always fit
  // because it has no Jupiter route accounts.
  // For the split path we cannot close wSOL in tx0 because the user's
  // basket-token balances must remain stable for tx1's deposit math;
  // however we can drop closeWsolIxs entirely (user's leftover wSOL
  // becomes a tiny dust that they can manually close later, ~0.002 SOL
  // rent-locked).
  const swapTxIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cb.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cb.cuPrice }),
    ...ataCreates,
    ...wrapIxs,
    ...swapIxs,
  ];
  const depositTxIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cb.cuPrice }),
    depositIx,
    ...closeWsolIxs,
  ];

  const swapAttempt = tryCompileV0(args.user, blockhash, swapTxIxs, altAccounts);
  if (!swapAttempt.ok) {
    throw new Error(
      `Even after splitting, the Jupiter swap leg blew the 1232-byte wire cap ` +
        `(estimated ${swapAttempt.bytes ?? "?"} bytes; ix count ${swapTxIxs.length}; ` +
        `static keys ${swapAttempt.staticKeys ?? "?"}; ALT addresses ${altAccounts.length}). ` +
        `Try a smaller basket (2 mints), lower the per-leg \`maxAccounts\` (currently ${maxAccounts}), ` +
        `or pick mints with simpler Jupiter routes. Underlying error: ${swapAttempt.error}`,
    );
  }
  const depositAttempt = tryCompileV0(args.user, blockhash, depositTxIxs, []);
  if (!depositAttempt.ok) {
    // Should never trip — Deposit is a fixed handful of accounts.
    throw new Error(
      `axis Deposit half of the split flow failed to compile: ${depositAttempt.error}`,
    );
  }

  return {
    mode: "split",
    versionedTx: new VersionedTransaction(swapAttempt.message),
    depositTx: new VersionedTransaction(depositAttempt.message),
    altAccounts,
    quotes,
    depositAmount,
    expectedBasketAmounts: quotes.map((q) => BigInt(q.outAmount)),
    seedPreview,
    ixCount: swapTxIxs.length + depositTxIxs.length,
    txBytes: swapAttempt.bytes,
    computeUnitLimit: cb.cuLimit,
    computeUnitPrice: cb.cuPrice,
  };
}

/// Compile a v0 message and report wire size, swallowing the
/// "encoding overruns Uint8Array" RangeError that web3.js raises when
/// the serialized message exceeds 1232 bytes. Lets the caller decide
/// whether to retry, split, or surface a friendly error.
export type CompileAttempt =
  | { ok: true; message: ReturnType<TransactionMessage["compileToV0Message"]>; bytes: number; staticKeys: number }
  | { ok: false; bytes: number | null; staticKeys: number | null; error: string };

export function tryCompileV0(
  payerKey: PublicKey,
  recentBlockhash: string,
  instructions: TransactionInstruction[],
  altAccounts: AddressLookupTableAccount[],
): CompileAttempt {
  let message;
  try {
    message = new TransactionMessage({
      payerKey,
      recentBlockhash,
      instructions,
    }).compileToV0Message(altAccounts);
  } catch (e) {
    return {
      ok: false,
      bytes: null,
      staticKeys: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  let bytes: number;
  try {
    bytes = message.serialize().length + 1 + 64;
  } catch (e) {
    return {
      ok: false,
      bytes: null,
      staticKeys: message.staticAccountKeys.length,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (bytes > SOLANA_MAX_TX_BYTES) {
    return {
      ok: false,
      bytes,
      staticKeys: message.staticAccountKeys.length,
      error: `serialized ${bytes} bytes > ${SOLANA_MAX_TX_BYTES} cap`,
    };
  }
  return { ok: true, message, bytes, staticKeys: message.staticAccountKeys.length };
}
