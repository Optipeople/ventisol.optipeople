// The chat route (app/api/chat/handler.ts) with a mock model on PGlite: the
// status codes, that the tools offered follow the role, and that the
// conversation, the answer, its tool calls and the usage row are stored.
// Lives here because vitest only collects lib/**/*.test.ts.

import { randomUUID } from "node:crypto";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleChat, type ChatDeps } from "@/app/api/chat/handler";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";

const viewer = testClaims("viewer");
const admin = testClaims("admin");

const usage = {
  inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: undefined },
  outputTokens: { total: 100, text: 100, reasoning: undefined },
};

/** First call asks for order_status, the second answers in text. */
function mockModel(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              { type: "response-metadata", id: "r1", modelId: "anthropic/claude-sonnet-5.5", timestamp: new Date(NOW) },
              { type: "tool-call", toolCallId: "call-1", toolName: "order_status", input: '{"orderNo":50006}' },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ]
          : [
              { type: "response-metadata", id: "r2", modelId: "anthropic/claude-sonnet-5.5", timestamp: new Date(NOW) },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Ordre 50006 er i gang." },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function deps(claims: Claims | null, model: MockLanguageModelV4, overrides: Partial<ChatDeps> = {}): ChatDeps {
  return {
    access: async () => (claims ? { role: claims.role, claims, roleDegraded: false } : null),
    model: () => model as unknown as LanguageModel,
    modelId: () => "anthropic/claude-sonnet-5.5",
    configured: () => true,
    now: () => NOW,
    allow: async () => true,
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function question(text: string, conversationId = randomUUID()) {
  return { id: conversationId, message: { id: randomUUID(), role: "user", parts: [{ type: "text", text }] } };
}

/** Polls until the stored answer is there: the route stores it when the stream has ended. */
async function waitFor<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedOctober(db, IN_PROGRESS_ORDERS);
});
afterAll(() => db.close());

describe("refusals", () => {
  it("401 without a session", async () => {
    const res = await handleChat(post(question("Hej")), deps(null, mockModel()));
    expect(res.status).toBe(401);
  });

  it("503 when the AI Gateway is not configured", async () => {
    const res = await handleChat(post(question("Hej")), deps(viewer, mockModel(), { configured: () => false }));
    expect(res.status).toBe(503);
  });

  it("429 over the rate limit", async () => {
    const res = await handleChat(post(question("Hej")), deps(viewer, mockModel(), { allow: async () => false }));
    expect(res.status).toBe(429);
  });

  it("400 on a bad body, 415 without JSON", async () => {
    expect((await handleChat(post({ id: "nope" }), deps(viewer, mockModel()))).status).toBe(400);
    const form = new Request("http://localhost/api/chat", { method: "POST", body: "x" });
    expect((await handleChat(form, deps(viewer, mockModel()))).status).toBe(415);
  });

  it("404 for someone else's conversation", async () => {
    const conversationId = randomUUID();
    await db.withService((tx) =>
      tx.query(`insert into ai.conversations (id, opti_user_id, title) values ($1, 'someone-else', 'x')`, [conversationId])
    );
    const res = await handleChat(post(question("Hej", conversationId)), deps(viewer, mockModel()));
    expect(res.status).toBe(404);
  });

  it("429 when the daily token budget is used", async () => {
    await db.withService((tx) =>
      tx.query(
        `insert into ai.usage_events (opti_user_id, model, input_tokens, output_tokens, created_at)
         values ($1, 'm', 3000000, 0, to_timestamp($2 / 1000.0))`,
        [viewer.optiUserId, NOW]
      )
    );
    const res = await handleChat(post(question("Hej")), deps(viewer, mockModel()));
    expect(res.status).toBe(429);
  });
});

describe("a turn", () => {
  it("streams the answer and stores conversation, messages, tool call and usage", async () => {
    const model = mockModel();
    const body = question("Hvor er ordrenummer 50006?");
    const res = await handleChat(post(body), deps(viewer, model));
    expect(res.status).toBe(200);
    const streamed = await res.text();
    expect(streamed).toContain("Ordre 50006 er i gang.");
    expect(streamed).toContain("order_status");

    const stored = await waitFor(async () => {
      const rows = await db.withService((tx) =>
        tx.query<{ role: string }>(`select role from ai.messages where conversation_id = $1 order by created_at`, [body.id])
      );
      return rows.length === 2 ? rows : null;
    });
    expect(stored.map((r) => r.role)).toEqual(["user", "assistant"]);

    const [conversation] = await db.withService((tx) =>
      tx.query<{ opti_user_id: string; title: string }>(`select opti_user_id, title from ai.conversations where id = $1`, [body.id])
    );
    expect(conversation).toEqual({ opti_user_id: viewer.optiUserId, title: "Hvor er ordrenummer 50006?" });

    const tools = await waitFor(async () => {
      const rows = await db.withService((tx) =>
        tx.query<{ name: string; input: unknown; error: string | null }>(
          `select name, input, error from ai.tool_calls where conversation_id = $1`,
          [body.id]
        )
      );
      return rows.length > 0 ? rows : null;
    });
    expect(tools).toEqual([{ name: "order_status", input: { orderNo: 50006 }, error: null }]);

    const [usageRow] = await waitFor(async () => {
      const rows = await db.withService((tx) =>
        tx.query<{ model: string; input_tokens: number; output_tokens: number; cached_tokens: number; cost_usd: string }>(
          `select model, input_tokens, output_tokens, cached_tokens, cost_usd::text from ai.usage_events where conversation_id = $1`,
          [body.id]
        )
      );
      return rows.length > 0 ? rows : null;
    });
    expect(usageRow).toMatchObject({ model: "anthropic/claude-sonnet-5.5", input_tokens: 2000, output_tokens: 200, cached_tokens: 400 });
    // List price: 1600 uncached at $2, 400 cached at $0.20, 200 out at $10 per million.
    expect(Number(usageRow.cost_usd)).toBeCloseTo(0.00528, 6);
  });

  it("offers a viewer no calc_vs_measured tool and an admin all of them", async () => {
    const forViewer = mockModel();
    await (await handleChat(post(question("Holder kalkulen?")), deps(viewer, forViewer))).text();
    const viewerTools = (forViewer.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(viewerTools).not.toContain("calc_vs_measured");
    expect(viewerTools).toContain("order_status");

    const forAdmin = mockModel();
    await (await handleChat(post(question("Holder kalkulen?")), deps(admin, forAdmin))).text();
    expect((forAdmin.doStreamCalls[0].tools ?? []).map((t) => t.name)).toContain("calc_vs_measured");
  });

  it("sends the Danish system prompt and the stored history on the next question", async () => {
    const first = question("Hvor er ordrenummer 50006?");
    await (await handleChat(post(first), deps(viewer, mockModel()))).text();
    await waitFor(async () => {
      const rows = await db.withService((tx) => tx.query(`select 1 from ai.messages where conversation_id = $1`, [first.id]));
      return rows.length === 2 ? rows : null;
    });

    const model = mockModel();
    await (await handleChat(post(question("Og hvornår er den klar?", first.id)), deps(viewer, model))).text();
    const prompt = model.doStreamCalls[0].prompt;
    const system = prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).toContain("Alle tal skal komme fra værktøjerne");
    const userTurns = prompt.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(2);
    // The model saw the earlier tool result as compact data, without the views.
    const toolTurn = JSON.stringify(prompt.filter((m) => m.role === "tool"));
    expect(toolTurn).toContain("50006");
    expect(toolTurn).not.toContain('"views"');
  });
});
