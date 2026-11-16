import { describe, expect, it } from "vitest";
import {
  ALWAYS_OPEN,
  DEFAULT_CALENDAR,
  addWorkingSeconds,
  isoWeekMonday,
  isoWeekday,
  localInstant,
  parseClock,
  shiftBlocksOn,
  workingMsBetween,
  workingSecondsBetween,
} from "./calendar";
import type { WorkCalendar } from "./types";

const H = 3600;
const utc = (s: string) => Date.parse(s);
const cal = DEFAULT_CALENDAR; // Monday to Friday 06:00 to 14:00

describe("calendar basics", () => {
  it("parses clock times", () => {
    expect(parseClock("06:00")).toBe(360);
    expect(parseClock("14:30:00")).toBe(870);
    expect(parseClock("24:00")).toBe(1440);
    expect(() => parseClock("6")).toThrow();
  });

  it("knows ISO weekdays and week Mondays", () => {
    expect(isoWeekday("2026-10-21")).toBe(3);
    expect(isoWeekday("2026-10-25")).toBe(7);
    expect(isoWeekMonday(2026, 43)).toBe("2026-10-19");
    expect(isoWeekMonday(2026, 1)).toBe("2025-12-29");
    expect(isoWeekMonday(2027, 1)).toBe("2027-01-04");
    expect(isoWeekMonday(2026, 53)).toBe("2026-12-28");
  });

  it("turns local wall clock into instants in summer and winter", () => {
    expect(localInstant("2026-10-21", 360)).toBe(utc("2026-10-21T04:00:00Z")); // CEST
    expect(localInstant("2026-11-16", 360)).toBe(utc("2026-11-16T05:00:00Z")); // CET
  });
});

describe("workingSecondsBetween", () => {
  it("counts only shift time inside one day", () => {
    // 05:00 to 15:00 local on a Wednesday: the 8 hour shift.
    expect(workingSecondsBetween(utc("2026-10-21T03:00:00Z"), utc("2026-10-21T13:00:00Z"), cal)).toBe(8 * H);
    // 07:00 to 08:30 local.
    expect(workingSecondsBetween(utc("2026-10-21T05:00:00Z"), utc("2026-10-21T06:30:00Z"), cal)).toBe(1.5 * H);
    // Entirely after the shift.
    expect(workingSecondsBetween(utc("2026-10-21T13:00:00Z"), utc("2026-10-21T20:00:00Z"), cal)).toBe(0);
  });

  it("drops the night: 13:00 one day to 07:00 the next is 2 hours", () => {
    expect(workingSecondsBetween(utc("2026-10-20T11:00:00Z"), utc("2026-10-21T05:00:00Z"), cal)).toBe(2 * H);
    expect(workingSecondsBetween(utc("2026-10-20T11:00:00Z"), utc("2026-10-21T05:00:00Z"), ALWAYS_OPEN)).toBe(18 * H);
  });

  it("drops the weekend: Friday 13:00 to Monday 07:00 is 2 hours", () => {
    expect(workingSecondsBetween(utc("2026-10-16T11:00:00Z"), utc("2026-10-19T05:00:00Z"), cal)).toBe(2 * H);
  });

  it("drops a closed day", () => {
    const withHoliday: WorkCalendar = { ...cal, closedDays: ["2026-10-20"] };
    // Monday 13:00 to Wednesday 07:00, Tuesday closed.
    expect(workingSecondsBetween(utc("2026-10-19T11:00:00Z"), utc("2026-10-21T05:00:00Z"), withHoliday)).toBe(2 * H);
    expect(workingSecondsBetween(utc("2026-10-19T11:00:00Z"), utc("2026-10-21T05:00:00Z"), cal)).toBe(10 * H);
  });

  it("handles several blocks a day (a break is two blocks)", () => {
    const withBreak: WorkCalendar = {
      shifts: { 3: [{ start: "06:00", end: "11:30" }, { start: "12:00", end: "14:00" }] },
      closedDays: [],
    };
    expect(workingSecondsBetween(utc("2026-10-21T00:00:00Z"), utc("2026-10-21T20:00:00Z"), withBreak)).toBe(7.5 * H);
  });

  it("merges overlapping blocks instead of counting them twice", () => {
    const overlapping: WorkCalendar = {
      shifts: { 3: [{ start: "06:00", end: "12:00" }, { start: "10:00", end: "14:00" }] },
      closedDays: [],
    };
    expect(shiftBlocksOn("2026-10-21", overlapping)).toHaveLength(1);
    expect(workingSecondsBetween(utc("2026-10-21T00:00:00Z"), utc("2026-10-21T20:00:00Z"), overlapping)).toBe(8 * H);
  });

  it("is additive and zero for an empty or backwards span", () => {
    const a = utc("2026-10-16T09:17:31Z");
    const b = utc("2026-10-19T06:02:11Z");
    const c = utc("2026-10-22T10:45:00Z");
    expect(workingMsBetween(a, b, cal) + workingMsBetween(b, c, cal)).toBe(workingMsBetween(a, c, cal));
    expect(workingSecondsBetween(c, a, cal)).toBe(0);
    expect(workingSecondsBetween(a, a, cal)).toBe(0);
  });
});

