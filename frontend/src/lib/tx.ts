import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/// Wallet-adapter expects a Transaction with a recentBlockhash + feePayer.
/// We assemble it here and then call `sendTransaction` with the extra
/// signers (so freshly-generated mint/vault keypairs co-sign).
///
/// Wraps errors so the panel-level catch can show the actual program
/// error code + the last few program log lines, instead of the
/// stringly-generic "Unexpected error" wallet-adapter surfaces by
/// default. axis-vault / pfda-amm-3 errors mostly look like
/// `custom program error: 0x2336` and are useless without that prefix.
export async function sendTx(
  conn: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet not connected");
  }
  await assertFeePayerExists(conn, wallet.publicKey);

  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = wallet.publicKey as PublicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed",
  );
  tx.recentBlockhash = blockhash;

  // Pre-flight simulation BEFORE handing to the wallet. Wallet adapters
  // (Phantom in particular) wrap SendTransactionError into their own
  // WalletSendTransactionError and drop the program logs along the way,
  // so we always end up with a useless "Unexpected error" string. By
  // simulating ourselves with the unsigned tx (additional signers
  // partial-signed locally so simulate doesn't reject for missing
  // signatures), we surface the real program error before the wallet
  // ever sees the bytes.
  //
  // We then pass the already-partial-signed tx + the same signers list
  // to the wallet. Solana's sendTransaction merges signatures so the
  // pre-applied ones are kept and the wallet only signs as feePayer.
  if (signers.length > 0) {
    tx.partialSign(...signers);
  }
  // sigVerify defaults to false for the 1-arg form, so the missing
  // feePayer signature doesn't blow up simulate.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw enrichSimError(sim.value.err, logs);
  }

  try {
    const sig = await wallet.sendTransaction(tx, conn, {
      signers,
      preflightCommitment: "confirmed",
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  } catch (e) {
    throw await enrichTxError(conn, e);
  }
}

export async function sendVersionedTx(
  conn: Connection,
  wallet: WalletContextState,
  tx: VersionedTransaction,
): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet not connected");
  }
  await assertFeePayerExists(conn, wallet.publicKey);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed",
  );
  tx.message.recentBlockhash = blockhash;

  const sim = await conn.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: false,
  });
  if (sim.value.err) {
    throw enrichSimError(sim.value.err, sim.value.logs ?? []);
  }

  try {
    const sig = await wallet.sendTransaction(tx, conn, {
      preflightCommitment: "confirmed",
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  } catch (e) {
    throw await enrichTxError(conn, e);
  }
}

async function assertFeePayerExists(
  conn: Connection,
  feePayer: PublicKey,
): Promise<void> {
  const feePayerInfo = await conn.getAccountInfo(feePayer, "confirmed");
  if (!feePayerInfo) {
    throw new Error(
      "Fee payer account not found on this cluster. Fund the wallet before sending transactions.",
    );
  }
}

/// Build a friendly Error from a simulateTransaction result, walking
/// the (`{ InstructionError: [ix_idx, { Custom: code } ]}` | string)
/// shape Solana RPC returns.
function enrichSimError(err: unknown, logs: string[]): Error {
  let codeHex: string | null = null;
  let ixIdx: number | null = null;
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const ie = (err as { InstructionError: [number, unknown] }).InstructionError;
    ixIdx = ie[0];
    const inner = ie[1];
    if (typeof inner === "object" && inner !== null && "Custom" in inner) {
      const code = (inner as { Custom: number }).Custom;
      codeHex = "0x" + code.toString(16);
    }
  }
  // Logs sometimes also encode the code in plaintext.
  if (!codeHex) {
    const m = logs.join("\n").match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (m) codeHex = m[1].toLowerCase();
  }
  const friendly = codeHex ? labelForCode(codeHex) : null;
  const head = friendly
    ? `${friendly} (${codeHex}) at instruction #${ixIdx ?? "?"}`
    : `simulate failed: ${JSON.stringify(err)}`;
  const tail = logs.length > 0
    ? "\n--- program logs (last 12) ---\n" + logs.slice(-12).join("\n")
    : "";
  return new Error(head + tail);
}

