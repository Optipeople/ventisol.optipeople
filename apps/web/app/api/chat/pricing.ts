// What a chat answer cost, for ai.usage_events. The Anthropic API reports
// tokens, not money, so the list price below (USD per million tokens,
// Anthropic list prices 2026-10) gives an estimate, and an unknown model
// gives null rather than a made-up number.

interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** The price of a model id; the API may answer with a dated one (claude-sonnet-5-5-20261001). */
function priceOf(model: string): Price | undefined {
  if (PRICES[model]) return PRICES[model];
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : undefined;
}

/** List-price estimate in USD, or null for a model without a price here. */
export function estimateCostUsd(model: string, t: TokenCounts): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const uncached = Math.max(0, t.inputTokens - t.cachedTokens);
  const usd = (uncached * price.input + t.cachedTokens * price.cacheRead + t.outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
