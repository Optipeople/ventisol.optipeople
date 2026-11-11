import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadResult } from "@/lib/paging";
import type { Scan } from "@/lib/scans";

// What each page loads: where its read starts, which day a pass lands on,
// passes that span midnight, and a read that could not get everything.
// The read itself is replaced by a list of scans handed in by the test.

let scans: Scan[] = [];
let truncated = false;
const reads: { since: number; ttl: number }[] = [];

vi.mock("@/lib/opticloud", () => ({
  CACHE_SECONDS: { today: 30, past: 300, tables: 300 },
  loadScansSince: async (_ctx: unknown, since: number, ttl: number): Promise<ReadResult> => {
    reads.push({ since, ttl });
    return { scans: scans.filter((s) => s.time >= since), pagesRead: 1, unordered: false, truncated };
  },
}));

const {
  earliestDay,
  loadDayReport,
  loadOrderReport,
  loadPeriodReport,
  MAX_LOOKBACK_DAYS,
  MAX_PERIOD_DAYS,
  ORDER_LOOKBACK_DAYS,
  parseDayParam,
  parsePeriodParams,
} = await import("@/lib/views");
const { STALE_OPEN_MS } = await import("@/lib/report");
const { at, PACKING, pass, scan } = await import("@/lib/test-helpers");
const { addDays, dayStart, daysBetween } = await import("@/lib/time");

const ctx = { user: { id: "u1" } as never, token: "t", accountId: "acc", currentPath: "/" };
const TODAY = "2026-10-21";
const YESTERDAY = "2026-10-20";
const NOW = at("12:00");
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  scans = [];
  truncated = false;
  reads.length = 0;
});

describe("the days a page may be asked for", () => {
  it("reads back 62 days, the period view's longest period", () => {
    expect(MAX_LOOKBACK_DAYS).toBe(62);
    expect(MAX_PERIOD_DAYS).toBe(MAX_LOOKBACK_DAYS);
    expect(earliestDay(TODAY)).toBe("2026-08-21");
    expect(daysBetween(earliestDay(TODAY), TODAY) + 1).toBe(MAX_LOOKBACK_DAYS);
  });

  describe("parseDayParam", () => {
    it("is today when nothing, or nonsense, is asked for", () => {
      expect(parseDayParam(undefined, TODAY)).toEqual({ day: TODAY, clamped: false });
      expect(parseDayParam("", TODAY)).toEqual({ day: TODAY, clamped: false });
      expect(parseDayParam("i går", TODAY)).toEqual({ day: TODAY, clamped: false });
      expect(parseDayParam("2026-02-30", TODAY)).toEqual({ day: TODAY, clamped: false });
    });
    it("keeps a day inside the lookback", () => {
      expect(parseDayParam("2026-10-01", TODAY)).toEqual({ day: "2026-10-01", clamped: false });
      expect(parseDayParam("2026-08-21", TODAY)).toEqual({ day: "2026-08-21", clamped: false });
    });
    it("moves a day in the future to today", () => {
      expect(parseDayParam("2026-10-22", TODAY)).toEqual({ day: TODAY, clamped: true });
    });
    it("moves a day before the lookback to the earliest day", () => {
      expect(parseDayParam("2026-08-20", TODAY)).toEqual({ day: "2026-08-21", clamped: true });
      expect(parseDayParam("2019-01-01", TODAY)).toEqual({ day: "2026-08-21", clamped: true });
    });
  });

  describe("parsePeriodParams", () => {
    it("defaults to this week so far, most time first", () => {
      expect(parsePeriodParams({}, TODAY)).toEqual({
        from: "2026-10-19",
        to: TODAY,
        sort: "total",
        dir: "desc",
        clamped: false,
      });
    });
    it("takes a period, a sort column and a direction", () => {
      expect(
        parsePeriodParams({ fra: "2026-10-01", til: "2026-10-14", sort: "order", retning: "asc" }, TODAY)
      ).toEqual({ from: "2026-10-01", to: "2026-10-14", sort: "order", dir: "asc", clamped: false });
    });
    it("falls back on an unknown sort column or direction", () => {
      expect(parsePeriodParams({ sort: "price", retning: "sideways" }, TODAY)).toMatchObject({
        sort: "total",
        dir: "desc",
      });
    });
    it("swaps days that come in the wrong order", () => {
      expect(parsePeriodParams({ fra: "2026-10-14", til: "2026-10-01" }, TODAY)).toMatchObject({
        from: "2026-10-01",
        to: "2026-10-14",
        clamped: false,
      });
    });
    it("moves a `til` in the future to today", () => {
      expect(parsePeriodParams({ fra: "2026-10-01", til: "2026-12-24" }, TODAY)).toMatchObject({
        from: "2026-10-01",
        to: TODAY,
        clamped: true,
      });
    });
    it("moves a `fra` in the future to today too, so the period is never in the future", () => {
      expect(parsePeriodParams({ fra: "2026-11-01", til: "2026-11-30" }, TODAY)).toMatchObject({
        from: TODAY,
        to: TODAY,
        clamped: true,
      });
      expect(parsePeriodParams({ fra: "2026-11-01" }, TODAY)).toMatchObject({ from: TODAY, to: TODAY, clamped: true });
    });
    it("moves days before the lookback to the earliest day", () => {
      const p = parsePeriodParams({ fra: "2025-01-01", til: "2026-10-10" }, TODAY);
      expect(p).toMatchObject({ from: "2026-08-21", to: "2026-10-10", clamped: true });
      expect(parsePeriodParams({ fra: "2020-01-01", til: "2020-02-01" }, TODAY)).toMatchObject({
        from: "2026-08-21",
        to: "2026-08-21",
        clamped: true,
      });
    });
    it("never gives a period longer than the longest period", () => {
      const p = parsePeriodParams({ fra: "2000-01-01", til: "2999-01-01" }, TODAY);
      expect(daysBetween(p.from, p.to) + 1).toBe(MAX_PERIOD_DAYS);
    });
    it("ignores days that are not days", () => {
      expect(parsePeriodParams({ fra: "01-10-2026", til: "x" }, TODAY)).toMatchObject({
        from: "2026-10-19",
        to: TODAY,
        clamped: false,
      });
    });
  });
});

