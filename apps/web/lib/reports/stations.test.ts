// Stationer: the day table, the period table and the drill-down, on the
// October scenario (figures in overview.test.ts).
//
// Wednesday 21/10: Station 10 has one pass 07:00-07:30, Pakning one 08:30-08:40.
// October at Station 10: passes of 1800 (A), 1800 (D), 3600 (B) and 1200 (C).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { getStationDay, getStationDetail, getStationPerformance, listStations } from "./index";
import { seedConfig, seedOctober } from "./test-support";

const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const NULL_DURATION = { seconds: null, wallSeconds: null, workingSeconds: null };

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

describe("listStations", () => {
  it("lists the stations in their order with labels and normal times", async () => {
    const stations = await listStations(viewer);
    expect(stations.map((s) => [s.stationNo, s.name, s.kindLabel])).toEqual([
      [1, "Station 10", "Montage"],
      [2, "Station 20", "Montage"],
      [7, "Pakning", "Pakning"],
    ]);
    expect(stations[0].normalTimes).toEqual([{ elementTypeId: "vindue_1_fag", seconds: 1500 }]);
    expect(stations[1].normalTimes).toEqual([]);
    expect(stations.map((s) => s.maxOpen)).toEqual([1, 1, 1]);
  });
});

describe("getStationDay", () => {
  it("one row per station with count, time per piece, normal time and standstill", async () => {
    const day = await getStationDay(viewer, { day: "2026-10-21" });
    expect(day.clock).toBe("working");
    expect(day.rows.map((r) => r.stationNo)).toEqual([1, 2, 7]);

    // 1800 against 1500 is +20 %. The station stood still from 07:30 to 14:00: 23400 s.
    // 1800 of the 28800 s of the shift is 6 %.
    expect(day.rows[0]).toMatchObject({
      name: "Station 10",
      hasData: true,
      countThrough: 1,
      timePerPiece: { seconds: 1800, wallSeconds: 1800, workingSeconds: 1800 },
      normalSeconds: 1500,
      deviationPercent: 20,
      standstillSeconds: 23400,
      utilisationPercent: 6,
      availableSeconds: 28800,
      status: "stood_still",
      statusLabel: "Stod stille",
      isComplete: true,
    });
    // Pakning: 600 against 600; waited an hour for its element; 08:40 to 14:00 is 19200 s.
    expect(day.rows[2]).toMatchObject({
      countThrough: 1,
      timePerPiece: { seconds: 600 },
      normalSeconds: 600,
      deviationPercent: 0,
      standstillSeconds: 19200,
      longestWaitBeforeSeconds: 3600,
      utilisationPercent: 2,
    });
    expect(day.attention).toEqual({
      count: 2,
      stationNos: [1, 7],
      names: ["Station 10", "Pakning"],
      sentence: "2 stationer afviger fra det normale: Station 10 og Pakning",
    });
  });

  it("a station without scans is a row that says so, with nulls", async () => {
    const day = await getStationDay(viewer, { day: "2026-10-21" });
    expect(day.rows[1]).toMatchObject({
      stationNo: 2,
      name: "Station 20",
      configured: true,
      hasData: false,
      countThrough: null,
      timePerPiece: NULL_DURATION,
      normalSeconds: null,
      deviationPercent: null,
      standstillSeconds: null,
      utilisationPercent: null,
      status: "no_data",
      statusLabel: "Ingen data endnu",
      daysActive: 0,
    });
  });

  it("a day without any scans has only such rows and nothing to look at", async () => {
    const day = await getStationDay(viewer, { day: "2026-07-01" });
    expect(day.rows.map((r) => [r.stationNo, r.hasData, r.status])).toEqual([
      [1, false, "no_data"],
      [2, false, "no_data"],
      [7, false, "no_data"],
    ]);
    expect(day.attention.count).toBe(0);
  });

  it("the day is the Copenhagen day: Saturday 23:20 is the 31st, Sunday 00:05 the 1st", async () => {
    const saturday = await getStationDay(viewer, { day: "2026-10-31" });
    expect(saturday.rows.find((r) => r.stationNo === 7)?.countThrough).toBe(1);
    const sunday = await getStationDay(viewer, { day: "2026-11-01" });
    expect(sunday.rows.find((r) => r.stationNo === 7)?.countThrough).toBe(1);
  });
});

