import { describe, expect, it } from "vitest";
import {
  changeTone,
  defaultBucket,
  defaultPeriod,
  filterHref,
  formatPeriod,
  parseOverviewFilters,
  periodPresets,
} from "./filters";

// 2026-11-16 is a Monday, 2026-11-19 a Thursday.
const MONDAY = "2026-11-16";
const THURSDAY = "2026-11-19";

describe("periodPresets", () => {
  it("builds the presets around a Thursday", () => {
    const byId = Object.fromEntries(periodPresets(THURSDAY).map((p) => [p.id, [p.from, p.to]]));
    expect(byId).toEqual({
      last4weeks: ["2026-10-26", THURSDAY],
      thisWeek: ["2026-11-16", THURSDAY],
      lastWeek: ["2026-11-09", "2026-11-15"],
      thisMonth: ["2026-11-01", THURSDAY],
      lastMonth: ["2026-10-01", "2026-10-31"],
    });
  });

  it("handles a Monday and a year boundary", () => {
    expect(defaultPeriod(MONDAY)).toEqual({ from: "2026-10-26", to: MONDAY });
    const jan = Object.fromEntries(periodPresets("2027-01-05").map((p) => [p.id, [p.from, p.to]]));
    expect(jan.lastMonth).toEqual(["2026-12-01", "2026-12-31"]);
    expect(jan.thisWeek).toEqual(["2027-01-04", "2027-01-05"]);
    expect(jan.lastWeek).toEqual(["2026-12-28", "2027-01-03"]);
  });
});

describe("parseOverviewFilters", () => {
  it("defaults to the last four weeks, weekly, with the setting's clock", () => {
    expect(parseOverviewFilters({}, THURSDAY)).toEqual({
      from: "2026-10-26",
      to: THURSDAY,
      preset: "last4weeks",
      clock: undefined,
      bucket: "week",
      bucketChosen: false,
      correction: null,
    });
  });

  it("reads a custom period, the clock and the bucket", () => {
    const f = parseOverviewFilters(
      { from: "2026-09-01", to: "2026-09-30", clock: "wall", bucket: "month" },
      THURSDAY
    );
    expect(f).toMatchObject({ from: "2026-09-01", to: "2026-09-30", preset: "custom", clock: "wall", bucket: "month", bucketChosen: true });
  });

  it("recognises a preset in the URL", () => {
    expect(parseOverviewFilters({ from: "2026-10-01", to: "2026-10-31" }, THURSDAY).preset).toBe("lastMonth");
  });

  it("swaps reversed days and clamps the future to today", () => {
    expect(parseOverviewFilters({ from: "2026-11-10", to: "2026-11-01" }, THURSDAY)).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-10",
      correction: null,
    });
    const f = parseOverviewFilters({ from: "2026-11-01", to: "2026-12-24" }, THURSDAY);
    expect(f).toMatchObject({ from: "2026-11-01", to: THURSDAY });
    expect(f.correction).toMatch(/i dag/);
    expect(parseOverviewFilters({ from: "2027-01-01", to: "2027-01-31" }, THURSDAY)).toMatchObject({ from: THURSDAY, to: THURSDAY });
  });

  it("falls back on broken input and says so", () => {
    const f = parseOverviewFilters({ from: "2026-02-30", to: "x", clock: "sun", bucket: "year" }, THURSDAY);
    expect(f).toMatchObject({ from: "2026-10-26", to: THURSDAY, clock: undefined, bucket: "week" });
    expect(f.correction).toMatch(/kunne ikke læses/);
  });

  it("takes the first of repeated params", () => {
    expect(parseOverviewFilters({ from: ["2026-11-02", "x"], to: ["2026-11-08"] }, THURSDAY)).toMatchObject({
      from: "2026-11-02",
      to: "2026-11-08",
    });
  });

  it("cuts a period longer than two years from the start", () => {
    const f = parseOverviewFilters({ from: "2020-01-01", to: "2026-11-01" }, THURSDAY);
    expect(f.to).toBe("2026-11-01");
    expect(f.from).toBe("2024-11-01");
    expect(f.bucket).toBe("month");
    expect(f.correction).toMatch(/to år/);
  });
});

describe("helpers", () => {
  it("picks months for long periods", () => {
    expect(defaultBucket("2026-01-01", "2026-05-06")).toBe("week");
    expect(defaultBucket("2026-01-01", "2026-05-07")).toBe("month");
  });

  it("builds hrefs that carry the filters", () => {
    expect(filterHref("/stationer", { from: "2026-11-01", to: "2026-11-19", clock: "wall" })).toBe(
      "/stationer?from=2026-11-01&to=2026-11-19&clock=wall"
    );
    expect(filterHref("/ordrer", { from: "2026-11-01", to: "2026-11-19" }, { status: "late", x: undefined })).toBe(
      "/ordrer?from=2026-11-01&to=2026-11-19&status=late"
    );
  });

  it("formats a period in Danish", () => {
    expect(formatPeriod("2026-10-26", "2026-11-19")).toBe("26.10.2026 til 19.11.2026");
    expect(formatPeriod("2026-11-19", "2026-11-19")).toBe("19.11.2026");
  });

  it("tells good from bad changes", () => {
    expect(changeTone(-6, true)).toBe("good");
    expect(changeTone(8, true)).toBe("bad");
    expect(changeTone(8, false)).toBe("good");
    expect(changeTone(0.2, false)).toBeNull();
    expect(changeTone(null, true)).toBeNull();
  });
});