describe("clock changes", () => {
  // 2026-10-25 (Sunday): 03:00 CEST becomes 02:00 CET, the day is 25 hours.
  // 2027-03-28 (Sunday): 02:00 CET becomes 03:00 CEST, the day is 23 hours.
  const everyDay = (start: string, end: string): WorkCalendar => ({
    shifts: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [{ start, end }]])),
    closedDays: [],
  });

  it("the day shift is 8 hours on both sides of the autumn change", () => {
    const c = everyDay("06:00", "14:00");
    expect(shiftBlocksOn("2026-10-24", c)).toEqual([[utc("2026-10-24T04:00:00Z"), utc("2026-10-24T12:00:00Z")]]);
    expect(shiftBlocksOn("2026-10-25", c)).toEqual([[utc("2026-10-25T05:00:00Z"), utc("2026-10-25T13:00:00Z")]]);
    expect(shiftBlocksOn("2026-10-26", c)).toEqual([[utc("2026-10-26T05:00:00Z"), utc("2026-10-26T13:00:00Z")]]);
  });

  it("a block over the autumn change is an hour longer in real time", () => {
    const c = everyDay("01:00", "05:00");
    expect(workingSecondsBetween(utc("2026-10-24T22:00:00Z"), utc("2026-10-25T23:00:00Z"), c)).toBe(5 * H);
    expect(workingSecondsBetween(utc("2026-10-23T22:00:00Z"), utc("2026-10-24T22:00:00Z"), c)).toBe(4 * H);
  });

  it("a block over the spring change is an hour shorter in real time", () => {
    const c = everyDay("01:00", "05:00");
    expect(workingSecondsBetween(utc("2027-03-27T23:00:00Z"), utc("2027-03-28T22:00:00Z"), c)).toBe(3 * H);
    expect(shiftBlocksOn("2027-03-29", everyDay("06:00", "14:00"))).toEqual([
      [utc("2027-03-29T04:00:00Z"), utc("2027-03-29T12:00:00Z")],
    ]);
  });

  it("a whole open day is 25 and 23 hours on the change days", () => {
    expect(workingSecondsBetween(utc("2026-10-24T22:00:00Z"), utc("2026-10-25T23:00:00Z"), ALWAYS_OPEN)).toBe(25 * H);
    expect(workingSecondsBetween(utc("2027-03-27T23:00:00Z"), utc("2027-03-28T22:00:00Z"), ALWAYS_OPEN)).toBe(23 * H);
  });

  it("Friday to Monday over the autumn change still counts two shifts' worth correctly", () => {
    // Friday 2026-10-23 13:00 CEST to Monday 2026-10-26 07:00 CET: 1 h + 1 h.
    expect(workingSecondsBetween(utc("2026-10-23T11:00:00Z"), utc("2026-10-26T06:00:00Z"), DEFAULT_CALENDAR)).toBe(2 * H);
  });
});

describe("addWorkingSeconds", () => {
  it("stays inside a shift when there is room", () => {
    expect(addWorkingSeconds(utc("2026-10-21T05:00:00Z"), 2 * H, cal)).toBe(utc("2026-10-21T07:00:00Z"));
  });

  it("rolls over the night and the weekend", () => {
    // Wednesday 13:00 local + 3 h: one hour today, two tomorrow, so 08:00 Thursday.
    expect(addWorkingSeconds(utc("2026-10-21T11:00:00Z"), 3 * H, cal)).toBe(utc("2026-10-22T06:00:00Z"));
    // Friday 13:00 local + 3 h: Monday 08:00.
    expect(addWorkingSeconds(utc("2026-10-16T11:00:00Z"), 3 * H, cal)).toBe(utc("2026-10-19T06:00:00Z"));
  });

  it("starts at the next shift when asked outside one", () => {
    expect(addWorkingSeconds(utc("2026-10-21T18:00:00Z"), 60, cal)).toBe(utc("2026-10-22T04:01:00Z"));
  });

  it("is the inverse of workingSecondsBetween", () => {
    const from = utc("2026-10-15T08:13:00Z");
    const to = addWorkingSeconds(from, 100_000, cal) as number;
    expect(workingSecondsBetween(from, to, cal)).toBe(100_000);
  });

  it("gives null for a calendar with no shifts, and the start for zero seconds", () => {
    expect(addWorkingSeconds(0, 60, { shifts: {}, closedDays: [] })).toBeNull();
    expect(addWorkingSeconds(123, 0, cal)).toBe(123);
  });
});
