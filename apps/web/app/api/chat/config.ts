// Chat configuration from the environment. Server only.
//
//   AI_GATEWAY_API_KEY   local runs and tests against the real model. On
//                        Vercel the Gateway authenticates with OIDC instead.
//   CHAT_MODEL           AI Gateway model id, default anthropic/claude-sonnet-5.5.
//   CHAT_DAILY_TOKEN_BUDGET  tokens one user may spend per Copenhagen day.

export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5.5";

/** Tried by the Gateway when the main model fails. */
export const FALLBACK_CHAT_MODELS = ["anthropic/claude-sonnet-5"];

export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;

export function chatModelId(): string {
  return process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

/**
 * Whether the AI Gateway can be reached with credentials: a key, or OIDC on
 * Vercel (VERCEL_OIDC_TOKEN locally after `vercel env pull`, or a Vercel
 * deployment, where the token comes with each request).
 */
export function aiConfigured(): boolean {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.VERCEL === "1"
  );
}

export function dailyTokenBudget(): number {
  const value = Number(process.env.CHAT_DAILY_TOKEN_BUDGET);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_TOKEN_BUDGET;
}
