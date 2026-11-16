import { describe, expect, it } from "vitest";
import {
  currentMonth,
  isMonth,
  isMonthOver,
  lastFullMonth,
  monthChoices,
  monthHref,
  MONTHS_BACK,
  noteLines,
  noteLinesProblem,
  parseClockParam,
  parseMonthParam,
  shiftMonth,
} from "./month";

const at = (iso: string) => Date.parse(iso);
// 16 November 2026, noon in Copenhagen.
const NOW = at("2026-11-16T11:00:00Z");

describe("months", () => {
  it("reads only real yyyy-MM months", () => {
    expect(isMonth("2026-10")).toBe(true);
    for (const v of ["2026-13", "2026-00", "2026-1", "2026-10-01", "", undefined, null]) expect(isMonth(v)).toBe(false);
  });

  it("shifts across year ends", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-11", -12)).toBe("2025-11");
  });

  it("decides the month in Copenhagen time, not UTC", () => {
    // 23:30 UTC on 31 October is 00:30 on 1 November in Copenhagen (CET).
    const firstNovember = at("2026-10-31T23:30:00Z");
    expect(currentMonth(firstNovember)).toBe("2026-11");
    expect(lastFullMonth(firstNovember)).toBe("2026-10");
    expect(isMonthOver("2026-10", firstNovember)).toBe(true);
    // 21:30 UTC on 31 October is still October in Copenhagen.
    expect(isMonthOver("2026-10", at("2026-10-31T21:30:00Z"))).toBe(false);
    // Summer time: 22:30 UTC on 31 July is 00:30 on 1 August (CEST).
    expect(currentMonth(at("2026-07-31T22:30:00Z"))).toBe("2026-08");
  });

  it("defaults to the last full month and clamps to what the picker reaches", () => {
    expect(parseMonthParam(undefined, NOW)).toEqual({ month: "2026-10", clamped: false });
    expect(parseMonthParam("", NOW)).toEqual({ month: "2026-10", clamped: false });
    expect(parseMonthParam("nonsense", NOW)).toEqual({ month: "2026-10", clamped: true });
    expect(parseMonthParam("2026-11", NOW)).toEqual({ month: "2026-11", clamped: false });
    expect(parseMonthParam(["2026-09", "2026-08"], NOW)).toEqual({ month: "2026-09", clamped: false });
    expect(parseMonthParam("2027-01", NOW)).toEqual({ month: "2026-11", clamped: true });
    expect(parseMonthParam("2020-01", NOW)).toEqual({ month: shiftMonth("2026-11", -MONTHS_BACK), clamped: true });
  });

  it("lists the months newest first, the current month included", () => {
    const choices = monthChoices(NOW);
    expect(choices[0]).toBe("2026-11");
    expect(choices[1]).toBe("2026-10");
    expect(choices).toHaveLength(MONTHS_BACK + 1);
  });

  it("links the last full month as the bare path", () => {
    expect(monthHref("2026-10", NOW)).toBe("/ledelse");
    expect(monthHref("2026-11", NOW)).toBe("/ledelse?maaned=2026-11");
    expect(monthHref("2026-10", NOW, "wall")).toBe("/ledelse?clock=wall");
    expect(monthHref("2026-09", NOW, "working")).toBe("/ledelse?maaned=2026-09&clock=working");
  });

  it("reads the clock param", () => {
    expect(parseClockParam("wall")).toBe("wall");
    expect(parseClockParam(["working"])).toBe("working");
    expect(parseClockParam("WALL")).toBeUndefined();
    expect(parseClockParam(undefined)).toBeUndefined();
  });
});

describe("note lines", () => {
  it("splits on lines, trims, drops empty lines and bullet marks", () => {
    expect(noteLines("- Leveret til tiden steg\r\n\n  * Bufferen er flaskehalsen \n2. Ny pakkestation\n• Punkt")).toEqual([
      "Leveret til tiden steg",
      "Bufferen er flaskehalsen",
      "Ny pakkestation",
      "Punkt",
    ]);
    expect(noteLines("   \n")).toEqual([]);
    // A minus inside a line or a number without a mark is kept.
    expect(noteLines("-6 % på gennemløbstid\n2026 blev godt")).toEqual(["-6 % på gennemløbstid", "2026 blev godt"]);
  });

  it("says when there are too many or too long lines", () => {
    expect(noteLinesProblem(["a"])).toBeNull();
    expect(noteLinesProblem(Array.from({ length: 21 }, () => "a"))).toBe("Højst 20 punkter.");
    expect(noteLinesProblem(["x".repeat(1001)])).toBe("Højst 1000 tegn pr. punkt.");
  });
});
