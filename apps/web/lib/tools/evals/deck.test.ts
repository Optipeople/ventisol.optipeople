// The six questions from the sales deck (docs/web-portal-plan.md section 1
// and 5.2) against the real model on the Anthropic API, on the seeded
// test database, plus questions the deck did not have (parallel work at a
// station). Asserts tool choice: the right tool is called, and a role
// never reaches a tool it may not use.
//
// Costs real money, so it runs only with a key in the shell (vitest does not
// read .env.local):
//
//   ANTHROPIC_API_KEY=... npx vitest run lib/tools/evals
//
// Without the key every case is skipped. CHAT_MODEL picks the model as in
// the route.

import { generateText, isStepCount } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatModel } from "@/app/api/chat/config";
import { aiTools } from "@/app/api/chat/tools";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { buildSystemPrompt } from "@/lib/tools";

const enabled = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

interface DeckCase {
  question: string;
  /** At least one of these tools must be called. */
  anyOf: string[];
  claims: Claims;
  /** None of these may be called. */
  never?: string[];
  /** The answer must match this. */
  says?: RegExp;
}

// Order 1042 from the deck is 50006 in the test data (an order in progress).
const CASES: DeckCase[] = [
  {
    question: "Hvor er ordrenummer 50006, og hvornår er den klar til afsendelse?",
    anyOf: ["order_status"],
    claims: testClaims("planner"),
  },
  { question: "Hvor venter ordrerne mest i denne uge?", anyOf: ["bottleneck", "kpi_summary"], claims: testClaims("planner") },
  { question: "Holder kalkulen pr. elementtype?", anyOf: ["calc_vs_measured"], claims: testClaims("ledelse") },
  { question: "Passer næste uges batches ind?", anyOf: ["capacity_plan"], claims: testClaims("planner") },
  { question: "Hvor mange skal stå ved montagen?", anyOf: ["staffing_analysis"], claims: testClaims("planner") },
  {
    question: "Hvad skal ledelsen vide i dag?",
    anyOf: ["kpi_summary", "management_kpis"],
    claims: testClaims("ledelse"),
  },
  // Not from the deck: the glazing station (seeded below with "Max i gang" 6)
  // works several elements at once, so its time per piece is split time.
  {
    question: "Hvorfor ser glas-stationen langsom ud?",
    anyOf: ["station_performance", "station_timeline", "station_day"],
    claims: testClaims("planner"),
    says: /delt/i,
  },
];

async function ask(c: { question: string; claims: Claims }) {
  const tools = aiTools({ claims: c.claims, now: NOW });
  const result = await generateText({
    model: chatModel(),
    instructions: buildSystemPrompt({ now: NOW, role: c.claims.role }),
    prompt: c.question,
    tools,
    stopWhen: isStepCount(6),
    reasoning: "medium",
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });
  return { called: result.toolCalls.map((t) => t.toolName), text: result.text };
}

describe.skipIf(!enabled)("deck questions (live model)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seedConfig(db);
    await db.withService((tx) =>
      tx.query(`insert into config.stations (station_no, name, kind, sort_order, max_open) values (3, 'Glas', 'assembly', 30, 6)`)
    );
    await seedOctober(db, IN_PROGRESS_ORDERS);
  });
  afterAll(() => db.close());

  it.each(CASES)("$question", async (c) => {
    const { called, text } = await ask(c);
    expect(called.some((name) => c.anyOf.includes(name)), `called: ${called.join(", ")}`).toBe(true);
    for (const name of c.never ?? []) expect(called).not.toContain(name);
    if (c.says) expect(text).toMatch(c.says);
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);

  it("a viewer asking about the calculation never reaches calc_vs_measured", async () => {
    const { called, text } = await ask({ question: "Holder kalkulen pr. elementtype?", claims: testClaims("viewer") });
    expect(called).not.toContain("calc_vs_measured");
    expect(text).toMatch(/adgang|rolle/i);
  }, 180_000);
});