describe("getStationPerformance", () => {
  it("a period: count, median and mean over the passes that ended in it", async () => {
    const period = await getStationPerformance(viewer, OCTOBER);
    expect(period.period).toEqual(OCTOBER);
    // Median of 1200, 1800, 1800, 3600 is 1800, the mean 2100.
    expect(period.rows[0]).toMatchObject({
      stationNo: 1,
      countThrough: 4,
      timePerPiece: { seconds: 1800, wallSeconds: 1800 },
      meanPieceSeconds: 2100,
      normalSeconds: 1500,
      deviationPercent: 20,
      daysActive: 3,
    });
    // Pakning in October: 600 (A), 1800 (D), 600 (B). C was packed on 1 November.
    expect(period.rows[2]).toMatchObject({
      stationNo: 7,
      countThrough: 3,
      timePerPiece: { wallSeconds: 600 },
      meanPieceSeconds: 1000,
      avgWaitBefore: { seconds: 3600, wallSeconds: 121600, workingSeconds: 3600 },
    });
    expect(period.rows[1]).toMatchObject({ stationNo: 2, hasData: false, status: "no_data" });
  });

  it("one station, and an empty period", async () => {
    const one = await getStationPerformance(viewer, { ...OCTOBER, stationNo: 7 });
    expect(one.rows.map((r) => r.stationNo)).toEqual([7]);
    const empty = await getStationPerformance(viewer, { from: "2026-07-01", to: "2026-07-31" });
    expect(empty.rows.every((r) => !r.hasData && r.countThrough === null)).toBe(true);
    await expect(getStationPerformance(viewer, { from: "2026-10-31", to: "2026-10-01" })).rejects.toThrow();
  });
});

describe("getStationDetail", () => {
  it("the day's passes, the distribution per element type and the weekly trend", async () => {
    const d = await getStationDetail(viewer, { stationNo: 1, day: "2026-10-21", weeks: 4 });
    expect(d.station).toMatchObject({ stationNo: 1, countThrough: 1, deviationPercent: 20 });
    expect(d.timeline).toHaveLength(1);
    expect(d.timeline[0]).toMatchObject({
      orderNo: 50001,
      elementTypeName: "Vindue 1 fag",
      status: "done",
      startAt: "2026-10-21T05:00:00.000Z",
      endAt: "2026-10-21T05:30:00.000Z",
      duration: { seconds: 1800, wallSeconds: 1800, workingSeconds: 1800 },
    });
    // Four weeks ending with week 43: 28 September to 25 October. A and D are in.
    expect(d.distributionPeriod).toEqual({ from: "2026-09-28", to: "2026-10-25" });
    expect(d.distribution).toHaveLength(1);
    expect(d.distribution[0]).toMatchObject({
      elementTypeId: "vindue_1_fag",
      passes: 2,
      medianSeconds: 1800,
      normalSeconds: 1500,
      deviationPercent: 20,
    });
    expect(d.trend.map((t) => [t.weekStart, t.isoWeek, t.countThrough])).toEqual([
      ["2026-09-28", 40, null],
      ["2026-10-05", 41, null],
      ["2026-10-12", 42, null],
      ["2026-10-19", 43, 2],
    ]);
    expect(d.trend[3].timePerPiece.seconds).toBe(1800);
    expect(d.trend[0].timePerPiece).toEqual(NULL_DURATION);
  });

  it("a station that is not configured is a placeholder without data", async () => {
    const d = await getStationDetail(viewer, { stationNo: 99, day: "2026-10-21", weeks: 2 });
    expect(d.station).toMatchObject({
      stationNo: 99,
      name: "Station nr. 99",
      configured: false,
      hasData: false,
      status: "no_data",
    });
    expect(d.timeline).toEqual([]);
    expect(d.distribution).toEqual([]);
    expect(d.trend.map((t) => t.countThrough)).toEqual([null, null]);
  });
});
