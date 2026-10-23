import { describe, expect, it } from "vitest";
import {
  addDays,
  dayEnd,
  dayKey,
  dayStart,
  formatClock,
  formatCount,
  formatDuration,
  isIsoDay,
  isoWeek,
  startOfWeek,
} from "@/lib/time";

describe("Copenhagen days", () => {
  it("starts a summer day at 22:00 UTC the evening before", () => {
    expect(new Date(dayStart("2026-10-21")).toISOString()).toBe("2026-10-20T22:00:00.000Z");
  });
  it("starts a winter day at 23:00 UTC", () => {
    expect(new Date(dayStart("2026-11-02")).toISOString()).toBe("2026-11-01T23:00:00.000Z");
  });
  it("makes the DST-end day 25 hours long", () => {
    expect((dayEnd("2026-10-25") - dayStart("2026-10-25")) / 3_600_000).toBe(25);
  });
  it("puts a late-evening UTC instant on the next local day", () => {
    expect(dayKey(Date.parse("2026-10-20T22:30:00Z"))).toBe("2026-10-21");
  });
});

describe("calendar helpers", () => {
  it("adds days across a month end", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
  it("validates days", () => {
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2026-10-21")).toBe(true);
    expect(isIsoDay("21-10-2026")).toBe(false);
  });
  it("finds Monday and the ISO week", () => {
    expect(startOfWeek("2026-10-21")).toBe("2026-10-19");
    expect(isoWeek("2026-10-21")).toBe(43);
  });
});

describe("formatting", () => {
  it("shows Copenhagen clock time", () => {
    expect(formatClock(Date.parse("2026-10-21T05:42:00Z"))).toBe("07:42");
  });
  it("says durations the way the floor does", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(6 * 60_000 + 12_000)).toBe("6 min 12 s");
    expect(formatDuration(38 * 60_000)).toBe("38 min");
    expect(formatDuration(3 * 3_600_000 + 7 * 60_000)).toBe("3 t 07 min");
    expect(formatDuration(null)).toBe("–");
  });
  it("takes every part of a duration from the rounded seconds", () => {
    expect(formatDuration(59_930)).toBe("1 min");
    expect(formatDuration(3_599_600)).toBe("1 t 00 min");
    expect(formatDuration(119_600)).toBe("2 min");
    expect(formatDuration(59_400)).toBe("59 s");
  });
  it("puts a count with its noun in singular or plural", () => {
    expect(formatCount(1, "element", "elementer")).toBe("1 element");
    expect(formatCount(0, "element", "elementer")).toBe("0 elementer");
    expect(formatCount(1200, "ordre", "ordrer")).toBe("1.200 ordrer");
  });
});
