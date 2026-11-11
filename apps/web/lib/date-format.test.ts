import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  addMonths,
  dateToIso,
  formatDisplayDate,
  isIsoDate,
  isoToDate,
  isoWeekNumber,
  makeDate,
  maskDateInput,
  parseDisplayDate,
  startOfIsoWeek,
  todayUtc,
} from "@/lib/date-format";

const d = (iso: string) => isoToDate(iso)!;

describe("ISO days", () => {
  it("reads yyyy-MM-dd as midnight UTC", () => {
    expect(isoToDate("2026-09-14")?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
  it("refuses what is not a real day", () => {
    expect(isoToDate("2026-02-30")).toBeNull();
    expect(isoToDate("2026-13-01")).toBeNull();
    expect(isoToDate("14-09-2026")).toBeNull();
    expect(isoToDate("2026-9-14")).toBeNull();
    expect(isoToDate("")).toBeNull();
  });
  it("knows a leap day", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
  });
  it("refuses years no report is about", () => {
    expect(makeDate(1899, 1, 1)).toBeNull();
    expect(makeDate(3000, 1, 1)).toBeNull();
    expect(makeDate(1900, 1, 1)).not.toBeNull();
  });
  it("writes a date back as yyyy-MM-dd", () => {
    expect(dateToIso(d("2026-01-05"))).toBe("2026-01-05");
  });
});

describe("formatDisplayDate", () => {
  it("shows dd-MM-yyyy", () => {
    expect(formatDisplayDate("2026-09-14")).toBe("14-09-2026");
  });
  it("shows nothing for what is not a day", () => {
    expect(formatDisplayDate("2026-02-30")).toBe("");
    expect(formatDisplayDate("14-09-2026")).toBe("");
  });
});

describe("parseDisplayDate", () => {
  it.each(["14-09-2026", "14.09.2026", "14/09/2026", "14 09 2026", "14092026", "140926", "14-9-26", " 14-09-2026 "])(
    "reads %s",
    (typed) => {
      expect(parseDisplayDate(typed)).toBe("2026-09-14");
    }
  );
  it("reads an ISO day, as copied out of the address bar", () => {
    expect(parseDisplayDate("2026-09-14")).toBe("2026-09-14");
  });
  it("reads eight digits as yyyyMMdd when they cannot be ddMMyyyy", () => {
    expect(parseDisplayDate("20260914")).toBe("2026-09-14");
  });
  it("takes a two-digit year as this century", () => {
    expect(parseDisplayDate("01-02-03")).toBe("2003-02-01");
  });
  it.each(["", "   ", "31-02-2026", "14-09", "14-09-202", "1409", "fjorten", "14-09-2026-1", "14--2026x"])(
    "refuses %j",
    (typed) => {
      expect(parseDisplayDate(typed)).toBeNull();
    }
  );
});

describe("maskDateInput", () => {
  it("groups digits with dashes as they are typed", () => {
    expect(maskDateInput("1")).toBe("1");
    expect(maskDateInput("14")).toBe("14");
    expect(maskDateInput("140")).toBe("14-0");
    expect(maskDateInput("1409")).toBe("14-09");
    expect(maskDateInput("14092")).toBe("14-09-2");
    expect(maskDateInput("14092026")).toBe("14-09-2026");
  });
  it("stops at eight digits", () => {
    expect(maskDateInput("140920261")).toBe("14-09-2026");
  });
  it("lets backspace delete past a dash", () => {
    expect(maskDateInput("14-")).toBe("14");
    expect(maskDateInput("14-09-")).toBe("14-09");
  });
  it("leaves a pasted date in another shape alone", () => {
    expect(maskDateInput("2026-09-14")).toBe("2026-09-14");
    expect(maskDateInput("14.09.2026")).toBe("14.09.2026");
    expect(maskDateInput("14/09/2026")).toBe("14/09/2026");
  });
});

describe("calendar arithmetic", () => {
  it("adds days across a month and a year end", () => {
    expect(dateToIso(addDays(d("2026-12-30"), 3))).toBe("2027-01-02");
    expect(dateToIso(addDays(d("2026-03-01"), -1))).toBe("2026-02-28");
  });
  it("adds days across both DST switches without shifting the day", () => {
    expect(dateToIso(addDays(d("2026-03-28"), 2))).toBe("2026-03-30");
    expect(dateToIso(addDays(d("2026-10-24"), 2))).toBe("2026-10-26");
  });
  it("adds months, keeping to the end of a shorter month", () => {
    expect(dateToIso(addMonths(d("2026-01-31"), 1))).toBe("2026-02-28");
    expect(dateToIso(addMonths(d("2026-03-31"), -1))).toBe("2026-02-28");
    expect(dateToIso(addMonths(d("2026-11-15"), 2))).toBe("2027-01-15");
    expect(dateToIso(addMonths(d("2026-01-15"), -1))).toBe("2025-12-15");
  });
  it("finds the Monday of a week", () => {
    expect(dateToIso(startOfIsoWeek(d("2026-10-21")))).toBe("2026-10-19");
    expect(dateToIso(startOfIsoWeek(d("2026-10-19")))).toBe("2026-10-19");
    // A Sunday belongs to the week that began the Monday before.
    expect(dateToIso(startOfIsoWeek(d("2026-10-25")))).toBe("2026-10-19");
  });
  it("numbers weeks the ISO way", () => {
    expect(isoWeekNumber(d("2026-10-21"))).toBe(43);
    expect(isoWeekNumber(d("2026-01-01"))).toBe(1);
    // 2026 has 53 weeks; the first days of 2027 still belong to its last.
    expect(isoWeekNumber(d("2026-12-31"))).toBe(53);
    expect(isoWeekNumber(d("2027-01-03"))).toBe(53);
    expect(isoWeekNumber(d("2027-01-04"))).toBe(1);
    // The last days of 2025 already belong to week 1 of 2026.
    expect(isoWeekNumber(d("2025-12-29"))).toBe(1);
  });
});

describe("todayUtc", () => {
  afterEach(() => vi.useRealTimers());

  it("is the viewer's calendar day, as midnight UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 21, 23, 30));
    expect(todayUtc().toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });
});