describe("loadDayReport", () => {
  it("reads from 36 hours before the day, with the short TTL for today", async () => {
    await loadDayReport(ctx, TODAY, NOW);
    expect(reads).toEqual([{ since: dayStart(TODAY) - STALE_OPEN_MS, ttl: 30 }]);
  });

  it("reads a past day with the long TTL", async () => {
    const report = await loadDayReport(ctx, YESTERDAY, NOW);
    expect(reads).toEqual([{ since: dayStart(YESTERDAY) - STALE_OPEN_MS, ttl: 300 }]);
    expect(report.isToday).toBe(false);
  });

  it("puts a pass on the day it ended", async () => {
    scans = [
      ...pass(at("09:00", YESTERDAY), at("09:10", YESTERDAY), { barcode: "058556050101" }),
      ...pass(at("08:00"), at("08:20"), { barcode: "058556050102" }),
    ];
    const today = await loadDayReport(ctx, TODAY, NOW);
    expect(today.intervals.map((iv) => iv.barcode)).toEqual(["058556050102"]);
    expect(today.kpis.totalWorkedMs).toBe(20 * MIN);
    const yesterday = await loadDayReport(ctx, YESTERDAY, NOW);
    expect(yesterday.intervals.map((iv) => iv.barcode)).toEqual(["058556050101"]);
    expect(yesterday.kpis.totalWorkedMs).toBe(10 * MIN);
  });

  it("counts a pass left overnight on the morning it ended, with its In from the day before", async () => {
    scans = pass(at("15:00", YESTERDAY), at("07:00"));
    const today = await loadDayReport(ctx, TODAY, NOW);
    expect(today.intervals).toHaveLength(1);
    expect(today.intervals[0].startEstimated).toBe(false);
    expect(today.kpis.totalWorkedMs).toBe(16 * HOUR);
    expect(today.orders[0].elements).toBe(1);
    // Yesterday has the In scan but no finished pass: the order shows, with no time.
    const yesterday = await loadDayReport(ctx, YESTERDAY, NOW);
    expect(yesterday.intervals).toEqual([]);
    expect(yesterday.orders).toHaveLength(1);
    expect(yesterday.orders[0]).toMatchObject({ totalMs: 0, elements: 0 });
    expect(yesterday.kpis).toMatchObject({ elements: 0, totalWorkedMs: 0 });
  });

  it("does not let an overnight pass stretch the day or fill it with yesterday's hours", async () => {
    scans = [
      // Left on station 1 at 15:00 yesterday, finished 07:00 today.
      ...pass(at("15:00", YESTERDAY), at("07:00")),
      // Station 2 works 07:00 to 09:00 today.
      ...pass(at("07:00"), at("09:00"), { barcode: "058556050102", station: "Station 20", stationNo: 2 }),
    ];
    const report = await loadDayReport(ctx, TODAY, NOW);
    const [one, two] = report.stations;
    // The day runs from its first scan (07:00) to now: 5 hours. Station 1 only
    // scanned out at 07:00, so the night is not work today; station 2 has two hours.
    expect(one.utilisation).toBe(0);
    expect(two.utilisation).toBeCloseTo(2 / 5, 10);
    // The pass still counts whole for the day it ended.
    expect(one.busyMs).toBe(16 * HOUR);
  });

  it("shows an element in progress on today only, counted up to now", async () => {
    scans = [scan("In", at("22:00", YESTERDAY))];
    const today = await loadDayReport(ctx, TODAY, NOW);
    expect(today.kpis.inProgress).toBe(1);
    expect(today.kpis.totalWorkedMs).toBe(14 * HOUR);
    expect(today.orders[0].status).toBe("active");
    const yesterday = await loadDayReport(ctx, YESTERDAY, NOW);
    expect(yesterday.kpis.inProgress).toBe(0);
    expect(yesterday.intervals).toEqual([]);
  });

  it("ends a past day's span at its last scan, not at now", async () => {
    scans = [
      ...pass(at("08:00", YESTERDAY), at("09:00", YESTERDAY)),
      ...pass(at("09:00", YESTERDAY), at("12:00", YESTERDAY), {
        barcode: "058556050102",
        station: "Station 20",
        stationNo: 2,
      }),
    ];
    const report = await loadDayReport(ctx, YESTERDAY, NOW);
    expect(report.stations.map((s) => s.utilisation)).toEqual([0.25, 0.75]);
  });

  it("says the read was incomplete instead of reporting an empty day", async () => {
    truncated = true;
    const report = await loadDayReport(ctx, "2026-09-01", NOW);
    expect(report.orders).toEqual([]);
    expect(report.incomplete).toBe(true);
  });

  it("is not incomplete when the read got everything", async () => {
    const report = await loadDayReport(ctx, TODAY, NOW);
    expect(report.incomplete).toBe(false);
  });
});

