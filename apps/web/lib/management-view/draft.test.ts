// "Lav udkast" on Ledelse with a mocked model: who may draft, what the model
// is given, what comes back, and the ai.usage_events row.

import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { FORBIDDEN_MESSAGE } from "@/lib/settings/result";
import { DRAFT_INSTRUCTIONS, DRAFT_MESSAGES, draftManagementNotes, draftText, type DraftDeps } from "./draft";

const ledelse = testClaims("ledelse");
const admin = testClaims("admin");
const planner = testClaims("planner");

const ANSWER = {
  highlights: ["- Gennemløbstiden var 11 t 20 min.", "Leveret til tiden: 94 %.\nSe Buffer."],
  decisions: ["Skal bufferen have en fast tømning hver formiddag?"],
};

function mockModel(text = JSON.stringify(ANSWER)): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1200, noCache: 1000, cacheRead: 200, cacheWrite: undefined },
        outputTokens: { total: 150, text: 150, reasoning: undefined },
      },
      response: { id: "r1", modelId: "claude-sonnet-5-5", timestamp: new Date(NOW) },
      warnings: [],
    }),
  });
}

function deps(claims: Claims | null, model: MockLanguageModelV4, over: Partial<DraftDeps> = {}): DraftDeps {
  return {
    access: async () => (claims ? { role: claims.role, claims, roleDegraded: false } : null),
    model: () => model as unknown as LanguageModel,
    modelId: () => "claude-sonnet-5-5",
    configured: () => true,
    now: () => NOW,
    ip: async () => "127.0.0.1",
    allow: async () => true,
    ...over,
  };
}

describe("draftText", () => {
  it("cleans the model's lines into one point per line", () => {
    expect(draftText(ANSWER.highlights, 5)).toBe("Gennemløbstiden var 11 t 20 min.\nLeveret til tiden: 94 %. Se Buffer.");
    expect(draftText(["a", "", "b", "c"], 2)).toBe("a\nb");
  });
});

describe("draftManagementNotes", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);
  beforeEach(async () => {
    await db.reset();
    await seedConfig(db);
    await seedOctober(db);
  });
  afterAll(() => db.close());

  const usageRows = () =>
    db.withService((tx) =>
      tx.query<{ opti_user_id: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number; conversation_id: string | null }>(
        "select opti_user_id, model, input_tokens, output_tokens, cached_tokens, conversation_id from ai.usage_events"
      )
    );

  it("refuses roles other than admin and ledelse without calling the model", async () => {
    const model = mockModel();
    expect(await draftManagementNotes("2026-10", deps(planner, model))).toEqual({ ok: false, error: FORBIDDEN_MESSAGE });
    expect(await draftManagementNotes("2026-10", deps(null, model))).toEqual({ ok: false, error: DRAFT_MESSAGES.session });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("says so when AI is not configured, the month is bad or the limit is hit", async () => {
    const model = mockModel();
    expect(await draftManagementNotes("2026-10", deps(admin, model, { configured: () => false }))).toEqual({
      ok: false,
      error: DRAFT_MESSAGES.notConfigured,
    });
    expect(await draftManagementNotes("2026-13", deps(admin, model))).toEqual({ ok: false, error: DRAFT_MESSAGES.month });
    expect(await draftManagementNotes("2026-10", deps(admin, model, { allow: async () => false }))).toEqual({
      ok: false,
      error: DRAFT_MESSAGES.rateLimited,
    });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await usageRows()).toEqual([]);
  });

  it("drafts from the month report, saves no notes and records the usage", async () => {
    const model = mockModel();
    const result = await draftManagementNotes("2026-10", deps(ledelse, model));
    expect(result).toEqual({
      ok: true,
      highlights: "Gennemløbstiden var 11 t 20 min.\nLeveret til tiden: 94 %. Se Buffer.",
      decisions: "Skal bufferen have en fast tømning hver formiddag?",
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    const sent = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(sent).toContain("oktober 2026");
    expect(sent).toContain("noegletal");
    expect(sent).toContain("Brug kun tal og navne, der står i data");
    expect(DRAFT_INSTRUCTIONS).not.toMatch(new RegExp("[\\u2013\\u2014]"));

    expect(await usageRows()).toEqual([
      {
        opti_user_id: ledelse.optiUserId,
        model: "claude-sonnet-5-5",
        input_tokens: 1200,
        output_tokens: 150,
        cached_tokens: 200,
        conversation_id: null,
      },
    ]);
    const notes = await db.withService((tx) => tx.query("select 1 from rpt.management_notes"));
    expect(notes).toEqual([]);
  });

  it("answers a Danish message when the model's output does not fit", async () => {
    const result = await draftManagementNotes("2026-10", deps(admin, mockModel("ikke json")));
    expect(result).toEqual({ ok: false, error: DRAFT_MESSAGES.failed });
  });
});
