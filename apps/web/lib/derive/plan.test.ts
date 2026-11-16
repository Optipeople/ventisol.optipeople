import { describe, expect, it } from "vitest";
import type { Scan } from "@/lib/scans";
import { at, pass, PACKING, scan } from "@/lib/test-helpers";
import { DEFAULT_CALENDAR } from "./calendar";
import { deriveOrders } from "./order";
import { affectedBy, mergeStationDays, needsClockRefresh, stationDaysTouched } from "./plan";
import { deriveStationDay } from "./station";
import type { StationIntervalRow } from "./types";

const other: Partial<Scan> = { barcode: "058557010101", orderNo: 58557, position: 1, piece: 1 };

describe("affectedBy", () => {
  it("names the orders and the station days of the scans", () => {
    const scans = [...pass(at("07:00"), at("07:10")), ...pass(at("08:00"), at("08:05"), { ...other, ...PACKING })];
    expect(affectedBy(scans)).toEqual({
      orderNos: [58556, 58557],
      stationDays: [
        { stationNo: 1, localDay: "2026-10-21" },
        { stationNo: 7, localDay: "2026-10-21" },
      ],
    });
    expect(affectedBy([])).toEqual({ orderNos: [], stationDays: [] });
  });

  it("goes by scan time, not arrival: a late scan names its old day", () => {
    const late = scan("Out", at("13:30", "2026-10-14"), { durationSec: 600 });
    expect(affectedBy([late]).stationDays).toEqual([{ stationNo: 1, localDay: "2026-10-14" }]);
  });

  it("an Out with a duration names every day back to its start", () => {
    const out = scan("Out", at("07:00"), { durationSec: 42 * 3600 });
    expect(affectedBy([out]).stationDays.map((d) => d.localDay)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
  });

  it("uses the Copenhagen day: 23:30 UTC is already tomorrow", () => {
    const s = scan("In", Date.parse("2026-10-21T23:30:00Z"));
    expect(affectedBy([s]).stationDays[0].localDay).toBe("2026-10-22");
  });
});

describe("stationDaysTouched", () => {
  const row = (over: Partial<StationIntervalRow>): StationIntervalRow =>
    ({ stationNo: 1, status: "done", startAt: new Date(at("07:00")).toISOString(), endAt: new Date(at("07:10")).toISOString(), ...over }) as StationIntervalRow;

  it("covers every day a pass lies on", () => {
    const rows = [
      row({}),
      row({ stationNo: 2, startAt: new Date(at("13:00", "2026-10-19")).toISOString() }),
      row({ stationNo: 3, status: "open", endAt: null, startAt: new Date(at("13:00", "2026-10-20")).toISOString() }),
      row({ stationNo: 4, status: "missing_out", endAt: null, startAt: new Date(at("13:00", "2026-10-10")).toISOString() }),
    ];
    expect(stationDaysTouched(rows, at("09:00"))).toEqual([
      { stationNo: 1, localDay: "2026-10-21" },
      { stationNo: 2, localDay: "2026-10-19" },
      { stationNo: 2, localDay: "2026-10-20" },
      { stationNo: 2, localDay: "2026-10-21" },
      { stationNo: 3, localDay: "2026-10-20" },
      { stationNo: 3, localDay: "2026-10-21" },
      { stationNo: 4, localDay: "2026-10-10" },
    ]);
  });

  it("merges lists without repeats", () => {
    const a = [{ stationNo: 1, localDay: "2026-10-21" }];
    const b = [{ stationNo: 1, localDay: "2026-10-21" }, { stationNo: 1, localDay: "2026-10-20" }];
    expect(mergeStationDays(a, b)).toEqual([
      { stationNo: 1, localDay: "2026-10-20" },
      { stationNo: 1, localDay: "2026-10-21" },
    ]);
  });
});

describe("a late scan, end to end", () => {
  // Monday: an element is scanned in at station 1 and worked on for ten
  // minutes, but the PC is offline and the Out only arrives on Wednesday,
  // with Monday's scan time.
  const monday = "2026-10-19";
  const lateIn = scan("In", at("09:00", monday));
  const lateOut = scan("Out", at("09:10", monday), { durationSec: 600 });
  const now = at("10:00");
  const ctx = { now, calendar: DEFAULT_CALENDAR };

  it("the old day is named, and recomputing it changes its figures", () => {
    const before = deriveOrders([lateIn], [], ctx)[0];
    // More than 36 hours old with no Out: a missing scan-out on Monday.
    expect(before.intervals[0]).toMatchObject({ status: "missing_out", localDay: monday });
    const dayBefore = deriveStationDay(1, monday, before.intervals, ctx);
    expect(dayBefore).toMatchObject({ countThrough: 0, missingScanOutCount: 1 });

    const plan = affectedBy([lateOut]);
    expect(plan.orderNos).toEqual([58556]);
    expect(plan.stationDays).toContainEqual({ stationNo: 1, localDay: monday });

    const after = deriveOrders([lateIn, lateOut], [], ctx)[0];
    expect(after.intervals[0]).toMatchObject({ status: "done", durationSeconds: 600, localDay: monday });
    const days = mergeStationDays(plan.stationDays, stationDaysTouched(before.intervals, now), stationDaysTouched(after.intervals, now));
    expect(days).toEqual([{ stationNo: 1, localDay: monday }]);
    expect(deriveStationDay(1, monday, after.intervals, ctx)).toMatchObject({ countThrough: 1, missingScanOutCount: 0, timePerPieceSeconds: 600 });
  });

  it("a late In that replaces an estimated start frees the days the estimate lay on", () => {
    // The Out came first, with a wrong DurationSec that put the start on Sunday.
    const wrongOut = scan("Out", at("09:10", monday), { durationSec: 30 * 3600 });
    const before = deriveOrders([wrongOut], [], ctx)[0];
    const after = deriveOrders([wrongOut, lateIn], [], ctx)[0];
    expect(after.intervals[0]).toMatchObject({ startEstimated: false, durationSeconds: 600 });
    const days = mergeStationDays(affectedBy([lateIn]).stationDays, stationDaysTouched(before.intervals, now), stationDaysTouched(after.intervals, now));
    // Sunday is only in the old rows: without them it would keep its stale busy time.
    expect(days.map((d) => d.localDay)).toEqual(["2026-10-18", monday]);
    expect(deriveStationDay(1, "2026-10-18", after.intervals, ctx)).toBeNull();
  });
});

describe("needsClockRefresh", () => {
  const order = (status: "in_progress" | "packed", lastScan: number) => ({ status, lastScanAt: new Date(lastScan).toISOString() });

  it("an order in progress moves with the clock, a packed one does not", () => {
    expect(needsClockRefresh(order("in_progress", at("07:00")), at("12:00"))).toBe(true);
    expect(needsClockRefresh(order("packed", at("07:00")), at("12:00"))).toBe(false);
  });

  it("one that has been quiet for two weeks is left alone until a scan arrives", () => {
    expect(needsClockRefresh(order("in_progress", at("07:00", "2026-10-01")), at("12:00"))).toBe(false);
    expect(needsClockRefresh(order("in_progress", at("07:00", "2026-10-01")), at("12:00"), 30)).toBe(true);
  });
});
