import { describe, expect, it } from "vitest";
import type { StationTrendPoint, TimelineInterval } from "@/lib/reports/types";
import { dayEnd, dayStart } from "@/lib/time";
import {
  hrefWith,
  parseClock,
  parseDay,
  parsePeriod,
  parseStationNo,
  parseView,
  periodPresets,
  stationHref,
} from "./params";
import { buildStationTimeline, trendScaleMax } from "./timeline";

const TODAY = "2026-11-13"; // a Friday

describe("parseView", () => {
  it("is the day view by default", () => {
    expect(parseView({})).toBe("day");
  });
  it("follows view=", () => {
    expect(parseView({ view: "period" })).toBe("period");
    expect(parseView({ view: "day", from: "2026-11-01" })).toBe("day");
  });
  it("opens the period view for a link from Overblik with from and to", () => {
    expect(parseView({ from: "2026-11-01", to: "2026-11-13" })).toBe("period");
    expect(parseView({ day: "2026-11-12", from: "2026-11-01" })).toBe("day");
  });
});

describe("parseClock", () => {
  it("knows working and wall, nothing else", () => {
    expect(parseClock("working")).toBe("working");
    expect(parseClock("wall")).toBe("wall");
    expect(parseClock("arbejdstid")).toBeUndefined();
    expect(parseClock(undefined)).toBeUndefined();
  });
});

describe("parseDay", () => {
  it("is today without a valid day", () => {
    expect(parseDay(undefined, TODAY)).toEqual({ day: TODAY, clamped: false });
    expect(parseDay("2026-02-30", TODAY)).toEqual({ day: TODAY, clamped: false });
  });
  it("keeps a past day and moves a future one", () => {
    expect(parseDay("2026-10-01", TODAY)).toEqual({ day: "2026-10-01", clamped: false });
    expect(parseDay("2026-11-20", TODAY)).toEqual({ day: TODAY, clamped: true });
  });
});

describe("parsePeriod", () => {
  it("defaults to this week so far", () => {
    expect(parsePeriod(undefined, undefined, TODAY)).toEqual({ from: "2026-11-09", to: TODAY, clamped: false });
  });
  it("swaps reversed days", () => {
    expect(parsePeriod("2026-11-10", "2026-11-02", TODAY)).toMatchObject({ from: "2026-11-02", to: "2026-11-10" });
  });
  it("ends no later than today", () => {
    expect(parsePeriod("2026-11-01", "2026-12-01", TODAY)).toEqual({ from: "2026-11-01", to: TODAY, clamped: true });
  });
  it("caps the span at a year, keeping the end", () => {
    const p = parsePeriod("2020-01-01", "2026-11-13", TODAY);
    expect(p).toMatchObject({ from: "2025-11-13", to: TODAY, clamped: true });
  });
});

describe("periodPresets", () => {
  it("gives this week, last week, 4 weeks and the months", () => {
    expect(periodPresets(TODAY)).toEqual([
      { label: "Denne uge", from: "2026-11-09", to: TODAY },
      { label: "Sidste uge", from: "2026-11-02", to: "2026-11-08" },
      { label: "Seneste 4 uger", from: "2026-10-19", to: TODAY },
      { label: "Denne måned", from: "2026-11-01", to: TODAY },
      { label: "Sidste måned", from: "2026-10-01", to: "2026-10-31" },
    ]);
  });
});

describe("hrefs", () => {
  it("leaves out empty params", () => {
    expect(hrefWith("/stationer", { day: undefined, clock: "wall", view: "" })).toBe("/stationer?clock=wall");
    expect(hrefWith("/stationer", {})).toBe("/stationer");
  });
  it("leaves today out of a station link", () => {
    expect(stationHref(30, { day: TODAY, today: TODAY })).toBe("/stationer/30");
    expect(stationHref(30, { day: "2026-11-12", today: TODAY, clock: "working" })).toBe(
      "/stationer/30?day=2026-11-12&clock=working"
    );
  });
  it("reads a station number from the path", () => {
    expect(parseStationNo("30")).toBe(30);
    expect(parseStationNo("0")).toBe(0);
    expect(parseStationNo("-1")).toBeNull();
    expect(parseStationNo("3a")).toBeNull();
  });
});

