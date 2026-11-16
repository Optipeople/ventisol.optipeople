import { describe, expect, it } from "vitest";
import type { Scan } from "@/lib/scans";
import { at, pass, PACKING, scan } from "@/lib/test-helpers";
import { DEFAULT_CALENDAR } from "./calendar";
import { deriveOrders } from "./order";
import { deriveStationDay, median, normalForMix, stationStatus } from "./station";
import type { DeriveContext, OrderInfo, StationDayFactsRow, StationIntervalRow, WorkCalendar } from "./types";

const MIN = 60;
const H = 3600;
const DAY = "2026-10-21"; // a Wednesday, shift 06:00 to 14:00
const iso = (ms: number) => new Date(ms).toISOString();

const el = (piece: number, position = 5): Partial<Scan> => ({
  barcode: `058556${String(position).padStart(2, "0")}01${String(piece).padStart(2, "0")}`,
  position,
  piece,
});

function rows(scans: Scan[], now: number, infos: OrderInfo[] = []): StationIntervalRow[] {
  return deriveOrders(scans, infos, { now, calendar: DEFAULT_CALENDAR }).flatMap((d) => d.intervals);
}

function facts(scans: Scan[], now: number, over: Partial<DeriveContext> = {}, day = DAY, stationNo = 1) {
  const ctx = { now, calendar: DEFAULT_CALENDAR, ...over };
  return deriveStationDay(stationNo, day, rows(scans, now), ctx);
}

// 07:00 to 07:10, 07:12 to 07:20, 08:00 to 08:30 at station 1.
const morning = () => [
  ...pass(at("07:00"), at("07:10"), el(1)),
  ...pass(at("07:12"), at("07:20"), el(2)),
  ...pass(at("08:00"), at("08:30"), el(3)),
];

