import { describe, expect, test } from "bun:test";

import {
  getClusterConfig,
} from "../../frontend/src/lib/programs";
import {
  buildJupiterSeedPreview,
  createMockJupiterQuoteClient,
  type JupiterQuoteClient,
} from "../../frontend/src/lib/jupiterSeed";

const CANONICAL_PROTOCOL_TREASURY =
  "BtjuCMkLC9MuzagvGSS9E26XjMNTBR6isj8e1xVyeak6";

describe("frontend cluster config", () => {
  test("devnet uses the canonical protocol treasury for gated axis-vault creates", () => {
    expect(getClusterConfig("devnet").protocolTreasury?.toBase58()).toBe(
      CANONICAL_PROTOCOL_TREASURY,
    );
  });

  test("mainnet uses the same canonical protocol treasury", () => {
    expect(getClusterConfig("mainnet").protocolTreasury?.toBase58()).toBe(
      CANONICAL_PROTOCOL_TREASURY,
    );
  });
});

describe("frontend Jupiter seed preview", () => {
  test("mock quotes produce a weighted Jupiter-to-axis-vault deposit floor", async () => {
    const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const mintB = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY8wYb6Fq4jmWZtj";
    const quotes: Record<string, { out: bigint; threshold: bigint }> = {
      [mintA]: { out: 51_000n, threshold: 50_000n },
      [mintB]: { out: 25_500n, threshold: 24_000n },
    };
    const quoteClient: JupiterQuoteClient = {
      mode: "mock",
      async getQuote(params) {
        const mint = params.outputMint.toBase58();
        const q = quotes[mint];
        return {
          inputMint: params.inputMint.toBase58(),
          outputMint: mint,
          inAmount: params.amount.toString(),
          outAmount: q.out.toString(),
          otherAmountThreshold: q.threshold.toString(),
          swapMode: params.swapMode ?? "ExactIn",
          slippageBps: params.slippageBps,
          priceImpactPct: "0.001",
          routePlan: [{ swapInfo: { label: "MockJup" } }],
          contextSlot: 123,
        };
      },
    };

    const preview = await buildJupiterSeedPreview({
      basketMints: [mintA, mintB],
      weights: [6_000, 4_000],
      solIn: 101n,
      slippageBps: 75,
      quoteClient,
    });

    expect(preview.legs.map((leg) => leg.solLamports)).toEqual([60n, 41n]);
    expect(preview.legs.map((leg) => leg.minOut)).toEqual([50_000n, 24_000n]);
    expect(preview.depositAmount).toBe(60_000n);
    expect(preview.bottleneckIndex).toBe(1);
    expect(preview.mode).toBe("mock");
  });

  test("reallocates SOL toward the deposit-floor bottleneck when quotes improve", async () => {
    const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const mintB = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY8wYb6Fq4jmWZtj";
    const quoteClient = createMockJupiterQuoteClient({
      outputBpsByMint: {
        [mintA]: 20_000,
        [mintB]: 10_000,
      },
    });

    const preview = await buildJupiterSeedPreview({
      basketMints: [mintA, mintB],
      weights: [6_000, 4_000],
      solIn: 1_000n,
      slippageBps: 0,
      quoteClient,
    });

    expect(preview.allocationMode).toBe("equalized");
    expect(preview.legs.map((leg) => leg.solLamports)).toEqual([428n, 572n]);
    expect(preview.depositAmount).toBeGreaterThan(1_000n);
  });
});
