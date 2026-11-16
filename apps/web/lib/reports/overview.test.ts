// Overblik: KPIs, lead time series, bottleneck and the today strip, on four
// hand-made orders around the end of October 2026 (the clocks go back on
// Sunday the 25th, so the month holds both offsets).
//
// Calendar: Monday to Friday 06:00 to 14:00.
//
//   A 50001  Wed 21/10  assembly 07:00-07:30, packing 08:30-08:40   week 43
//            lead 6000 wall / 6000 working; work 2400; wait 3600
//   B 50002  Fri 30/10  assembly 12:00-13:00, packing Sat 31/10 23:20-23:30   week 43 (late)
//            lead 127800 wall / 7200 working; work 4200 / 3600; wait 123600 / 3600
//   C 50003  Fri 30/10  assembly 08:00-08:20, packing Sun 1/11 00:05-00:10   no week
//            packed in November
//   D 50004  Fri 23/10  assembly 13:00-13:30 (CEST), packing Mon 26/10 06:30-07:00 (CET)   week 44
//            lead 241200 wall (67 h: the weekend is an hour longer) / 7200 working
//            work 3600 / 3600; wait 237600 / 3600
//   E 50005  Tue 15/9   assembly 07:00-08:00, packing 09:00-09:30   no week
//            lead 9000; work 5400; wait 3600

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { STEP_KEYS } from "@/lib/derive";
import { getBottleneck, getKpiSummary, getLeadTimeSeries, getPeriodKpis, getTodayStrip } from "./index";
import { CET, local, NOW, OCTOBER_ORDERS as ORDERS, seedConfig, seedScans } from "./test-support";

const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedScans(
    db,
    ORDERS.flatMap((o) => o.scans),
    ORDERS.map((o) => o.info),
    { now: NOW }
  );
});
afterAll(() => db.close());

describe("getPeriodKpis", () => {
  it("counts an order packed 23:30 on the last day and leaves out one packed 00:10 the day after", async () => {
    const k = await getPeriodKpis(viewer, OCTOBER);
    expect(k.clock).toBe("working");
    expect(k.current.ordersPacked).toBe(3);
    expect(k.current.elementsPacked).toBe(3);
    // (6000 + 127800 + 241200) / 3 and (6000 + 7200 + 7200) / 3
    expect(k.current.lead).toEqual({ seconds: 6800, wallSeconds: 125000, workingSeconds: 6800 });
    expect(k.current.wait).toEqual({ seconds: 3600, wallSeconds: 121600, workingSeconds: 3600 });
    expect(k.current.work).toEqual({ seconds: 3200, wallSeconds: 3400, workingSeconds: 3200 });
    // A and D on time, B late: 2 of 3.
    expect(k.current.onTimeOrders).toBe(2);
    expect(k.current.onTimeKnown).toBe(3);
    expect(k.current.onTimePercent).toBe(66.7);

    const november = await getPeriodKpis(viewer, { from: "2026-11-01", to: "2026-11-30" });
    expect(november.current.ordersPacked).toBe(1);
    expect(november.current.onTimeKnown).toBe(0);
    expect(november.current.onTimePercent).toBeNull();
  });

  it("compares with the period of equal length right before", async () => {
    const k = await getPeriodKpis(viewer, OCTOBER);
    expect(k.previousPeriod).toEqual({ from: "2026-08-31", to: "2026-09-30" });
    expect(k.previous.ordersPacked).toBe(1);
    expect(k.previous.lead.seconds).toBe(9000);
    // (6800 - 9000) / 9000 = -24.4 %
    expect(k.change.leadPercent).toBe(-24);
    expect(k.change.waitPercent).toBe(0);
    expect(k.change.ordersPercent).toBe(200);
    // The previous period has no order with a delivery week.
    expect(k.change.onTimePoints).toBeNull();
  });

  it("the wall clock is the headline when asked for, or when deduct_off_shift is off", async () => {
    const k = await getPeriodKpis(viewer, { ...OCTOBER, clock: "wall" });
    expect(k.clock).toBe("wall");
    expect(k.current.lead.seconds).toBe(125000);
    // (125000 - 9000) / 9000 = 1288.9 %
    expect(k.change.leadPercent).toBe(1289);
  });

  it("an empty period gives nulls, not zeros", async () => {
    const k = await getPeriodKpis(viewer, { from: "2026-07-01", to: "2026-07-31" });
    expect(k.current.ordersPacked).toBe(0);
    expect(k.current.lead).toEqual({ seconds: null, wallSeconds: null, workingSeconds: null });
    expect(k.current.wait.seconds).toBeNull();
    expect(k.current.onTimePercent).toBeNull();
    expect(k.change).toEqual({ leadPercent: null, waitPercent: null, onTimePoints: null, ordersPercent: null });
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(getPeriodKpis(viewer, { from: "2026-10-31", to: "2026-10-01" })).rejects.toThrow();
  });
});

