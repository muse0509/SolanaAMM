import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { findEtfState, ixCreateEtf, ixDeposit } from "../lib/ix";
import {
  buildBareMintAccountIxs,
  buildBareTokenAccountIxs,
} from "../lib/spl";
import { sendTx, sendVersionedTx, explorerTx } from "../lib/tx";
import type { ClusterConfig } from "../lib/programs";
import { buildDepositSolPlan } from "../lib/depositSolPlan";
import { truncatePubkey } from "../lib/format";
import { JupiterSeedPreviewCard } from "./JupiterSeedPreviewCard";

interface BasketRow {
  mint: string; // base58
  weight: number; // bps (0..10000)
}

/// Drives the full axis-vault CreateEtf → optional Deposit flow.
///
/// The on-chain create_etf wants a freshly-allocated ETF mint + N
/// vault token accounts owned by the program PDA. We allocate them
/// client-side and bundle CreateEtf into the same tx for the common
/// 3-token case. Mainnet seed deposits use Jupiter in a second v0 tx.
export function CreateEtfPanel({
  selectedMints,
  onClearSelection,
  config,
}: {
  selectedMints: string[];
  onClearSelection: () => void;
  config: ClusterConfig;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey } = wallet;

  const [name, setName] = useState(
    () => `AX${Date.now().toString(36).toUpperCase().slice(-6)}`,
  );
  const [ticker, setTicker] = useState(
    () => `AX${Date.now().toString(36).toUpperCase().slice(-3)}`,
  );
  // v1.1: Metaplex Token Metadata URI (off-chain JSON). Empty is allowed
  // and produces a metadata account with no URI set — wallets fall back
  // to the on-chain name/symbol.
  const [uri, setUri] = useState("");
  const [rows, setRows] = useState<BasketRow[]>([]);
  // Default 1_000_000_000 = 1000 tokens at 6 decimals, matches the e2e
  // test. The program rejects amount < MIN_FIRST_DEPOSIT (10_000)
  // with InsufficientFirstDeposit (0x233A / 9018) on the first deposit.
  const [depositBase, setDepositBase] = useState<number>(1_000_000_000);
  // 0.02 SOL comfortably clears the on-chain MIN_FIRST_DEPOSIT (0.01 ETF
  // base) for typical mainnet routes. Smaller seeds can still be
  // refused by `buildDepositSolPlan` with a recommended bump.
  const [solSeed, setSolSeed] = useState<number>(0.02);
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [doDepositAfter, setDoDepositAfter] = useState(true);
  const [stage, setStage] = useState<"idle" | "alloc" | "create" | "deposit" | "ok" | "err">(
    "idle",
  );
  const [log, setLog] = useState<string[]>([]);

  const selKey = selectedMints.join(",");
  const axisVault = config.programs.find((p) => p.name === "axis-vault")!.address;
  // Reset weights to even split whenever the basket selection changes.
  useEffect(() => {
    if (selectedMints.length === 0) {
      setRows([]);
      return;
    }
    const merged = selectedMints.map((m) => ({ mint: m, weight: 0 }));
    const base = Math.floor(10_000 / merged.length);
    const remainder = 10_000 - base * merged.length;
    setRows(
      merged.map((r, i) => ({
        ...r,
        weight: base + (i === merged.length - 1 ? remainder : 0),
      })),
    );
    // selKey collapses array identity into a stable string for the dep array.
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sumWeights = rows.reduce((s, r) => s + r.weight, 0);
  const weightsOk = rows.length >= 2 && rows.length <= 5 && sumWeights === 10_000;

  function pushLog(line: string) {
    setLog((l) => [...l, line]);
  }

  function setRowWeight(i: number, w: number) {
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, weight: w } : r)));
  }

  async function run() {
    if (!publicKey) return;
    if (!weightsOk) return;
    setStage("alloc");
    setLog([]);
    pushLog(`Building basket with ${rows.length} mints, weights=${rows.map((r) => r.weight).join("/")}`);

    try {
      const basketMints = rows.map((r) => new PublicKey(r.mint));
      const treasury = config.protocolTreasury ?? publicKey;
      const [etfState] = findEtfState(axisVault, publicKey, name);
      pushLog(`ETF state PDA: ${etfState.toBase58()}`);
      pushLog(`Treasury: ${treasury.toBase58()}`);

      // ── Tx 1: allocate bare ETF mint + N vault accounts + CreateEtf ──
      const etfMint = await buildBareMintAccountIxs(connection, publicKey);
      const vaults = await buildBareTokenAccountIxs(
        connection,
        publicKey,
        basketMints.length,
      );
      setStage("create");
      const createIx = ixCreateEtf({
        programId: axisVault,
        payer: publicKey,
        etfState,
        etfMint: etfMint.pubkey,
        treasury,
        basketMints,
        vaults: vaults.pubkeys,
        weightsBps: rows.map((r) => r.weight),
        ticker,
        name,
        uri,
      });
      pushLog(`Tx1: alloc ETF mint + ${basketMints.length} vaults + CreateEtf "${name}"`);
      const sig2 = await sendTx(
        connection,
        wallet,
        [...etfMint.ixs, ...vaults.ixs, createIx],
        [etfMint.signer, ...vaults.signers],
      );
      pushLog(`✓ create_etf: ${sig2.slice(0, 12)}…`);
      pushLog(`ETF mint: ${etfMint.pubkey.toBase58()}`);
      pushLog(`See: ${explorerTx(sig2, config.explorerCluster)}`);
      // Burn-after-create: a successful CreateEtf permanently claims the
      // PDA `[b"etf", payer, name]`. Re-running with the same name would
      // revert with AlreadyInitialized (0x2329), so rotate to fresh
      // name+ticker so the user can hit Run again without manual edits.
      const fresh = Date.now().toString(36).toUpperCase();
      setName(`AX${fresh.slice(-6)}`);
      setTicker(`AX${fresh.slice(-3)}`);

      // ── Optional Tx 2: seed deposit ──
      if (doDepositAfter && (config.jupiterEnabled ? solSeed > 0 : depositBase > 0)) {
        setStage("deposit");
        // ATAs for the user (ETF receiver) and treasury (fee receiver)
        const userEtfAta = getAssociatedTokenAddressSync(etfMint.pubkey, publicKey);
        const treasuryEtfAta = getAssociatedTokenAddressSync(
          etfMint.pubkey,
          treasury,
          true,
        );
        if (config.jupiterEnabled) {
          const plan = await buildDepositSolPlan({
            conn: connection,
            user: publicKey,
            programId: axisVault,
            etfName: name,
            etfState,
            etfMint: etfMint.pubkey,
            treasury,
            treasuryEtfAta,
            basketMints,
            weights: rows.map((r) => r.weight),
            vaults: vaults.pubkeys,
            solIn: BigInt(Math.floor(solSeed * 1_000_000_000)),
            minEtfOut: 0n,
            slippageBps,
          });
          pushLog(
            `Tx2: Jupiter SOL-in seed (${solSeed} SOL) + Deposit; mode=${plan.mode}; ix=${plan.ixCount}; tx=${plan.txBytes}b`,
          );
          const bottleneck = plan.seedPreview.legs[plan.seedPreview.bottleneckIndex];
          pushLog(
            `Jupiter floor: ${plan.depositAmount.toString()} base; bottleneck=${truncatePubkey(
              bottleneck.mint.toBase58(),
              6,
              6,
            )}`,
          );
          pushLog(
            `Expected out: ${plan.seedPreview.legs
              .map((leg) => `${truncatePubkey(leg.mint.toBase58(), 4, 4)}=${leg.expectedOut}`)
              .join(" / ")}`,
          );
          if (plan.mode === "single") {
            const sig3 = await sendVersionedTx(connection, wallet, plan.versionedTx);
            pushLog(`✓ jupiter_seed_deposit: ${sig3.slice(0, 12)}…`);
            pushLog(`See: ${explorerTx(sig3, config.explorerCluster)}`);
          } else {
            // Split mode: tx0 = swaps, tx1 = axis Deposit. Sign and
            // send sequentially so the second sees the basket tokens
            // landed by the first. If the user aborts between, basket
            // tokens stay in their basket ATAs; they can re-run.
            pushLog("split: signing tx0 (swaps) then tx1 (deposit)…");
            const sig3a = await sendVersionedTx(connection, wallet, plan.versionedTx);
            pushLog(`✓ swaps: ${sig3a.slice(0, 12)}…`);
            pushLog(`See: ${explorerTx(sig3a, config.explorerCluster)}`);
            if (!plan.depositTx) {
              throw new Error("split plan missing depositTx — internal bug");
            }
            const sig3b = await sendVersionedTx(connection, wallet, plan.depositTx);
            pushLog(`✓ deposit: ${sig3b.slice(0, 12)}…`);
            pushLog(`See: ${explorerTx(sig3b, config.explorerCluster)}`);
          }
        } else {
          const userBasketAtas = basketMints.map((m) =>
            getAssociatedTokenAddressSync(m, publicKey),
          );
          const ataIxs = [
            createAssociatedTokenAccountIdempotentInstruction(
              publicKey,
              userEtfAta,
              publicKey,
              etfMint.pubkey,
            ),
            createAssociatedTokenAccountIdempotentInstruction(
              publicKey,
              treasuryEtfAta,
              treasury,
              etfMint.pubkey,
            ),
          ];

          const depositIx = ixDeposit({
            programId: axisVault,
            payer: publicKey,
            etfState,
            etfMint: etfMint.pubkey,
            userEtfAta,
            treasuryEtfAta,
            userBasketAccounts: userBasketAtas,
            vaults: vaults.pubkeys,
            amount: BigInt(depositBase),
            minMintOut: 0n,
            name,
          });
          pushLog(`Tx2: create ETF ATAs + Deposit(${depositBase} base)`);
          const sig3 = await sendTx(connection, wallet, [...ataIxs, depositIx]);
          pushLog(`✓ deposit: ${sig3.slice(0, 12)}…`);
          pushLog(`See: ${explorerTx(sig3, config.explorerCluster)}`);
        }
      }

      setStage("ok");
      pushLog("DONE — clearing selection");
      onClearSelection();
    } catch (e) {
      setStage("err");
      pushLog(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const enabled =
    !!publicKey &&
    weightsOk &&
    name.length >= 1 &&
    ticker.length >= 2 &&
    ticker.length <= 16 &&
    /^[A-Z0-9]+$/.test(ticker) &&
    stage !== "alloc" &&
    stage !== "create" &&
    stage !== "deposit";

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Create ETF (axis-vault)</h2>
        <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
          {truncatePubkey(axisVault.toBase58(), 6, 6)}
        </span>
      </header>

      {!publicKey ? (
        <p className="text-sm text-slate-400">Connect a wallet first.</p>
      ) : rows.length < 2 ? (
        <p className="text-sm text-slate-400">
          Pick 2–5 tokens from the Tokens panel to build a basket.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <label className="flex flex-col">
              <span className="mb-1 text-slate-400">Name (≤32 bytes)</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
              />
            </label>
            <label className="flex flex-col">
              <span className="mb-1 text-slate-400">
                Ticker (A-Z 0-9, 2..10)
              </span>
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                className="rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
              />
            </label>
          </div>

          <label className="flex flex-col text-xs">
            <span className="mb-1 text-slate-400">
              Metadata URI (≤200 bytes, optional — off-chain JSON for wallets)
            </span>
            <input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="https://example.com/etf-metadata.json"
              className="rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
            />
          </label>

          <div>
            <p className="mb-2 text-xs text-slate-400">
              Weights (bps, must sum to 10000) — current sum:{" "}
              <span
                className={
                  sumWeights === 10000 ? "text-emerald-400" : "text-rose-400"
                }
              >
                {sumWeights}
              </span>
            </p>
            <ul className="space-y-1 text-xs">
              {rows.map((r, i) => (
                <li key={r.mint} className="flex items-center gap-2">
                  <span className="flex-1 font-mono text-slate-300">
                    {truncatePubkey(r.mint, 6, 6)}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={r.weight}
                    onChange={(e) => setRowWeight(i, Number(e.target.value))}
                    className="w-24 rounded bg-slate-800 px-2 py-1 text-right font-mono text-slate-100"
                  />
                  <span className="w-10 text-right text-slate-500">
                    {(r.weight / 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={doDepositAfter}
                  onChange={(e) => setDoDepositAfter(e.target.checked)}
                />
                <span className="text-slate-300">also Deposit after create</span>
              </label>
              {doDepositAfter && config.jupiterEnabled ? (
                <>
                  <label className="flex items-center gap-1">
                    <span className="text-slate-400">SOL seed via Jupiter:</span>
                    <input
                      type="number"
                      min={0.001}
                      step={0.001}
                      value={solSeed}
                      onChange={(e) => setSolSeed(Number(e.target.value))}
                      className="w-28 rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-slate-400">Jup slippage bps:</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={slippageBps}
                      onChange={(e) => setSlippageBps(Number(e.target.value))}
                      className="w-20 rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
                    />
                  </label>
                  <span className="text-[11px] text-slate-500">
                    First deposit must yield ≥ 0.01 ETF (10_000 base units);
                    plan-builder rejects smaller seeds before sending.
                  </span>
                </>
              ) : doDepositAfter && (
                <label className="flex items-center gap-1">
                  <span className="text-slate-400">
                    base amount (≥ 10_000; per-leg = amount × weight ÷ 10000):
                  </span>
                  <input
                    type="number"
                    min={10_000}
                    step={10_000}
                    value={depositBase}
                    onChange={(e) => setDepositBase(Number(e.target.value))}
                    className="w-40 rounded bg-slate-800 px-2 py-1 font-mono text-slate-100"
                  />
                </label>
              )}
              {doDepositAfter && !config.jupiterEnabled && depositBase < 10_000 && (
                <span className="text-xs text-rose-400">
                  ✗ amount &lt; MIN_FIRST_DEPOSIT (10_000) — first Deposit will revert with InsufficientFirstDeposit
                </span>
              )}
            </div>

            {doDepositAfter && config.jupiterEnabled && (
              <JupiterSeedPreviewCard
                basket={rows}
                weightsOk={weightsOk}
                solSeed={solSeed}
                slippageBps={slippageBps}
              />
            )}
          </div>

          <button
            onClick={run}
            disabled={!enabled}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stage === "alloc"
              ? "alloc tx…"
              : stage === "create"
                ? "create_etf tx…"
                : stage === "deposit"
                  ? "deposit tx…"
                  : "Run flow"}
          </button>

          {log.length > 0 && (
            <pre className="max-h-64 overflow-auto rounded bg-slate-950/80 p-3 text-[11px] text-slate-300">
              {log.join("\n")}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
