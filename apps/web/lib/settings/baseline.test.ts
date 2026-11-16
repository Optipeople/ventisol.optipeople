// "Foreslå fra baseline": the proposal (read only, times.edit only) and
// "Brug forslag" (saves through saveTimes, which audits).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import type { BaselineSuggestionRow } from "@/lib/reports/types";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober, TYPE_A } from "@/lib/reports/test-support";
import {
  applyBaselineProposal,
  baselineEntries,
  baselineWindow,
  loadBaselineProposal,
  toProposalRows,
} from "./baseline";
import { parseMinutes } from "./format";
import { FORBIDDEN_MESSAGE } from "./result";
import { listTimes } from "./times";

const planner = testClaims("planner");
const admin = testClaims("admin");
const ledelse = testClaims("ledelse");
const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

function row(over: Partial<BaselineSuggestionRow>): BaselineSuggestionRow {
  return {
    stationNo: 1,
    stationName: "Station 10",
    stationKind: "assembly",
    elementTypeId: TYPE_A,
    elementTypeName: "Vindue 1 fag",
    samples: 6,
    suggestedSeconds: 1800,
    median: { seconds: 1800, wallSeconds: 1800, workingSeconds: 1800 },
    meanSeconds: 1900,
    p25Seconds: 1700,
    p75Seconds: 2000,
    currentSeconds: 1500,
    currentSource: "manual",
    ...over,
  };
}

describe("baseline helpers", () => {
  it("measures the eight weeks that end yesterday", () => {
    expect(baselineWindow(NOW)).toEqual({ from: "2026-09-21", to: "2026-11-15" });
  });

  it("keeps only rows that can become a changed normal time", () => {
    const active = { stations: new Set([1, 2]), types: new Set([TYPE_A]) };
    const out = toProposalRows(
      [
        row({}),
        row({ stationNo: 2, suggestedSeconds: 600.5, currentSeconds: null }),
        row({ elementTypeId: null }),
        row({ stationNo: 9 }),
        row({ elementTypeId: "doer" }),
        row({ stationNo: 2, elementTypeId: TYPE_A, suggestedSeconds: 1500, currentSeconds: 1500 }),
      ],
      active
    );
    expect(out.unchanged).toBe(1);
    expect(out.rows.map((r) => [r.stationNo, r.currentSeconds, r.suggestedSeconds])).toEqual([
      [1, 1500, 1800],
      [2, null, 601],
    ]);
  });

  it("maps kept rows to minutes that read back to the same seconds", () => {
    const entries = baselineEntries([
      { stationNo: 1, elementTypeId: TYPE_A, seconds: 1800 },
      { stationNo: 7, elementTypeId: TYPE_A, seconds: 1801 },
    ]);
    expect(entries).toEqual([
      { stationNo: 1, elementTypeId: TYPE_A, minutes: "30" },
      { stationNo: 7, elementTypeId: TYPE_A, minutes: "30,02" },
    ]);
    expect(entries.map((e) => parseMinutes(e.minutes))).toEqual([1800, 1801]);
  });
});

describe("baseline proposal and apply", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);
  beforeEach(async () => {
    await db.reset();
    await seedConfig(db);
    await seedOctober(db, IN_PROGRESS_ORDERS);
  });
  afterAll(() => db.close());

  it("refuses roles without times.edit", async () => {
    for (const claims of [viewer, ledelse]) {
      expect(await loadBaselineProposal(claims, NOW, OCTOBER, 1)).toEqual({ ok: false, error: FORBIDDEN_MESSAGE });
      expect(
        await applyBaselineProposal(claims, [{ stationNo: 1, elementTypeId: TYPE_A, seconds: 1800 }])
      ).toEqual({ ok: false, error: FORBIDDEN_MESSAGE });
    }
  });

  it("proposes the measured median and saves nothing", async () => {
    const before = await listTimes(admin, "normal");
    const proposal = await loadBaselineProposal(planner, NOW, OCTOBER, 1);
    if (!proposal.ok) throw new Error(proposal.error);
    expect(proposal.period).toEqual(OCTOBER);
    expect(proposal.minSamples).toBe(1);
    expect(proposal.rows.find((r) => r.stationNo === 1 && r.elementTypeId === TYPE_A)).toMatchObject({
      currentSeconds: 1500,
      suggestedSeconds: 1800,
      samples: 4,
    });
    expect(await listTimes(admin, "normal")).toEqual(before);
  });

  it("saves the kept rows through saveTimes, audited", async () => {
    const result = await applyBaselineProposal(planner, [{ stationNo: 1, elementTypeId: TYPE_A, seconds: 1800 }]);
    expect(result).toEqual({ ok: true, message: "1 normaltid er gemt." });
    const cell = (await listTimes(admin, "normal")).find((c) => c.stationNo === 1 && c.elementTypeId === TYPE_A);
    expect(cell).toMatchObject({ seconds: 1800, updatedBy: planner.optiUserId });
    const audit = await db.withService((tx) =>
      tx.query<{ action: string; subject: string; detail: { after: { seconds: number } } }>(
        "select action, subject, detail from app.audit_log where action = 'normal_time.set'"
      )
    );
    expect(audit).toEqual([
      expect.objectContaining({ subject: `1/${TYPE_A}`, detail: expect.objectContaining({ after: expect.objectContaining({ seconds: 1800 }) }) }),
    ]);
  });

  it("refuses an empty or malformed selection", async () => {
    expect((await applyBaselineProposal(planner, [])).ok).toBe(false);
    expect((await applyBaselineProposal(planner, [{ stationNo: 1, elementTypeId: TYPE_A, seconds: -5 }])).ok).toBe(false);
  });
});
