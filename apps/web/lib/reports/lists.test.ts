// The lists behind the chat questions: missing scan outs, packed orders with
// missing elements, the baseline suggestion, and the two questions the portal
// has no data for yet (capacity plan, staffing).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { PACKING, pass } from "@/lib/test-helpers";
import {
  getBaselineSuggestion,
  getCapacityPlan,
  getStaffingAnalysis,
  listIncompletePackedOrders,
  listMissingScanOuts,
} from "./index";
import { CET, element, IN_PROGRESS_ORDERS, local, NOW, seedConfig, seedOctober, TYPE_A } from "./test-support";

const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

/** 50009: two elements expected, one assembled and packed on Thursday 12 November, the other never seen. */
const HALF_PACKED = {
  scans: [
    ...pass(local("2026-11-12", "07:00", CET), local("2026-11-12", "07:30", CET), element(50009, 1)),
    ...pass(local("2026-11-12", "08:00", CET), local("2026-11-12", "08:10", CET), { ...element(50009, 1), ...PACKING }),
  ],
  info: {
    orderNo: 50009,
    customer: "Madsen Vinduer",
    caseName: "Engvej 7",
    deliveryWeek: 47,
    deliveryYear: 2026,
    expectedElements: [{ position: 1, quantity: 2, elementTypeId: TYPE_A }],
  },
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedOctober(db, [...IN_PROGRESS_ORDERS, HALF_PACKED]);
});
afterAll(() => db.close());

describe("listMissingScanOuts", () => {
  it("lists passes scanned In and never Out, with the reason", async () => {
    const list = await listMissingScanOuts(viewer);
    expect(list).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(list.rows[0]).toMatchObject({
      orderNo: 50008,
      customer: null,
      barcode: "050008010101",
      stationNo: 1,
      stationName: "Station 10",
      startAt: "2026-11-10T06:00:00.000Z",
      localDay: "2026-11-10",
      missingReason: "stale",
      reasonLabel: "Ingen ud-scanning i 36 timer",
      orderStatus: "in_progress",
    });
  });

  it("a period is on the local day of the In scan", async () => {
    expect((await listMissingScanOuts(viewer, { from: "2026-11-10", to: "2026-11-10" })).total).toBe(1);
    expect((await listMissingScanOuts(viewer, { from: "2026-11-11", to: "2026-11-30" })).total).toBe(0);
    expect((await listMissingScanOuts(viewer, OCTOBER)).rows).toEqual([]);
    // The open pass of 50006 on Station 20 is an hour old: open, not missing.
    expect((await listMissingScanOuts(viewer)).rows.map((r) => r.orderNo)).not.toContain(50006);
  });
});

describe("listIncompletePackedOrders", () => {
  it("lists orders with something packed and a position not fully packed", async () => {
    const list = await listIncompletePackedOrders(viewer, { now: NOW });
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({
      orderNo: 50009,
      customer: "Madsen Vinduer",
      caseName: "Engvej 7",
      deliveryWeek: 47,
      elementsExpected: 2,
      elementsSeen: 1,
      elementsPacked: 1,
      missingElements: [{ position: 1, subPosition: 1, expected: 2, seen: 1, packed: 1 }],
      lastScanAt: "2026-11-12T07:10:00.000Z",
    });
  });

  it("only after the quiet hours", async () => {
    // Thursday 08:10 to Monday 12:00 is 99 h 50 min.
    expect((await listIncompletePackedOrders(viewer, { now: NOW, quietHours: 99 })).total).toBe(1);
    expect((await listIncompletePackedOrders(viewer, { now: NOW, quietHours: 100 })).total).toBe(0);
    expect((await listIncompletePackedOrders(viewer, { now: local("2026-11-12", "12:00", CET) })).total).toBe(0);
  });
});

describe("getBaselineSuggestion", () => {
  it("suggests the measured median per station and element type", async () => {
    const b = await getBaselineSuggestion(viewer, { ...OCTOBER, minSamples: 1 });
    expect(b.period).toEqual(OCTOBER);
    expect(b.weeks).toBe(4.4);
    expect(b.rows).toHaveLength(2);
    // Station 10: 1200, 1800, 1800, 3600. Quartiles 1650 and 2250.
    expect(b.rows[0]).toMatchObject({
      stationNo: 1,
      elementTypeId: "vindue_1_fag",
      samples: 4,
      meanSeconds: 2100,
      p25Seconds: 1650,
      p75Seconds: 2250,
      currentSeconds: 1500,
      currentSource: "manual",
      suggestedSeconds: 1800,
    });
    expect(b.rows[1]).toMatchObject({ stationNo: 7, samples: 3, suggestedSeconds: 600, currentSeconds: 600 });
  });

  it("leaves out pairs with fewer samples than asked for", async () => {
    expect((await getBaselineSuggestion(viewer, { ...OCTOBER, minSamples: 4 })).rows.map((r) => r.stationNo)).toEqual([1]);
    // The default is five samples.
    expect((await getBaselineSuggestion(viewer, OCTOBER)).rows).toEqual([]);
  });
});

describe("getCapacityPlan", () => {
  it("says there is no data and shows the calendar of the week", async () => {
    await db.withService((tx) =>
      tx.query("insert into config.calendar_closed_days (day, name) values (date '2026-11-18', 'Lukket')")
    );
    const plan = await getCapacityPlan(viewer, { day: "2026-11-18" });
    expect(plan).toMatchObject({
      available: false,
      reason: "no_planned_orders",
      weekStart: "2026-11-16",
      isoWeek: 47,
      assemblyStations: 2,
      // 50009 is in progress with delivery week 47.
      openOrdersDue: 1,
    });
    expect(plan.message).toContain("Ingen data endnu");
    expect(plan.days.map((d) => [d.day, d.weekday, d.closed, d.shiftSeconds])).toEqual([
      ["2026-11-16", 1, false, 28800],
      ["2026-11-17", 2, false, 28800],
      ["2026-11-18", 3, true, 0],
      ["2026-11-19", 4, false, 28800],
      ["2026-11-20", 5, false, 28800],
      ["2026-11-21", 6, false, 0],
      ["2026-11-22", 7, false, 0],
    ]);
    expect(plan.days[2].closedName).toBe("Lukket");
    expect(plan.days.every((d) => d.plannedOrders === null && d.plannedLoadSeconds === null)).toBe(true);
  });
});

describe("getStaffingAnalysis", () => {
  it("says there is no data and shows output per station per day", async () => {
    const s = await getStaffingAnalysis(viewer, { from: "2026-10-21", to: "2026-10-21" });
    expect(s).toMatchObject({ available: false, reason: "no_staffing_data", clock: "working" });
    expect(s.message).toContain("Ingen data endnu");
    expect(s.days.map((d) => [d.stationNo, d.localDay, d.countThrough, d.timePerPiece.seconds, d.people])).toEqual([
      [1, "2026-10-21", 1, 1800, null],
      [7, "2026-10-21", 1, 600, null],
    ]);
    const one = await getStaffingAnalysis(viewer, { ...OCTOBER, stationNo: 7 });
    expect(one.days.map((d) => d.localDay)).toEqual(["2026-10-21", "2026-10-26", "2026-10-31"]);
  });
});