describe("loadPeriodReport", () => {
  it("reads from 36 hours before the first day", async () => {
    await loadPeriodReport(ctx, "2026-10-19", TODAY, NOW);
    expect(reads).toEqual([{ since: dayStart("2026-10-19") - STALE_OPEN_MS, ttl: 30 }]);
  });

  it("uses the long TTL only when the period ended before today", async () => {
    await loadPeriodReport(ctx, "2026-10-12", "2026-10-18", NOW);
    expect(reads[0].ttl).toBe(300);
  });

  it("counts the passes that ended in the period, not the ones that started in it", async () => {
    scans = [
      // Started before the period, ended in it: counts.
      ...pass(at("16:00", "2026-10-18"), at("07:00", "2026-10-19"), { barcode: "058556050101" }),
      // Started in the period, ended after it: does not count.
      ...pass(at("16:00", "2026-10-19"), at("07:00", "2026-10-20"), { barcode: "058556050102" }),
    ];
    const report = await loadPeriodReport(ctx, "2026-10-19", "2026-10-19", NOW);
    expect(report.kpis.elements).toBe(1);
    expect(report.kpis.totalWorkedMs).toBe(15 * HOUR);
    expect(report.orders[0].elements).toBe(1);
  });

  it("says when the read was incomplete", async () => {
    truncated = true;
    expect((await loadPeriodReport(ctx, "2026-08-21", TODAY, NOW)).incomplete).toBe(true);
  });
});

describe("loadOrderReport", () => {
  it("reads the lookback from a day start, so the read begins at the same place all day", async () => {
    await loadOrderReport(ctx, 58556, NOW);
    await loadOrderReport(ctx, 58556, NOW + 3 * HOUR);
    const since = dayStart(addDays(TODAY, -ORDER_LOOKBACK_DAYS));
    expect(reads.map((r) => r.since)).toEqual([since, since]);
  });

  it("keeps only the order's scans", async () => {
    scans = [
      ...pass(at("08:00"), at("08:10")),
      ...pass(at("08:00"), at("08:30"), { barcode: "058557010101", orderNo: 58557, ...PACKING }),
    ];
    const report = await loadOrderReport(ctx, 58556, NOW);
    expect(report.summary).toMatchObject({ orderNo: 58556, totalMs: 10 * MIN, elements: 1 });
    expect(report.elements).toHaveLength(1);
    expect(report.stations.map((s) => s.station)).toEqual(["Station 10"]);
  });

  it("has no summary for an order with no scans", async () => {
    const report = await loadOrderReport(ctx, 12345, NOW);
    expect(report.summary).toBeNull();
    expect(report.incomplete).toBe(false);
  });

  it("puts an overnight pass on the day it ended, in the days worked and on the timeline", async () => {
    scans = pass(at("15:00", YESTERDAY), at("07:00"));
    const report = await loadOrderReport(ctx, 58556, NOW);
    expect(report.summary?.days).toEqual([TODAY]);
    expect(report.timeline.map((d) => d.day)).toEqual([TODAY]);
  });

  it("says when the read was incomplete", async () => {
    truncated = true;
    expect((await loadOrderReport(ctx, 58556, NOW)).incomplete).toBe(true);
  });
});