describe("deriveStationDay", () => {
  it("counts, times and gaps for a day in progress", () => {
    const f = facts(morning(), at("10:00")) as StationDayFactsRow;
    expect(f).toMatchObject({
      stationNo: 1,
      localDay: DAY,
      station: "Station 10",
      stationKind: "assembly",
      countThrough: 3,
      elementsThrough: 3,
      reworkPasses: 0,
      openCount: 0,
      timePerPieceSeconds: 10 * MIN, // median of 8, 10 and 30 minutes
      meanPieceSeconds: 16 * MIN,
      passSecondsTotal: 48 * MIN,
      availableSeconds: 8 * H,
      observedSeconds: 4 * H, // 06:00 to 10:00
      busySeconds: 48 * MIN,
      busyInShiftSeconds: 48 * MIN,
      idleSeconds: (2 + 40 + 90) * MIN, // from the first scan on; the hour before it is not idle
      longestGapSeconds: 90 * MIN,
      firstScanAt: iso(at("07:00")),
      lastScanAt: iso(at("08:30")),
      isComplete: false,
    });
    // The two-minute gap is under the floor: counted as idle, not stored.
    expect(f.gaps).toEqual([
      { startAt: iso(at("07:20")), endAt: iso(at("08:00")), seconds: 40 * MIN },
      { startAt: iso(at("08:30")), endAt: iso(at("10:00")), seconds: 90 * MIN },
    ]);
  });

  it("once the day is over the last gap runs to the end of the shift", () => {
    const f = facts(morning(), at("09:00", "2026-10-22")) as StationDayFactsRow;
    expect(f).toMatchObject({ isComplete: true, observedSeconds: 8 * H, longestGapSeconds: 5.5 * H });
    expect(f.gaps[1]).toEqual({ startAt: iso(at("08:30")), endAt: iso(at("14:00")), seconds: 5.5 * H });
  });

  it("the standstill window is a parameter", () => {
    const now = at("09:00", "2026-10-22");
    const strict = facts(morning(), now, { params: { standstillCountAfterLastScan: false } }) as StationDayFactsRow;
    expect(strict.gaps.map((g) => g.seconds)).toEqual([40 * MIN]);
    const whole = facts(morning(), now, { params: { standstillCountBeforeFirstScan: true } }) as StationDayFactsRow;
    expect(whole.gaps.map((g) => g.seconds)).toEqual([60 * MIN, 40 * MIN, 5.5 * H]);
    const fine = facts(morning(), now, { params: { gapFloorSeconds: 60 } }) as StationDayFactsRow;
    expect(fine.gaps.map((g) => g.seconds)).toEqual([2 * MIN, 40 * MIN, 5.5 * H]);
  });

  it("only shift time can be a standstill: a break modelled as two blocks is not one", () => {
    const withBreak: WorkCalendar = {
      shifts: { 3: [{ start: "06:00", end: "07:20" }, { start: "08:00", end: "14:00" }] },
      closedDays: [],
    };
    const f = facts(morning(), at("09:00", "2026-10-22"), { calendar: withBreak }) as StationDayFactsRow;
    expect(f.gaps.map((g) => g.seconds)).toEqual([5.5 * H]);
    expect(f.availableSeconds).toBe(7 * H + 20 * MIN);
  });

  it("work outside the shift is busy time but not in-shift time, and makes no gaps", () => {
    const f = facts(pass(at("15:00"), at("15:30"), el(1)), at("09:00", "2026-10-22")) as StationDayFactsRow;
    expect(f).toMatchObject({ countThrough: 1, busySeconds: 30 * MIN, busyInShiftSeconds: 0, idleSeconds: 0, gaps: [] });
  });

  it("a closed day has no available time and no standstill", () => {
    const saturday = "2026-10-24";
    const f = facts(pass(at("08:00", saturday), at("08:30", saturday), el(1)), at("12:00", "2026-10-26"), {}, saturday) as StationDayFactsRow;
    expect(f).toMatchObject({ countThrough: 1, availableSeconds: 0, observedSeconds: 0, idleSeconds: 0, gaps: [] });
  });

  it("a pass over midnight counts on the day it ends, and is busy time on both days", () => {
    const scans = pass(at("13:00", "2026-10-20"), at("07:10"), el(1));
    const now = at("09:00", "2026-10-22");
    const today = facts(scans, now) as StationDayFactsRow;
    expect(today).toMatchObject({
      countThrough: 1,
      timePerPieceSeconds: 18 * H + 10 * MIN,
      timePerPieceWorkingSeconds: 2 * H + 10 * MIN,
      busySeconds: 7 * H + 10 * MIN, // midnight to 07:10
      busyInShiftSeconds: 70 * MIN,
      firstScanAt: iso(at("07:10")),
    });
    // The element was on the station when the shift began, so the day is watched from its start.
    expect(today.gaps).toEqual([{ startAt: iso(at("07:10")), endAt: iso(at("14:00")), seconds: 6 * H + 50 * MIN }]);

    const yesterday = facts(scans, now, {}, "2026-10-20") as StationDayFactsRow;
    expect(yesterday).toMatchObject({
      countThrough: 0,
      timePerPieceSeconds: null,
      busySeconds: 11 * H,
      busyInShiftSeconds: 1 * H,
      gaps: [],
      firstScanAt: iso(at("13:00", "2026-10-20")),
    });
  });

  it("an element on the station now is busy up to now and no standstill", () => {
    const f = facts([...pass(at("07:00"), at("07:10"), el(1)), scan("In", at("07:15"), el(2))], at("09:00")) as StationDayFactsRow;
    expect(f).toMatchObject({ countThrough: 1, openCount: 1, busySeconds: 115 * MIN, longestGapSeconds: 5 * MIN });
    expect(f.gaps).toEqual([{ startAt: iso(at("07:10")), endAt: iso(at("07:15")), seconds: 5 * MIN }]);
  });

  it("a missing scan-out is counted as such and nothing else", () => {
    const f = facts([scan("In", at("07:00"), el(1))], at("12:00", "2026-10-25")) as StationDayFactsRow;
    expect(f).toMatchObject({ countThrough: 0, missingScanOutCount: 1, busySeconds: 0, timePerPieceSeconds: null, lastScanAt: iso(at("07:00")) });
  });

  it("takes only its own station, and gives null for a day with nothing", () => {
    const scans = [...morning(), ...pass(at("09:00"), at("09:05"), { ...el(1), ...PACKING })];
    expect(facts(scans, at("12:00"))?.countThrough).toBe(3);
    expect(facts(scans, at("12:00"), {}, DAY, 7)).toMatchObject({ countThrough: 1, stationKind: "packing", station: "Pakning" });
    expect(facts(scans, at("12:00"), {}, "2026-10-20")).toBeNull();
    expect(facts(scans, at("12:00"), {}, DAY, 3)).toBeNull();
  });

  it("counts rework passes and splits by element type", () => {
    const info: OrderInfo = {
      orderNo: 58556,
      deliveryWeek: null,
      expectedElements: [
        { position: 5, quantity: 2, elementTypeId: "vindue_1_fag" },
        { position: 6, quantity: 1, elementTypeId: "dør" },
      ],
    };
    const scans = [
      ...pass(at("07:00"), at("07:10"), el(1)),
      ...pass(at("07:10"), at("07:30"), el(2)),
      ...pass(at("07:30"), at("08:00"), el(1, 6)),
      ...pass(at("08:00"), at("08:04"), el(1)),
    ];
    const now = at("12:00");
    const f = deriveStationDay(1, DAY, rows(scans, now, [info]), { now, calendar: DEFAULT_CALENDAR }) as StationDayFactsRow;
    expect(f).toMatchObject({ countThrough: 4, elementsThrough: 3, reworkPasses: 1 });
    expect(f.byElementType).toEqual([
      { elementTypeId: "dør", count: 1, medianSeconds: 30 * MIN, meanSeconds: 30 * MIN },
      { elementTypeId: "vindue_1_fag", count: 3, medianSeconds: 10 * MIN, meanSeconds: 680 },
    ]);
    expect(normalForMix(f.byElementType, { vindue_1_fag: 600, dør: 1800 })).toBe(900);
    expect(normalForMix(f.byElementType, { dør: 1800 })).toBe(1800);
    expect(normalForMix(f.byElementType, { dør: 1800 }, 600)).toBe(900);
    expect(normalForMix(f.byElementType, {})).toBeNull();
  });

  it("knows the longest wait before the station", () => {
    const scans = [
      ...pass(at("13:00", "2026-10-20"), at("13:30", "2026-10-20"), el(1)),
      ...pass(at("07:00"), at("07:10"), { ...el(1), station: "Station 20", stationNo: 2 }),
    ];
    const f = facts(scans, at("12:00"), {}, DAY, 2) as StationDayFactsRow;
    expect(f).toMatchObject({ longestWaitBeforeSeconds: 17.5 * H, longestWaitBeforeWorkingSeconds: 1.5 * H });
  });

  it("median is the middle value", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 100, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3); // 2.5 rounded
  });
});

