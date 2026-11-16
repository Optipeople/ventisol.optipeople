import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDayTime,
  formatDuration,
  formatForecast,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSignedPercent,
  joinDanish,
  monthLabel,
  monthTitle,
  NO_DATA,
  weekLabel,
  weekTitle,
} from "./format";

describe("formatDuration", () => {
  it("hours and minutes as the deck shows them", () => {
    expect(formatDuration(11 * 3600 + 20 * 60)).toBe("11 t 20 min");
    expect(formatDuration(3600)).toBe("1 t 00 min");
    expect(formatDuration(55 * 60)).toBe("55 min");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(0)).toBe("0 s");
  });

  it("rounds to whole minutes, and carries into the hour", () => {
    expect(formatDuration(89)).toBe("1 min");
    expect(formatDuration(90)).toBe("2 min");
    expect(formatDuration(3599)).toBe("1 t 00 min");
    expect(formatDuration(100 * 3600)).toBe("100 t 00 min");
  });

  it("null is no data, never zero", () => {
    expect(formatDuration(null)).toBe(NO_DATA);
    expect(formatDuration(undefined)).toBe(NO_DATA);
    expect(formatDuration(Number.NaN)).toBe(NO_DATA);
  });
});

describe("formatMinutes", () => {
  it("one decimal below ten minutes, whole minutes above", () => {
    expect(formatMinutes(270)).toBe("4,5 min");
    expect(formatMinutes(540)).toBe("9 min");
    expect(formatMinutes(14 * 60 + 10)).toBe("14 min");
    expect(formatMinutes(30)).toBe("0,5 min");
  });

  it("from an hour up as a duration", () => {
    expect(formatMinutes(3600)).toBe("1 t 00 min");
  });

  it("null is no data", () => {
    expect(formatMinutes(null)).toBe(NO_DATA);
  });
});

describe("percent, points and numbers", () => {
  it("formatPercent", () => {
    expect(formatPercent(94)).toBe("94 %");
    expect(formatPercent(66.7)).toBe("67 %");
    expect(formatPercent(0)).toBe("0 %");
    expect(formatPercent(null)).toBe(NO_DATA);
  });

  it("formatSignedPercent uses the real minus sign", () => {
    expect(formatSignedPercent(-6)).toBe("−6 %");
    expect(formatSignedPercent(8)).toBe("+8 %");
    expect(formatSignedPercent(0)).toBe("±0 %");
    expect(formatSignedPercent(-0.4)).toBe("±0 %");
    expect(formatSignedPercent(1289)).toBe("+1.289 %");
    expect(formatSignedPercent(null)).toBe(NO_DATA);
  });

  it("formatPoints", () => {
    expect(formatPoints(3)).toBe("+3 point");
    expect(formatPoints(-2)).toBe("−2 point");
    expect(formatPoints(null)).toBe(NO_DATA);
  });

  it("formatNumber and formatCount", () => {
    expect(formatNumber(186)).toBe("186");
    expect(formatNumber(1204)).toBe("1.204");
    expect(formatNumber(null)).toBe(NO_DATA);
    expect(formatCount(1, "element", "elementer")).toBe("1 element");
    expect(formatCount(12, "element", "elementer")).toBe("12 elementer");
    expect(formatCount(0, "ordre", "ordrer")).toBe("0 ordrer");
    expect(formatCount(null, "ordre", "ordrer")).toBe(NO_DATA);
  });
});

describe("joinDanish", () => {
  it("commas and a final og", () => {
    expect(joinDanish([])).toBe("");
    expect(joinDanish(["Station 10"])).toBe("Station 10");
    expect(joinDanish(["Station 10", "Pakning"])).toBe("Station 10 og Pakning");
    expect(joinDanish(["Buffer", "Station 30", "Montagebord 2"])).toBe("Buffer, Station 30 og Montagebord 2");
  });
});

describe("weeks and months", () => {
  it("ISO weeks, also across the new year", () => {
    expect(weekLabel("2026-10-21")).toBe("43");
    expect(weekTitle("2026-10-21")).toBe("Uge 43");
    expect(weekLabel("2027-01-01")).toBe("53");
    expect(weekLabel("2027-01-04")).toBe("1");
  });

  it("months in Danish", () => {
    expect(monthLabel("2026-10-21")).toBe("okt.");
    expect(monthTitle("2026-10-01")).toBe("oktober 2026");
    expect(monthLabel("2026-05-31")).toBe("maj");
  });
});

describe("instants in Copenhagen time", () => {
  it("formatDayTime in summer and winter time", () => {
    expect(formatDayTime("2026-09-15T04:00:00.000Z")).toBe("15.9 kl. 06:00");
    expect(formatDayTime("2026-11-16T11:05:00.000Z")).toBe("16.11 kl. 12:05");
    // 23:30 UTC on 31 December is 00:30 on 1 January in Copenhagen.
    expect(formatDayTime("2026-12-31T23:30:00.000Z")).toBe("1.1 kl. 00:30");
    expect(formatDayTime(null)).toBe(NO_DATA);
  });

  it("formatForecast drops the minutes on the hour", () => {
    expect(formatForecast("2026-10-23T12:00:00.000Z")).toBe("fre. kl. 14");
    expect(formatForecast("2026-10-23T12:30:00.000Z")).toBe("fre. kl. 14:30");
    expect(formatForecast("2026-11-16T06:00:00.000Z")).toBe("man. kl. 7");
    expect(formatForecast(undefined)).toBe(NO_DATA);
  });
});
