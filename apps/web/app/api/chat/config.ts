// Chat configuration from the environment. Server only.
//
//   ANTHROPIC_API_KEY    the Anthropic API key. The chat and the Ledelse draft
//                        call the Anthropic API directly.
//   ANTHROPIC_WORKSPACE_ID  only for a key that is not scoped to a workspace.
//   CHAT_MODEL         Anthropic model id, default claude-sonnet-5-5.
//   CHAT_DAILY_TOKEN_BUDGET  tokens one user may spend per Copenhagen day.

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export const DEFAULT_CHAT_MODEL = "claude-sonnet-5-5";

export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;

export function chatModelId(): string {
  return process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

/** The chat model on the Anthropic API; the key is read from ANTHROPIC_API_KEY. */
export function chatModel(): LanguageModel {
  // A key that is not tied to one workspace must name the workspace per request.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  const provider = workspaceId ? createAnthropic({ headers: { "anthropic-workspace-id": workspaceId } }) : anthropic;
  return provider(chatModelId());
}

/** Whether the Anthropic API can be reached: a key is set. */
export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function dailyTokenBudget(): number {
  const value = Number(process.env.CHAT_DAILY_TOKEN_BUDGET);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_TOKEN_BUDGET;
}
