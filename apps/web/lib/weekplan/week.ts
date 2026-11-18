// The week of the plan in the URL: ?uge=2026-48 (ISO year and week). Pure.

import { addDays, dayKey, isoWeek, startOfWeek } from "@/lib/time";

export interface PlanWeek {
  year: number;
  week: number;
}

/** "2026-48" to { year: 2026, week: 48 }, else null. */
export function parseWeekParam(value: string | null | undefined): PlanWeek | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec((value ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (year < 2000 || year > 2100 || week < 1 || week > weeksIn(year)) return null;
  return { year, week };
}

export function weekParam(w: PlanWeek): string {
  return `${w.year}-${String(w.week).padStart(2, "0")}`;
}

/** The ISO week a day is in: the year is the year of its Thursday. */
export function weekOfDay(isoDay: string): PlanWeek {
  const thursday = addDays(startOfWeek(isoDay), 3);
  return { year: Number(thursday.slice(0, 4)), week: isoWeek(isoDay) };
}

/** 52 or 53: the week of 28 December is the year's last. */
export function weeksIn(year: number): number {
  return isoWeek(`${year}-12-28`);
}

/** The Monday of an ISO week, yyyy-MM-dd. */
export function mondayOf(w: PlanWeek): string {
  // 4 January is always in week 1.
  return addDays(startOfWeek(`${w.year}-01-04`), (w.week - 1) * 7);
}

export function shiftWeek(w: PlanWeek, weeks: number): PlanWeek {
  return weekOfDay(addDays(mondayOf(w), weeks * 7));
}

/** The plan's default: the week that starts next, as the office plans ahead. */
export function defaultPlanWeek(now: number): PlanWeek {
  return shiftWeek(weekOfDay(dayKey(now)), 1);
}