/// Pull program logs out of a SendTransactionError or simulate the tx
/// against the cluster to recover the failure reason. Wallet adapters
/// usually drop the logs by the time the error reaches React.
async function enrichTxError(conn: Connection, e: unknown): Promise<Error> {
  let logs: string[] | undefined;
  let baseMsg = e instanceof Error ? e.message : String(e);

  if (e instanceof SendTransactionError) {
    try {
      const got = await e.getLogs(conn);
      if (got && got.length > 0) logs = got;
    } catch {
      /* ignore */
    }
  }
  // Some wallets stash logs on a `logs` property of a custom error object.
  if (!logs && typeof e === "object" && e !== null && "logs" in e) {
    const maybe = (e as { logs?: unknown }).logs;
    if (Array.isArray(maybe)) logs = maybe as string[];
  }

  // Look for "custom program error: 0xNNNN" in either message or logs and
  // attach a friendlier label.
  const hayStack = [baseMsg, ...(logs ?? [])].join("\n");
  const codeMatch = hayStack.match(/custom program error: (0x[0-9a-fA-F]+)/);
  const friendly = codeMatch ? labelForCode(codeMatch[1].toLowerCase()) : null;

  const tail = logs ? "\n--- program logs (last 8) ---\n" + logs.slice(-8).join("\n") : "";
  const prefix = friendly ? `${friendly} (${codeMatch![1]}) — ` : "";
  return new Error(prefix + baseMsg + tail);
}

