// Chat persistence in ai.* (supabase/migrations/20261116100000_foundation.sql).
// Everything runs through withUser, so row level security decides: a user
// reads and writes only their own conversations, and a conversation id of
// someone else behaves as if it did not exist.
//
// Messages are stored in the AI SDK's UI message format (parts as jsonb),
// with uuid ids: the client generates uuids for user messages and the route
// for assistant messages.

import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { withUser, type Claims, type Db } from "@/lib/db";
import { dayKey } from "@/lib/time";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest title, cut from the first question. */
const TITLE_LENGTH = 80;

/** Conversations in the side list. */
const LIST_LIMIT = 50;

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: UIMessage[];
}

export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat || "Ny samtale";
}

export function messageText(message: UIMessage): string {
  return message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

export async function listConversations(claims: Claims): Promise<ConversationSummary[]> {
  const rows = await withUser(claims, (db) =>
    db.query<{ id: string; title: string | null; updated_at: Date | string }>(
      `select id, title, updated_at from ai.conversations
        where opti_user_id = $1 and archived_at is null
        order by updated_at desc
        limit $2`,
      [claims.optiUserId, LIST_LIMIT]
    )
  );
  return rows.map((r) => ({ id: r.id, title: r.title ?? "Ny samtale", updatedAt: new Date(r.updated_at).toISOString() }));
}

async function messagesOn(db: Db, conversationId: string): Promise<UIMessage[]> {
  const rows = await db.query<{ id: string; role: UIMessage["role"]; parts: UIMessage["parts"] }>(
    `select id, role, parts from ai.messages
      where conversation_id = $1 and role in ('user', 'assistant')
      order by created_at, id`,
    [conversationId]
  );
  return rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts }));
}

/** One of the user's conversations with its messages, or null (unknown, archived or someone else's). */
export async function loadConversation(claims: Claims, id: string): Promise<Conversation | null> {
  if (!UUID_RE.test(id)) return null;
  return withUser(claims, async (db) => {
    const [row] = await db.query<{ id: string; title: string | null }>(
      `select id, title from ai.conversations where id = $1 and archived_at is null`,
      [id]
    );
    if (!row) return null;
    return { id: row.id, title: row.title ?? "Ny samtale", messages: await messagesOn(db, row.id) };
  });
}

/** Hides a conversation from the list. The usage rows stay. */
export async function archiveConversation(claims: Claims, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const rows = await withUser(claims, (db) =>
    db.query(`update ai.conversations set archived_at = now() where id = $1 and archived_at is null returning id`, [id])
  );
  return rows.length > 0;
}

/**
 * Opens the conversation for a new user message: creates it when the id is
 * new, stores the message, and returns the history before it. Null when the
 * id belongs to someone else (the insert conflicts, the select sees nothing)
 * or the conversation is archived.
 */
export async function beginTurn(
  claims: Claims,
  conversationId: string,
  message: UIMessage
): Promise<{ history: UIMessage[] } | null> {
  return withUser(claims, async (db) => {
    await db.query(
      `insert into ai.conversations (id, opti_user_id, title) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [conversationId, claims.optiUserId, titleFrom(messageText(message))]
    );
    const [row] = await db.query<{ id: string }>(
      `select id from ai.conversations where id = $1 and archived_at is null`,
      [conversationId]
    );
    if (!row) return null;
    const history = (await messagesOn(db, conversationId)).filter((m) => m.id !== message.id);
    await db.query(
      `insert into ai.messages (id, conversation_id, role, parts) values ($1, $2, 'user', $3::jsonb)
       on conflict (id) do nothing`,
      [message.id, conversationId, JSON.stringify(message.parts)]
    );
    await db.query(`update ai.conversations set updated_at = now() where id = $1`, [conversationId]);
    return { history };
  });
}

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
}

/** Stores the answer, one ai.tool_calls row per tool part, and the usage row, in one transaction. */
export async function finishTurn(
  claims: Claims,
  conversationId: string,
  message: UIMessage,
  usage: TurnUsage | null,
  toolDurations: ReadonlyMap<string, number>
): Promise<void> {
  await withUser(claims, async (db) => {
    await db.query(
      `insert into ai.messages (id, conversation_id, role, parts) values ($1, $2, 'assistant', $3::jsonb)
       on conflict (id) do update set parts = excluded.parts`,
      [message.id, conversationId, JSON.stringify(message.parts)]
    );
    await db.query(`delete from ai.tool_calls where message_id = $1`, [message.id]);
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      await db.query(
        `insert into ai.tool_calls (message_id, conversation_id, name, input, output, error, duration_ms)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [
          message.id,
          conversationId,
          getToolName(part),
          JSON.stringify(part.input ?? null),
          part.state === "output-available" ? JSON.stringify(part.output ?? null) : null,
          part.state === "output-error" ? part.errorText : null,
          toolDurations.get(part.toolCallId) ?? null,
        ]
      );
    }
    if (usage) {
      await db.query(
        `insert into ai.usage_events
           (conversation_id, message_id, opti_user_id, model, input_tokens, output_tokens, cached_tokens, cost_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          conversationId,
          message.id,
          claims.optiUserId,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens,
          usage.costUsd,
        ]
      );
    }
    await db.query(`update ai.conversations set updated_at = now() where id = $1`, [conversationId]);
  });
}

/** Tokens this user has used today (Copenhagen day of `now`). */
export async function tokensUsedToday(claims: Claims, now: number): Promise<number> {
  const [row] = await withUser(claims, (db) =>
    db.query<{ tokens: number | string | null }>(
      `select coalesce(sum(input_tokens + output_tokens), 0) as tokens
         from ai.usage_events
        where opti_user_id = $1
          and created_at >= ($2::date)::timestamp at time zone 'Europe/Copenhagen'`,
      [claims.optiUserId, dayKey(now)]
    )
  );
  return Number(row?.tokens ?? 0);
}
