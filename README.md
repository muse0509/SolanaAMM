# Pools as Portfolios on Solana: PFDA-TFMM

<div align="center">
  <p><strong>A Next-Generation Dynamic Weight AMM protecting Liquidity Providers from LVR via Periodic Frequent Batch Auctions, highly optimized for Solana's compute and account-model constraints.</strong></p>
</div>

## ⚠️ Disclaimer
**THIS IS RESEARCH SOFTWARE.** This repository contains an un-audited prototype and academic simulation models for mitigating LVR (Loss-Versus-Rebalancing) on Solana. Do not use this in production with real funds. The authors are not responsible for any financial losses.

## 📖 Overview

Decentralized Exchange (DEX) Liquidity Providers (LPs) suffer structural losses known as Loss-Versus-Rebalancing (LVR) due to latency-based arbitrage. In Solana's ultra-fast 400ms blocktime environment, continuous AMMs force searchers into extreme latency competitions, draining value from LPs into latency-arbitrage rents and priority-fee competition.

This project introduces **PFDA-TFMM**, integrating **Temporal Function Market Making (TFMM)** with **Periodic Frequent Batch Auctions (PFDA)** using a novel claim-based architecture built on the ultra-lightweight Pinocchio framework.

### Key Innovations
1. **Dutch-Style Repricing:** The pool smoothly interpolates target weights over time, creating a time-varying Dutch-style price path that induces predictable micro-arbitrage opportunities.
2. **O(1) Batch Clearing:** User swaps are accumulated over a specific window and cleared simultaneously. The uniform clearing price is computed via a procedure consistent with the G3M invariant, achieving **O(1) constant-time clearing** with respect to the number of submitted orders in a batch (after pre-aggregation).
3. **LVR Internalization:** Searchers compete on price rather than latency. Under the tested regimes in our simulations, **~90% of modeled LVR leakage is recaptured** back to the protocol as LP yield.

---

## 🔬 1. Simulation Results: 90% LVR Reduction

We backtested this mechanism using real historical millisecond-level data from Coinbase and Helius RPC. Across the three vastly different volatility regimes tested in our current setup, PFDA consistently reduced modeled LVR by ~90%.

<img src="./solana-tfmm-rs/figures/paper/fig2_lvr_comparison.png" width="800" alt="LVR Comparison" />

| Pool Type (Regime) | Vanilla LVR (USD) | PFDA LVR (USD) | **LVR Reduction (%)** | Recaptured Value* |
| :--- | :--- | :--- | :--- | :--- |
| **SOL/USDT** (Standard, $\sigma=0.80$) | $147.08 | **$14.71** | **▼ 90.0 %** | + $132.46 |
| **SOL/pippin** (Extreme, $\sigma=3.50$) | $167.04 | **$17.04** | **▼ 89.8 %** | + $153.44 |
| **SOL/jitoSOL** (Low, $\sigma=0.10$) | $143.91 | **$14.40** | **▼ 90.0 %** | + $129.61 |

*\* Recaptured Value = Vanilla LVR - PFDA LVR (under the same simulated flow and cost assumptions).*

*Simulation code available in `solana-tfmm-rs/`.*

---

## 🛠 2. Engineering Proof: O(1) Scalability on Solana

A common criticism of Batch Auctions on Solana is the heavy computational cost (Compute Units) of calculating uniform clearing prices for multiple orders. We solved this via a post-claim design and custom Q32.32 fixed-point math.

### O(1) Scalability Benchmark
By pre-aggregating swap amounts in a `BatchQueue` PDA, our `ClearBatch` instruction achieves constant-time execution relative to the batch order count ($N$).

<img src="./pfda-amm/client/results/o1_benchmark.svg" width="600" alt="O(1) Benchmark" />

| Orders ($N$) | ClearBatch CU | $\Delta$ vs $N=1$ |
| :--- | :--- | :--- |
| 1 | 24,902 | + 0 |
| 3 | 27,891 | + 2,989 |
| 5 | 26,402 | + 1,500 |
| 10 | 26,411 | + 1,509 |

Even with 10+ orders, clearing costs **~26k CU** for the `ClearBatch` instruction itself (< 2% of Solana's 1.4M CU limit, excluding downstream arbitrage route execution costs), leaving massive headroom for searchers to execute complex cross-DEX arbitrage routes.

### TFMM Price Discovery (Dynamic Weights)
As the pool's weight transitions, the clearing price monotonically increases, proving the on-chain Dutch-auction effect. Even with the heavy 64-step binary search logic required for asymmetric weights, CU consumption remains highly optimized.

<img src="./pfda-amm/client/results/tfmm_demo.svg" width="600" alt="TFMM Price Discovery" />

| Batch | weight_a | Clearing Price (B/A) | CU |
| :--- | :--- | :--- | :--- |
| 0 | 50.00% | 1.078 | 279,880 |
| 1 | 52.15% | 1.243 | 272,828 |
| 2 | 56.27% | 1.488 | 261,821 |
| 3 | 61.13% | 1.737 | 267,834 |

*Smart contract and TS benchmark code available in `pfda-amm/`.*

---

## 🚀 Repository Structure & Usage

* `pfda-amm/`: The core Solana smart contract (Rust/Pinocchio) and TypeScript E2E benchmark clients.
* `solana-tfmm-rs/`: The Python/Rust simulation engine for empirical LVR calculations using Helius RPC data.

**To run the on-chain benchmarks locally:**
```bash
cd pfda-amm
cargo build-sbf
solana-test-validator --bpf-program 5BKDTDQdX7vFdDooVXZeKicu7S3yX2JY5e3rmASib5pY target/deploy/pfda_amm.so

# In another terminal:
cd client
npm install
npm run bench
```
## 📚 References
Willetts, M. & Harrington, C. (2026). "Pools as Portfolios: Observed arbitrage efficiency & LVR analysis of dynamic weight AMMs." arXiv:2602.22069

Built by Muse @ Axis.