/// Hand-curated labels for the most-likely-to-bite axis-vault and
/// pfda-amm-3 error codes. Pulled from contracts/*/src/error.rs and
/// the e2e suite assertions. Unknown codes fall through to the raw
/// hex value, so missing entries degrade gracefully.
function labelForCode(hex: string): string | null {
  // Mirrors contracts/axis-vault/src/error.rs (9000-block) and
  // contracts/pfda-amm-3/src/error.rs (8000-block) verbatim. Decimal
  // shown after each entry so the table stays auditable.
  const t: Record<string, string> = {
    // axis-vault — VaultError = 9000 + variant_index
    "0x2328": "axis-vault: InvalidDiscriminator",       // 9000
    "0x2329": "axis-vault: AlreadyInitialized",         // 9001
    "0x232a": "axis-vault: InvalidBasketSize",          // 9002
    "0x232b": "axis-vault: WeightsMismatch (sum != 10_000)", // 9003
    "0x232c": "axis-vault: ZeroDeposit",                // 9004
    "0x232d": "axis-vault: InsufficientBalance",        // 9005
    "0x232e": "axis-vault: DivisionByZero",             // 9006
    "0x232f": "axis-vault: Overflow",                   // 9007
    "0x2330": "axis-vault: OwnerMismatch",              // 9008
    "0x2331": "axis-vault: MintMismatch",               // 9009
    "0x2332": "axis-vault: InvalidTickerLength",        // 9010
    "0x2333": "axis-vault: DuplicateMint",              // 9011
    "0x2334": "axis-vault: PoolPaused",                 // 9012
    "0x2335": "axis-vault: VaultMismatch",              // 9013
    "0x2336": "axis-vault: InvalidProgramOwner",        // 9014
    "0x2337": "axis-vault: SlippageExceeded",           // 9015
    "0x2338": "axis-vault: NavDeviationExceeded",       // 9016
    "0x2339": "axis-vault: TreasuryMismatch",           // 9017
    "0x233a": "axis-vault: InsufficientFirstDeposit (amount must be >= 10_000 base units)", // 9018
    "0x233b": "axis-vault: InvalidTicker (A-Z 0-9, 2..16 bytes)", // 9019
    "0x233c": "axis-vault: InvalidName (>32 bytes or empty)", // 9020
    "0x233d": "axis-vault: SweepForbidden",            // 9021
    "0x233e": "axis-vault: NothingToSweep",            // 9022
    "0x233f": "axis-vault: TreasuryNotApproved",       // 9023
    "0x2340": "axis-vault: NotYetImplemented",         // 9024
    "0x2341": "axis-vault: BasketTooLargeForOnchainSol", // 9025
    "0x2342": "axis-vault: InvalidJupiterProgram",     // 9026
    "0x2343": "axis-vault: WsolMintMismatch",          // 9027
    "0x2344": "axis-vault: LegSumMismatch",            // 9028
    "0x2345": "axis-vault: LegCountMismatch",          // 9029
    "0x2346": "axis-vault: JupiterCpiNoOutput",        // 9030
    "0x2347": "axis-vault: EtfNotBootstrapped",        // 9031
    "0x2348": "axis-vault: MalformedLegData",          // 9032
    "0x2349": "axis-vault: FeeTooHigh",                // 9033
    "0x234a": "axis-vault: TvlCapExceeded",            // 9034
    "0x234b": "axis-vault: InvalidCapDecrease",        // 9035
    "0x234c": "axis-vault: ExcessVaultDrain",          // 9036
    // pfda-amm-3 — PfdaError = 8000 + variant_index
    "0x1f40": "pfda-amm-3: InvalidDiscriminator",       // 8000
    "0x1f41": "pfda-amm-3: ReentrancyDetected",         // 8001
    "0x1f42": "pfda-amm-3: BatchWindowNotEnded",        // 8002
    "0x1f43": "pfda-amm-3: BatchAlreadyCleared",        // 8003
    "0x1f44": "pfda-amm-3: TicketAlreadyClaimed",       // 8004
    "0x1f45": "pfda-amm-3: BatchNotCleared",            // 8005
    "0x1f46": "pfda-amm-3: SlippageExceeded",           // 8006
    "0x1f47": "pfda-amm-3: InvalidSwapInput",           // 8007
    "0x1f48": "pfda-amm-3: Overflow",                   // 8008
    "0x1f4a": "pfda-amm-3: BatchIdMismatch",            // 8010
    "0x1f4b": "pfda-amm-3: PoolMismatch",               // 8011
    "0x1f4f": "pfda-amm-3: AlreadyInitialized",         // 8015
    "0x1f50": "pfda-amm-3: InvalidTokenIndex",          // 8016
    "0x1f54": "pfda-amm-3: OracleInvalid",              // 8020
    "0x1f56": "pfda-amm-3: OracleStale",                // 8022
    "0x1f58": "pfda-amm-3: BidTooLow",                  // 8024
    "0x1f59": "pfda-amm-3: VaultMismatch",              // 8025
    "0x1f5a": "pfda-amm-3: MintMismatch",               // 8026
    "0x1f5b": "pfda-amm-3: BidWithoutTreasury",         // 8027
    "0x1f5c": "pfda-amm-3: OracleOwnerMismatch",        // 8028
    "0x1f5d": "pfda-amm-3: ReserveInsufficient",        // 8029
    "0x1f5e": "pfda-amm-3: InvariantViolation",         // 8030
    "0x1f5f": "pfda-amm-3: BidExcessive",               // 8031
  };
  return t[hex] ?? null;
}

export function explorerTx(sig: string, cluster: "devnet" | "" | "mainnet" = "devnet"): string {
  const suffix = cluster && cluster !== "mainnet" ? `?cluster=${cluster}` : "";
  return `https://explorer.solana.com/tx/${sig}${suffix}`;
}

export function explorerAddr(addr: string, cluster: "devnet" | "" | "mainnet" = "devnet"): string {
  const suffix = cluster && cluster !== "mainnet" ? `?cluster=${cluster}` : "";
  return `https://explorer.solana.com/address/${addr}${suffix}`;
}
