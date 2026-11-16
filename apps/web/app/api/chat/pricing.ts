// What a chat answer cost, for ai.usage_events. The AI Gateway reports the
// cost of each model call in providerMetadata.gateway.cost; that figure is
// used when present. Otherwise the list price below (USD per million tokens,
// Anthropic list prices 2026-10) gives an estimate, and an unknown model
// gives null rather than a made-up number.

interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.2 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** List-price estimate in USD, or null for a model without a price here. */
export function estimateCostUsd(model: string, t: TokenCounts): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const uncached = Math.max(0, t.inputTokens - t.cachedTokens);
  const usd = (uncached * price.input + t.cachedTokens * price.cacheRead + t.outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** The Gateway's own cost of one call, when it reported one. */
export function gatewayCost(providerMetadata: unknown): number | null {
  const gateway = (providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway;
  const cost = Number(gateway?.cost);
  return gateway?.cost != null && Number.isFinite(cost) ? cost : null;
}