describe("stationStatus", () => {
  const base = { timePerPieceSeconds: 600, timePerPieceWorkingSeconds: 600, gaps: [], longestWaitBeforeSeconds: null, longestWaitBeforeWorkingSeconds: null };
  const gap = (seconds: number) => ({ startAt: "", endAt: "", seconds });

  it("Normal, with the deviation from normal", () => {
    expect(stationStatus(base, 600)).toMatchObject({ status: "normal", label: "Normal", deviationPercent: 0, standstillSeconds: 0 });
    expect(stationStatus({ ...base, timePerPieceSeconds: 560, timePerPieceWorkingSeconds: 560 }, 600).deviationPercent).toBe(-7);
    expect(stationStatus(base, null)).toMatchObject({ status: "normal", deviationPercent: null, normalSeconds: null });
  });

  it("Langsommere over the slow threshold", () => {
    const slow = { ...base, timePerPieceSeconds: 750, timePerPieceWorkingSeconds: 750 };
    expect(stationStatus(slow, 600)).toMatchObject({ status: "slower", label: "Langsommere", deviationPercent: 25 });
    expect(stationStatus(slow, 600, { slowPercent: 30 }).status).toBe("normal");
  });

  it("Stod stille sums the gaps over the threshold, and wins over the rest", () => {
    const f = { ...base, timePerPieceSeconds: 750, timePerPieceWorkingSeconds: 750, gaps: [gap(10 * MIN), gap(20 * MIN), gap(40 * MIN)] };
    expect(stationStatus(f, 600)).toMatchObject({ status: "stood_still", label: "Stod stille", standstillSeconds: 60 * MIN, deviationPercent: 25 });
    expect(stationStatus(f, 600, { standstillMinGapSeconds: 30 * MIN }).standstillSeconds).toBe(40 * MIN);
    expect(stationStatus(f, 600, { standstillMinGapSeconds: 2 * H })).toMatchObject({ status: "slower", standstillSeconds: 0 });
  });

  it("Lang liggetid when an element waited too long before the station", () => {
    const f = { ...base, longestWaitBeforeSeconds: 20 * H, longestWaitBeforeWorkingSeconds: 4 * H };
    expect(stationStatus(f, 600).status).toBe("normal"); // 4 shift hours, under one shift
    expect(stationStatus(f, 600, { useWorkingTime: false })).toMatchObject({ status: "long_dwell", label: "Lang liggetid" });
    expect(stationStatus({ ...f, longestWaitBeforeWorkingSeconds: 9 * H }, 600).status).toBe("long_dwell");
  });

  it("no facts: no data yet, never zero", () => {
    expect(stationStatus(null, 270)).toMatchObject({ status: "no_data", label: "Ingen data endnu", timePerPieceSeconds: null, deviationPercent: null });
  });

  it("reads the wall clock or the shift clock by the setting", () => {
    const f = { ...base, timePerPieceSeconds: 18 * H, timePerPieceWorkingSeconds: 2 * H };
    expect(stationStatus(f, 2 * H).deviationPercent).toBe(0);
    expect(stationStatus(f, 2 * H, { useWorkingTime: false }).deviationPercent).toBe(800);
  });
});
