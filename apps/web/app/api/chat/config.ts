// Chat configuration from the environment. Server only.
//
//   ANTHROPIC_API_KEY    the Anthropic API key. The chat and the Ledelse draft
//                        call the Anthropic API directly.
//   CHAT_MODEL           Anthropic model id, default claude-sonnet-5-5.
//   CHAT_DAILY_TOKEN_BUDGET  tokens one user may spend per Copenhagen day.

import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export const DEFAULT_CHAT_MODEL = "claude-sonnet-5-5";

export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;

export function chatModelId(): string {
  return process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

/** The chat model on the Anthropic API; the key is read from ANTHROPIC_API_KEY. */
export function chatModel(): LanguageModel {
  return anthropic(chatModelId());
}

/** Whether the Anthropic API can be reached: a key is set. */
export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function dailyTokenBudget(): number {
  const value = Number(process.env.CHAT_DAILY_TOKEN_BUDGET);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_TOKEN_BUDGET;
}