function iv(over: Partial<TimelineInterval>): TimelineInterval {
  return {
    intervalId: "i",
    orderNo: 1,
    barcode: "b",
    position: 1,
    subPosition: 1,
    piece: 1,
    elementTypeId: "vindue",
    elementTypeName: "Vindue",
    status: "done",
    missingReason: null,
    visit: 1,
    isRework: false,
    startAt: "2026-11-13T07:10:00.000Z",
    endAt: "2026-11-13T07:20:00.000Z",
    startEstimated: false,
    endEvent: null,
    autoStopped: false,
    duration: { seconds: 600, wallSeconds: 600, workingSeconds: 600 },
    split: { seconds: 600, wallSeconds: 600, workingSeconds: 600 },
    waitBefore: { seconds: null, wallSeconds: null, workingSeconds: null },
    ...over,
  };
}

describe("buildStationTimeline", () => {
  const bounds = { dayStart: dayStart(TODAY), dayEnd: dayEnd(TODAY), now: Date.parse("2026-11-13T10:30:00.000Z") };

  it("makes a lane per element type and an axis on whole hours", () => {
    const data = buildStationTimeline(
      [
        iv({ intervalId: "a" }),
        iv({ intervalId: "b", elementTypeId: "dor", elementTypeName: "Dør", startAt: "2026-11-13T08:05:00.000Z", endAt: "2026-11-13T08:40:00.000Z" }),
        iv({ intervalId: "c", isRework: true, startAt: "2026-11-13T09:00:00.000Z", endAt: "2026-11-13T09:10:00.000Z" }),
      ],
      bounds
    )!;
    expect(data.lanes.map((l) => l.label)).toEqual(["Vindue", "Dør"]);
    expect(data.lanes[0].bars.map((b) => b.tone)).toEqual(["default", "alert"]);
    expect(data.lanes[0].totalSeconds).toBe(1200);
    expect(new Date(data.axisStart).toISOString()).toBe("2026-11-13T07:00:00.000Z");
    expect(new Date(data.axisEnd).toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });

  it("runs an open pass to now and leaves out a missing scan-out", () => {
    const data = buildStationTimeline(
      [
        iv({ intervalId: "open", status: "open", endAt: null, startAt: "2026-11-13T10:00:00.000Z" }),
        iv({ intervalId: "lost", status: "missing_out", endAt: null, missingReason: "superseded" }),
      ],
      bounds
    )!;
    expect(data.missingOut).toBe(1);
    expect(data.lanes[0].bars).toHaveLength(1);
    expect(data.lanes[0].bars[0]).toMatchObject({ tone: "active", end: bounds.now });
  });

  it("draws a pass from the evening before from the start of the day", () => {
    const data = buildStationTimeline([iv({ startAt: "2026-11-12T20:00:00.000Z", endAt: "2026-11-13T00:30:00.000Z" })], bounds)!;
    expect(data.lanes[0].bars[0].start).toBe(bounds.dayStart);
    expect(data.axisStart).toBe(bounds.dayStart);
  });

  it("has no lanes for an empty day", () => {
    expect(buildStationTimeline([], bounds)!.lanes).toEqual([]);
  });
});

describe("trendScaleMax", () => {
  const point = (seconds: number | null, normal: number | null): StationTrendPoint => ({
    weekStart: "2026-11-09",
    isoYear: 2026,
    isoWeek: 46,
    label: "46",
    countThrough: null,
    timePerPiece: { seconds, wallSeconds: seconds, workingSeconds: seconds },
    normalSeconds: normal,
    deviationPercent: null,
    standstillSeconds: null,
  });
  it("is null without figures", () => {
    expect(trendScaleMax([point(null, null)])).toBeNull();
  });
  it("adds a tenth to the largest figure and rounds up to a whole minute", () => {
    expect(trendScaleMax([point(250, 300), point(310, null)])).toBe(360);
    expect(trendScaleMax([point(540, null)])).toBe(600);
    expect(trendScaleMax([point(20, null)])).toBe(60);
  });
});
