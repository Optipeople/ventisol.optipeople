import { describe, expect, it } from "vitest";
import { at } from "@/lib/test-helpers";
import { splitStationTime, type SplitPass } from "./allocate";
import { ALWAYS_OPEN, DEFAULT_CALENDAR, workingSecondsBetween } from "./calendar";

const pass = (id: string, from: string, to: string, weight: number | null = null): SplitPass => ({
  id,
  start: at(from),
  end: at(to),
  weight,
});
const seconds = (shares: ReturnType<typeof splitStationTime>) =>
  Object.fromEntries([...shares].map(([id, s]) => [id, s.seconds / 60]));

describe("splitStationTime", () => {
  it("gives a pass alone on its station its whole time, on both clocks", () => {
    const shares = splitStationTime([pass("a", "13:00", "15:00"), pass("b", "15:30", "16:00")], "calculated", DEFAULT_CALENDAR);
    expect(shares.get("a")).toEqual({ seconds: 7200, workingSeconds: workingSecondsBetween(at("13:00"), at("15:00"), DEFAULT_CALENDAR) });
    expect(shares.get("a")?.workingSeconds).toBe(3600);
    expect(shares.get("b")).toEqual({ seconds: 1800, workingSeconds: 0 });
  });

  it("splits an hour on four elements into an hour of the station's work", () => {
    const four = ["a", "b", "c", "d"].map((id) => pass(id, "08:00", "09:00"));
    const shares = splitStationTime(four, "equal", ALWAYS_OPEN);
    expect(seconds(shares)).toEqual({ a: 15, b: 15, c: 15, d: 15 });
  });

  it("splits only the part where they overlap, equally", () => {
    // a 08:00-08:40, b 08:20-09:00: 20 alone + 10 each, and the same for b.
    const shares = splitStationTime([pass("a", "08:00", "08:40"), pass("b", "08:20", "09:00")], "equal", ALWAYS_OPEN);
    expect(seconds(shares)).toEqual({ a: 30, b: 30 });
  });

  it("weighs by calculated time", () => {
    const shares = splitStationTime([pass("a", "08:00", "09:00", 30), pass("b", "08:00", "09:00", 10)], "calculated", ALWAYS_OPEN);
    expect(seconds(shares)).toEqual({ a: 45, b: 15 });
    // Weights are ignored when the setting says equal.
    expect(seconds(splitStationTime([pass("a", "08:00", "09:00", 30), pass("b", "08:00", "09:00", 10)], "equal", ALWAYS_OPEN))).toEqual({ a: 30, b: 30 });
  });

  it("splits a piece equally when one of its passes has no calculated time", () => {
    const shares = splitStationTime(
      [pass("a", "08:00", "10:00", 30), pass("b", "08:00", "09:00", 10), pass("c", "09:00", "10:00", null)],
      "calculated",
      ALWAYS_OPEN
    );
    // 08-09: a and b by weight (45 and 15); 09-10: a and c equally (30 each).
    expect(seconds(shares)).toEqual({ a: 75, b: 15, c: 30 });
    // A calculated time of 0 is no calculated time either.
    expect(seconds(splitStationTime([pass("a", "08:00", "09:00", 0), pass("b", "08:00", "09:00", 10)], "calculated", ALWAYS_OPEN))).toEqual({ a: 30, b: 30 });
  });

  it("counts an open pass up to now, as the caller hands it in", () => {
    const now = at("09:00");
    const shares = splitStationTime(
      [pass("done", "08:00", "08:30"), { id: "open", start: at("08:00"), end: now, weight: null }],
      "equal",
      ALWAYS_OPEN
    );
    expect(seconds(shares)).toEqual({ done: 15, open: 45 });
  });

  it("leaves what is not handed in out: a missing scan-out takes no share", () => {
    // The caller drops missing scan-outs; the others then share only among themselves.
    expect(seconds(splitStationTime([pass("a", "08:00", "09:00")], "equal", ALWAYS_OPEN))).toEqual({ a: 60 });
  });

  it("shares the shift time in the working variant, and gives a zero-length pass nothing", () => {
    // 13:00-15:00 both: wall 60 each; shift ends 14:00, so 30 working minutes each.
    const shares = splitStationTime(
      [pass("a", "13:00", "15:00"), pass("b", "13:00", "15:00"), pass("z", "13:30", "13:30")],
      "equal",
      DEFAULT_CALENDAR
    );
    expect(shares.get("a")).toEqual({ seconds: 3600, workingSeconds: 1800 });
    expect(shares.get("b")).toEqual({ seconds: 3600, workingSeconds: 1800 });
    expect(shares.get("z")).toEqual({ seconds: 0, workingSeconds: 0 });
  });

  it("adds up to the station's busy time, whatever the overlaps", () => {
    const passes = [
      pass("a", "08:00", "08:47", 12),
      pass("b", "08:05", "09:13", 7),
      pass("c", "08:11", "08:29", null),
      pass("d", "08:50", "09:40", 20),
    ];
    const shares = splitStationTime(passes, "calculated", ALWAYS_OPEN);
    const total = [...shares.values()].reduce((t, s) => t + s.seconds, 0);
    expect(Math.abs(total - (at("09:40") - at("08:00")) / 1000)).toBeLessThanOrEqual(passes.length);
  });
});
