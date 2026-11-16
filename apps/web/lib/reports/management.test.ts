// Ledelse: calculated against measured, the month report, freezing and notes,
// on the October scenario (figures in overview.test.ts).
//
// Calculated times: Station 10 1200 s, Pakning 600 s (both for "vindue_1_fag").
// Measured medians in October: Station 10 1800 s (4 passes), Pakning 600 s (3 passes).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import {
  freezeMonth,
  getCalcVsMeasured,
  getManagementKpis,
  getManagementNotes,
  getMonthlyLeadTime,
  getMonthReport,
  getSnapshot,
  listSnapshots,
  saveManagementNotes,
} from "./index";
import { CET, local, NOW, seedConfig, seedOctober, seedScans, simpleOrder } from "./test-support";

const admin = testClaims("admin");
const ledelse = testClaims("ledelse");
const planner = testClaims("planner");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const NOW_ISO = new Date(NOW).toISOString();

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedOctober(db);
});
afterAll(() => db.close());

describe("getCalcVsMeasured", () => {
  it("compares per station and sums per element type", async () => {
    const c = await getCalcVsMeasured(planner, OCTOBER);
    expect(c.thresholdPercent).toBe(15);
    expect(c.rows).toHaveLength(2);
    // (1800 - 1200) / 1200 = +50 %, over the threshold of 15.
    expect(c.rows[0]).toMatchObject({
      stationNo: 1,
      stationName: "Station 10",
      elementTypeId: "vindue_1_fag",
      calculatedSeconds: 1200,
      normalSeconds: 1500,
      passes: 4,
      measured: { seconds: 1800, wallSeconds: 1800, workingSeconds: 1800 },
      deviationPercent: 50,
      flagged: true,
    });
    expect(c.rows[1]).toMatchObject({ stationNo: 7, calculatedSeconds: 600, passes: 3, deviationPercent: 0, flagged: false });
    // The element type as a whole: 1200 + 600 calculated against 1800 + 600 measured, +33 %.
    expect(c.byElementType).toEqual([
      {
        elementTypeId: "vindue_1_fag",
        elementTypeName: "Vindue 1 fag",
        calculatedSeconds: 1800,
        measuredSeconds: 2400,
        deviationPercent: 33,
        flagged: true,
        stationsCompared: 2,
        stationsIncomplete: 0,
        passes: 7,
      },
    ]);
  });

  it("filters on station, and a period without passes has no measured time", async () => {
    const one = await getCalcVsMeasured(admin, { ...OCTOBER, stationNo: 7 });
    expect(one.rows.map((r) => r.stationNo)).toEqual([7]);
    const empty = await getCalcVsMeasured(admin, { from: "2026-07-01", to: "2026-07-31" });
    for (const row of empty.rows) {
      expect(row.passes).toBe(0);
      expect(row.measured.seconds).toBeNull();
      expect(row.deviationPercent).toBeNull();
      expect(row.flagged).toBe(false);
    }
  });
});

describe("getManagementKpis and getMonthlyLeadTime", () => {
  it("a calendar month against the calendar month before", async () => {
    const k = await getManagementKpis(ledelse, { month: "2026-10" });
    expect(k.period).toEqual(OCTOBER);
    expect(k.previousPeriod).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(k.current.lead).toEqual({ seconds: 6800, wallSeconds: 125000, workingSeconds: 6800 });
    expect(k.current.onTimePercent).toBe(66.7);
    expect(k.previous.lead.seconds).toBe(9000);
    expect(k.change.leadPercent).toBe(-24);
  });

  it("month by month, empty months included", async () => {
    const months = await getMonthlyLeadTime(ledelse, { month: "2026-10", months: 3 });
    expect(months.map((m) => [m.bucketStart, m.label, m.ordersPacked, m.lead.seconds])).toEqual([
      ["2026-08-01", "aug.", 0, null],
      ["2026-09-01", "sep.", 1, 9000],
      ["2026-10-01", "okt.", 3, 6800],
    ]);
    expect(await getMonthlyLeadTime(ledelse, { month: "2026-10" })).toHaveLength(12);
  });
});

