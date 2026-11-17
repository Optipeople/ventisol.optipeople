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
import { HIDDEN_TOOL_NOTE, hideToolsNotAllowed, loadConversation } from "@/app/api/chat/store";
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
              { type: "response-metadata", id: "r1", modelId: "claude-sonnet-5-5", timestamp: new Date(NOW) },
              { type: "tool-call", toolCallId: "call-1", toolName: "order_status", input: '{"orderNo":50006}' },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ]
          : [
              { type: "response-metadata", id: "r2", modelId: "claude-sonnet-5-5", timestamp: new Date(NOW) },
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
    modelId: () => "claude-sonnet-5-5",
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

  it("503 when the Anthropic API is not configured", async () => {
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
    expect(usageRow).toMatchObject({ model: "claude-sonnet-5-5", input_tokens: 2000, output_tokens: 200, cached_tokens: 400 });
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

  it("hides stored tool results the current role may not run, in the page and for the model", async () => {
    // An answer from when the user could see calculated times.
    const conversationId = randomUUID();
    const secret = "kalkuleret-hemmelig-7f3a";
    await db.withService(async (tx) => {
      await tx.query(`insert into ai.conversations (id, opti_user_id, title) values ($1, $2, 'x')`, [
        conversationId,
        viewer.optiUserId,
      ]);
      await tx.query(
        `insert into ai.messages (id, conversation_id, role, parts, created_at) values
           ($1, $3, 'user', $4::jsonb, now() - interval '2 minutes'),
           ($2, $3, 'assistant', $5::jsonb, now() - interval '1 minute')`,
        [
          randomUUID(),
          randomUUID(),
          conversationId,
          JSON.stringify([{ type: "text", text: "Holder kalkulen?" }]),
          JSON.stringify([
            {
              type: "tool-calc_vs_measured",
              toolCallId: "old-1",
              state: "output-available",
              input: {},
              output: { data: { note: secret }, views: [] },
            },
            {
              type: "tool-order_status",
              toolCallId: "old-2",
              state: "output-available",
              input: { orderNo: 50006 },
              output: { data: { orderNo: 50006 }, views: [] },
            },
            { type: "text", text: "Ja." },
          ]),
        ]
      );
    });

    const shown = await loadConversation(viewer, conversationId);
    const parts = shown?.messages[1].parts ?? [];
    expect(JSON.stringify(parts)).not.toContain(secret);
    expect(parts[0]).toEqual({ type: "text", text: HIDDEN_TOOL_NOTE });
    expect(parts[1]).toMatchObject({ type: "tool-order_status", state: "output-available" });
    expect(parts[2]).toEqual({ type: "text", text: "Ja." });

    // An admin, who may still run the tool, sees it.
    const forAdmin = await db.withService((tx) =>
      tx.query(`update ai.conversations set opti_user_id = $2 where id = $1 returning id`, [conversationId, admin.optiUserId])
    );
    expect(forAdmin).toHaveLength(1);
    expect(JSON.stringify(await loadConversation(admin, conversationId))).toContain(secret);
    await db.withService((tx) =>
      tx.query(`update ai.conversations set opti_user_id = $2 where id = $1`, [conversationId, viewer.optiUserId])
    );
    const allowed = new Set(["calc_vs_measured"]);
    const kept = hideToolsNotAllowed(
      [{ id: "m", role: "assistant", parts: [{ type: "tool-calc_vs_measured", toolCallId: "c", state: "output-available", input: {}, output: secret }] }],
      allowed
    );
    expect(JSON.stringify(kept)).toContain(secret);

    // The next question keeps the history (it validates) without the hidden output.
    const model = mockModel();
    await (await handleChat(post(question("Og nu?", conversationId)), deps(viewer, model))).text();
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain(HIDDEN_TOOL_NOTE);
    expect(prompt).toContain("Holder kalkulen?");
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
    // Two system messages: the fixed part with a cache point, then the dates and the role.
    const system = prompt.filter((m) => m.role === "system");
    expect(system).toHaveLength(2);
    expect(system[0].content).toContain("Alle tal skal komme fra værktøjerne");
    expect(system[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    expect(system[0].content).not.toContain("## Nu");
    expect(system[1].content).toContain("## Nu");
    expect(system[1].providerOptions?.anthropic?.cacheControl).toBeUndefined();
    const userTurns = prompt.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(2);
    // The model saw the earlier tool result as compact data, without the views.
    const toolTurn = JSON.stringify(prompt.filter((m) => m.role === "tool"));
    expect(toolTurn).toContain("50006");
    expect(toolTurn).not.toContain('"views"');
  });
});

describe("the page a question is asked from", () => {
  it("is stored with the question and read by the model as a note, now and on the next question", async () => {
    const first = { ...question("Hvorfor venter den her ordre?"), page: { path: "/ordre/50006?fane=tid", title: 'Ordre "50006"]' } };
    const model = mockModel();
    await (await handleChat(post(first), deps(viewer, model))).text();
    const note = '[Spurgt fra siden "Ordre  50006" (/ordre/50006?fane=tid)]';
    expect(JSON.stringify(model.doStreamCalls[0].prompt.filter((m) => m.role === "user"))).toContain(
      JSON.stringify(note).slice(1, -1)
    );

    const stored = await waitFor(async () => {
      const conversation = await loadConversation(viewer, first.id);
      return conversation?.messages.length === 2 ? conversation : null;
    });
    expect(stored.messages[0].parts).toContainEqual({
      type: "data-page",
      data: { path: "/ordre/50006?fane=tid", title: "Ordre  50006" },
    });

    const next = mockModel();
    await (await handleChat(post(question("Og hvornår er den klar?", first.id)), deps(viewer, next))).text();
    const users = next.doStreamCalls[0].prompt.filter((m) => m.role === "user");
    expect(JSON.stringify(users[0])).toContain("/ordre/50006?fane=tid");
    expect(JSON.stringify(users[1])).not.toContain("Spurgt fra siden");
  });

  it("refuses a page that is not a path of the portal", async () => {
    const body = { ...question("Hej"), page: { path: "https://example.com/", title: "" } };
    expect((await handleChat(post(body), deps(viewer, mockModel()))).status).toBe(400);
  });
});

describe("a new answer to the last question", () => {
  it("replaces the stored answer and keeps the question with its page", async () => {
    const first = { ...question("Hvor er den her ordre?"), page: { path: "/ordre/50006", title: "Ordre 50006" } };
    await (await handleChat(post(first), deps(viewer, mockModel()))).text();
    const before = await waitFor(async () => {
      const conversation = await loadConversation(viewer, first.id);
      return conversation?.messages.length === 2 ? conversation : null;
    });
    // The time beside a stored message.
    expect((before.messages[0].metadata as { createdAt?: number }).createdAt).toBeTypeOf("number");

    const model = mockModel();
    const again = { id: first.id, message: first.message, regenerate: true };
    await (await handleChat(post(again), deps(viewer, model))).text();
    const prompt = model.doStreamCalls[0].prompt;
    expect(prompt.filter((m) => m.role === "assistant")).toHaveLength(0);
    const users = prompt.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users[0])).toContain("/ordre/50006");

    const after = await waitFor(async () => {
      const conversation = await loadConversation(viewer, first.id);
      const answer = conversation?.messages[1];
      return conversation?.messages.length === 2 && answer && answer.id !== before.messages[1].id ? conversation : null;
    });
    expect(after.messages[0].id).toBe(before.messages[0].id);
    const calls = await db.withService((tx) =>
      tx.query(`select 1 from ai.tool_calls where conversation_id = $1`, [first.id])
    );
    expect(calls).toHaveLength(1);
  });
});

describe("usage when the stream fails", () => {
  async function usageRows(conversationId: string) {
    return waitFor(async () => {
      const rows = await db.withService((tx) =>
        tx.query<{ message_id: string | null; input_tokens: number; output_tokens: number; cached_tokens: number }>(
          `select message_id, input_tokens, output_tokens, cached_tokens from ai.usage_events where conversation_id = $1`,
          [conversationId]
        )
      );
      return rows.length > 0 ? rows : null;
    });
  }

  it("counts the finished steps when a later model call fails", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call > 1) throw new Error("provider down");
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "response-metadata", id: "r1", modelId: "claude-sonnet-5-5", timestamp: new Date(NOW) },
          { type: "tool-call", toolCallId: "call-1", toolName: "order_status", input: '{"orderNo":50006}' },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const body = question("Hvor er ordrenummer 50006?");
    await (await handleChat(post(body), deps(viewer, model))).text();
    const [row] = await usageRows(body.id);
    expect(row).toMatchObject({ input_tokens: 1000, output_tokens: 100, cached_tokens: 200 });
  });

  it("counts an error chunk's step", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "response-metadata", id: "r1", modelId: "claude-sonnet-5-5", timestamp: new Date(NOW) },
            { type: "error", error: new Error("overloaded") },
            { type: "finish", finishReason: { unified: "error", raw: undefined }, usage },
          ] satisfies LanguageModelV4StreamPart[],
        }),
      }),
    });
    const body = question("Hej");
    await (await handleChat(post(body), deps(viewer, model))).text();
    const rows = await usageRows(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(1000);
  });

  it("writes an estimated row when the first model call fails", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("provider down");
      },
    });
    const body = question("Hvor er ordrenummer 50006?");
    const streamed = await (await handleChat(post(body), deps(viewer, model))).text();
    expect(streamed).toContain("Svaret kunne ikke hentes");
    const rows = await usageRows(body.id);
    expect(rows).toHaveLength(1);
    // No answer to point at; the prompt (system prompt and tools) was estimated.
    expect(rows[0].message_id).toBeNull();
    // The tool definitions are most of a short request: far above the system prompt alone.
    expect(rows[0].input_tokens).toBeGreaterThan(2000);
    expect(rows[0].output_tokens).toBe(0);

    // A failed turn stores no empty assistant message.
    const messages = await db.withService((tx) =>
      tx.query<{ role: string }>(`select role from ai.messages where conversation_id = $1`, [body.id])
    );
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });
});
