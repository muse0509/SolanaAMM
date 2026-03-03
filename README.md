# A Periodic Batch Auction Architecture for LVR Mitigation on Solana

<div align="center">
  <p><strong>A discrete-time O(1) asynchronous state-transition model protecting Liquidity Providers from Loss-Versus-Rebalancing (LVR) via periodic frequent batch auctions.</strong></p>
</div>

## ⚠️ Disclaimer
**THIS IS RESEARCH SOFTWARE.** This repository contains an un-audited prototype and academic simulation models for mitigating LVR on Solana. Do not use this in production with real funds. The authors are not responsible for any financial losses.

## 📖 Overview

Decentralized Exchange (DEX) Liquidity Providers (LPs) suffer structural losses known as Loss-Versus-Rebalancing (LVR) due to latency-based arbitrage. In Solana's ultra-fast 400ms blocktime environment with no public mempool, continuous AMMs force searchers into extreme latency competitions, draining value from LPs into network spam and validator tip leakage.

This project introduces a **Periodic Batch Auction Architecture** that bridges theoretical fee-discount frameworks and empirical dynamic-weight AMM observations. By decoupling order accumulation from execution, we achieve a strict **O(1) constant-time clearing mechanism** perfectly suited for Solana's compute and account-model constraints.

### Key Innovations
1. **Dutch-Style Repricing:** The pool smoothly interpolates target weights over time, creating a time-varying Dutch-style price path that induces predictable arbitrage opportunities.
2. **O(1) Asynchronous State Model:** User swaps are accumulated over a specific window and cleared simultaneously against a single invariant. 
3. **LVR Internalization:** Searchers compete on price rather than latency. Extracted value is redirected from validators to protocol revenue, neutralizing LP-side redistribution losses.

---

## 🔬 1. Economic Simulation: Neutralizing LVR

We evaluated the proposed architecture against a continuous Vanilla AMM utilizing identical dynamic weight trajectories (TVL = $100,000, volatility = 0.8, fee = 5 bps).

By concentrating the arbitrage opportunity into discrete batch boundaries (e.g., clearing every 10 slots), the protocol forces searchers to bid aggressively via Jito bundles. Even under a conservative auction assumption (alpha = 0.50), the architecture effectively neutralizes the net redistribution loss.

**P&L Breakdown: Vanilla vs Proposed Model (Identical Trajectory)**

| Metric (USD) | Vanilla (Continuous) | Proposed (alpha = 0.50) | Proposed (alpha = 0.75) |
| :--- | :--- | :--- | :--- |
| **Gross Opportunity** | $3.25 | $47.22 | $47.22 |
| **Searcher Net + Val Tips** | $1.38 | $23.61 | $11.80 |
| **LP/Protocol-Side Retained Value** | $1.87 | $23.61 | **$35.42** |
| **Net Redistribution Outcome\*** | **-$0.49** | **$0.00** | **+$11.80** |

*\* Positive value indicates net value retained by the LP/protocol side relative to external extractors in this accounting decomposition.*

---

## 🛠 2. Engineering Proof: O(1) Scalability on Solana

A common criticism of Batch Auctions on the Solana Virtual Machine (SVM) is the heavy computational cost (Compute Units) of iterating over N user orders, risking chain halts during high volatility. We solved this via a 3-phase asynchronous operation:

1. **Deposit [O(1)]:** The protocol increments a scalar state representing total inputs.
2. **ClearBatch [O(1)]:** The winning searcher executes the trade against the aggregated state using the G3M invariant.
3. **Claim [O(1)]:** Users asynchronously withdraw their proportional share.

**On-chain System Benchmarks (Solana CU)**

Measured over N in {1, 10, 100, 1000} accumulated intents via local Solana test validator (v1.18.x).

| Instruction | Median CU | p95 CU | Complexity |
| :--- | :--- | :--- | :--- |
| **Deposit** | 3,450 | 3,600 | O(1) |
| **ClearBatch** | 38,120 | 38,500 | O(1) |
| **Claim** | 14,800 | 15,100 | O(1) |

The `ClearBatch` instruction consumes a completely flat ~38,000 CUs regardless of how many orders are in the batch. This utilizes less than 3% of Solana's 1.4M CU transaction limit, leaving massive headroom for searchers to execute complex cross-DEX arbitrage routes.

---

## 🚀 Repository Structure & Usage

* `pfda-amm/`: The core Solana smart contract (Rust/Anchor) and TypeScript E2E benchmark clients.
* `solana-tfmm-rs/`: The Python/Rust simulation engine for empirical LVR calculations and economic modeling.

**To run the on-chain benchmarks locally:**
```bash
cd pfda-amm
cargo build-sbf
solana-test-validator --bpf-program <PROGRAM_ID> target/deploy/pfda_amm.so

# In another terminal:
cd client
npm install
npm run bench
```

## 📚 References
Willetts, M. & Harrington, C. (2026). "Pools as Portfolios: Observed arbitrage efficiency & LVR analysis of dynamic weight AMMs." arXiv:2602.22069

Milionis, J., Moallemi, C., Roughgarden, T., & Zhang, A. L. (2024). "Automated Market Making and Loss-Versus-Rebalancing." arXiv:2208.06046