describe("getMonthReport and freezeMonth", () => {
  it("computes the month from the facts while it is not frozen", async () => {
    const r = await getMonthReport(ledelse, { month: "2026-10", now: NOW });
    expect(r).toMatchObject({ frozen: false, frozenAt: null, pdfPath: null });
    expect(r.report).toMatchObject({
      version: 1,
      month: "2026-10-01",
      period: OCTOBER,
      generatedAt: NOW_ISO,
      clock: "working",
      missingScanOuts: 0,
    });
    expect(r.report.kpis).toEqual(await getManagementKpis(ledelse, { month: "2026-10" }));
    expect(r.report.leadTimeMonthly).toHaveLength(12);
    // The weeks that touch the month, counting only what was packed in the month.
    expect(r.report.leadTimeWeekly.map((w) => [w.bucketStart, w.ordersPacked])).toEqual([
      ["2026-09-28", 0],
      ["2026-10-05", 0],
      ["2026-10-12", 0],
      ["2026-10-19", 1],
      ["2026-10-26", 2],
    ]);
    expect(r.report.bottleneck.bottleneck?.step).toBe("wait_packing");
    expect(r.report.stations.map((s) => s.stationNo)).toEqual([1, 2, 7]);
    expect(r.report.calcVsMeasured).toEqual(await getCalcVsMeasured(ledelse, OCTOBER));
    expect(r.report.notes).toEqual({
      month: "2026-10-01",
      highlights: [],
      decisions: [],
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("freezing is idempotent, and a frozen month no longer moves with the facts", async () => {
    expect(await listSnapshots(ledelse)).toEqual([]);
    expect(await getSnapshot(ledelse, { month: "2026-10" })).toBeNull();

    const first = await freezeMonth("2026-10", NOW);
    expect(first).toEqual({ month: "2026-10-01", written: true, frozenAt: NOW_ISO });
    const later = NOW + 3_600_000;
    expect(await freezeMonth("2026-10", later)).toEqual({ month: "2026-10-01", written: false, frozenAt: NOW_ISO });
    expect(await listSnapshots(ledelse)).toEqual([{ month: "2026-10-01", frozenAt: NOW_ISO, pdfPath: null }]);

    // One more order packed in October arrives after the freeze.
    const extra = simpleOrder({
      orderNo: 50020,
      assemblyIn: local("2026-10-27", "07:00", CET),
      assemblyOut: local("2026-10-27", "07:30", CET),
      packIn: local("2026-10-27", "08:00", CET),
      packOut: local("2026-10-27", "08:10", CET),
    });
    await seedScans(db, extra.scans, [extra.info], { now: NOW });

    const frozen = await getMonthReport(ledelse, { month: "2026-10", now: later });
    expect(frozen).toMatchObject({ frozen: true, frozenAt: NOW_ISO });
    expect(frozen.report.kpis.current.ordersPacked).toBe(3);
    expect(frozen.report.generatedAt).toBe(NOW_ISO);
    expect(await getSnapshot(ledelse, { month: "2026-10" })).toEqual(frozen);

    const live = await getMonthReport(ledelse, { month: "2026-10", now: later, live: true });
    expect(live.frozen).toBe(false);
    expect(live.report.kpis.current.ordersPacked).toBe(4);

    // Only force writes the month again.
    const forced = await freezeMonth("2026-10", later, { force: true });
    expect(forced).toEqual({ month: "2026-10-01", written: true, frozenAt: new Date(later).toISOString() });
    expect((await getMonthReport(ledelse, { month: "2026-10", now: later })).report.kpis.current.ordersPacked).toBe(4);
    expect(await listSnapshots(ledelse)).toHaveLength(1);
  });
});

describe("management notes", () => {
  it("saves, reads back, lands in the month report and leaves an audit row", async () => {
    expect(await getManagementNotes(ledelse, { month: "2026-10" })).toEqual({
      month: "2026-10-01",
      highlights: [],
      decisions: [],
      updatedAt: null,
      updatedBy: null,
    });

    const saved = await saveManagementNotes(ledelse, {
      month: "2026-10",
      highlights: ["Gennemløbstiden faldt", "Pakning venter på montage"],
      decisions: ["Ekstra mand på Station 10?"],
      now: NOW,
    });
    expect(saved).toEqual({
      month: "2026-10-01",
      highlights: ["Gennemløbstiden faldt", "Pakning venter på montage"],
      decisions: ["Ekstra mand på Station 10?"],
      updatedAt: NOW_ISO,
      updatedBy: "test-ledelse",
    });
    expect(await getManagementNotes(admin, { month: "2026-10-15" })).toEqual(saved);
    expect((await getMonthReport(ledelse, { month: "2026-10", now: NOW })).report.notes).toEqual(saved);

    // Saving again replaces the month's notes.
    const again = await saveManagementNotes(admin, { month: "2026-10", highlights: [], decisions: [], now: NOW + 1000 });
    expect(again).toMatchObject({ highlights: [], decisions: [], updatedBy: "test-admin" });

    const audit = await db.withService((tx) =>
      tx.query<{ opti_user_id: string; role: string; action: string; subject: string; detail: unknown }>(
        "select opti_user_id, role, action, subject, detail from app.audit_log order by id"
      )
    );
    expect(audit).toEqual([
      {
        opti_user_id: "test-ledelse",
        role: "ledelse",
        action: "management_notes.saved",
        subject: "2026-10-01",
        detail: { highlights: 2, decisions: 1 },
      },
      {
        opti_user_id: "test-admin",
        role: "admin",
        action: "management_notes.saved",
        subject: "2026-10-01",
        detail: { highlights: 0, decisions: 0 },
      },
    ]);
  });

  it("refuses empty lines and too many of them", async () => {
    const base = { month: "2026-10", decisions: [], now: NOW };
    await expect(saveManagementNotes(ledelse, { ...base, highlights: [""] })).rejects.toThrow();
    await expect(
      saveManagementNotes(ledelse, { ...base, highlights: Array.from({ length: 21 }, (_, i) => `Linje ${i}`) })
    ).rejects.toThrow();
  });
});