describe("getLeadTimeSeries", () => {
  it("weeks across the clock change, empty weeks included", async () => {
    const weeks = await getLeadTimeSeries(viewer, { from: "2026-10-12", to: "2026-11-01", bucket: "week" });
    expect(weeks.map((w) => [w.bucketStart, w.bucketEnd, w.isoWeek, w.label, w.ordersPacked])).toEqual([
      ["2026-10-12", "2026-10-18", 42, "42", 0],
      ["2026-10-19", "2026-10-25", 43, "43", 1],
      // D (Monday) and B (Saturday 23:30). C, packed Sunday 00:10, is in the same ISO week.
      ["2026-10-26", "2026-11-01", 44, "44", 3],
    ]);
    expect(weeks[0].lead.seconds).toBeNull();
    expect(weeks[1].lead).toEqual({ seconds: 6000, wallSeconds: 6000, workingSeconds: 6000 });
  });

  it("months", async () => {
    const months = await getLeadTimeSeries(viewer, { from: "2026-08-01", to: "2026-11-30", bucket: "month" });
    expect(months.map((m) => [m.bucketStart, m.bucketEnd, m.ordersPacked])).toEqual([
      ["2026-08-01", "2026-08-31", 0],
      ["2026-09-01", "2026-09-30", 1],
      ["2026-10-01", "2026-10-31", 3],
      ["2026-11-01", "2026-11-30", 1],
    ]);
    expect(months[2].lead.wallSeconds).toBe(125000);
    expect(months[2].label).toBe("okt.");
  });
});

describe("getBottleneck", () => {
  it("the seven step averages add up to the average lead time", async () => {
    for (const clock of ["working", "wall"] as const) {
      const b = await getBottleneck(viewer, { ...OCTOBER, clock });
      const k = await getPeriodKpis(viewer, { ...OCTOBER, clock });
      expect(b.steps.map((s) => s.step)).toEqual([...STEP_KEYS]);
      const sum = b.steps.reduce((total, s) => total + (s.countsInLead ? (s.duration.seconds ?? 0) : 0), 0);
      expect(sum).toBe(k.current.lead.seconds);
      expect(b.lead.seconds).toBe(k.current.lead.seconds);
      expect(b.ordersPacked).toBe(3);
    }
  });

  it("names the step with the longest average wait and lists the steps with no data", async () => {
    const b = await getBottleneck(viewer, OCTOBER);
    // All waiting of these orders lies between assembly and packing.
    expect(b.bottleneck).toEqual({ step: "wait_packing", label: "Venter før pakning", waitSeconds: 3600 });
    expect(b.sentence).toContain("1 t 00 min");
    expect(b.missingSteps).toEqual(["Schirmer", "Venter før KMW", "KMW-anlægget", "Buffer"]);
    const packing = b.stations.find((s) => s.stationNo === 7);
    expect(packing?.passes).toBe(3);
    expect(packing?.avgWaitBefore.workingSeconds).toBe(3600);
  });

  it("an empty period has no bottleneck and says so", async () => {
    const b = await getBottleneck(viewer, { from: "2026-07-01", to: "2026-07-31" });
    expect(b.bottleneck).toBeNull();
    expect(b.ordersPacked).toBe(0);
    expect(b.lead.seconds).toBeNull();
    expect(b.sentence).toBe("Ingen ordrer er pakket i perioden, så der er ingen flaskehals at pege på.");
    expect(b.steps).toHaveLength(7);
  });
});

describe("getTodayStrip and getKpiSummary", () => {
  it("counts the day in Copenhagen time", async () => {
    // 00:20 on Sunday 1 November: C was packed ten minutes ago, today.
    const t = await getTodayStrip(viewer, { now: local("2026-11-01", "00:20", CET) });
    expect(t.day).toBe("2026-11-01");
    expect(t.ordersPackedToday).toBe(1);
    expect(t.passesToday).toBe(1);
    expect(t.elementsPacked).toBe(1);
    expect(t.ordersInProgress).toBe(0);
    expect(t.stationsTotal).toBe(3);

    const saturday = await getTodayStrip(viewer, { now: local("2026-10-31", "23:45", CET) });
    expect(saturday.day).toBe("2026-10-31");
    expect(saturday.ordersPackedToday).toBe(1);
  });

  it("the summary carries the same numbers as the single functions", async () => {
    const s = await getKpiSummary(viewer, { ...OCTOBER, now: NOW });
    expect(s.kpis).toEqual(await getPeriodKpis(viewer, OCTOBER));
    expect(s.bottleneck).toEqual(await getBottleneck(viewer, OCTOBER));
    expect(s.today.day).toBe("2026-11-16");
    expect(s.ordersToWatch).toEqual([]);
    expect(s.ordersToWatchTotal).toBe(0);
  });
});
