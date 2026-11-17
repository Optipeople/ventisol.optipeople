// The Stationer tab's URL: which view, which day or period, which clock.
// Pure: `today` comes in from the page. Every filter lives in the URL
// (docs/portal-architecture.md §6). The names match Overblik
// (lib/overview/filters.ts), whose links carry `from`, `to` and `clock` here:
//
//   /stationer?day=2026-11-13&clock=wall
//   /stationer?from=2026-11-02&to=2026-11-13            (period view)
//   /stationer?view=period&from=2026-11-02&to=2026-11-13
//   /stationer/30?day=2026-11-13

import type { Clock } from "@/lib/reports/types";
import { addDays, daysBetween, isIsoDay, startOfWeek } from "@/lib/time";

export type StationsView = "day" | "period";

/** As Overblik words them. */
export const CLOCK_LABELS: Record<Clock, string> = { working: "Arbejdstid", wall: "Hele døgnet" };

/** The longest period one table reads. */
export const MAX_PERIOD_DAYS = 366;

/**
 * `view=period` or `view=day` decide. Without it, a `from` or `to` and no
 * `day` (a link from Overblik) means the period view.
 */
export function parseView(params: {
  view?: string | null;
  day?: string | null;
  from?: string | null;
  to?: string | null;
}): StationsView {
  if (params.view === "period") return "period";
  if (params.view === "day") return "day";
  return !params.day && (params.from || params.to) ? "period" : "day";
}

/** `clock=working|wall`. Left out: the clock of the setting deduct_off_shift. */
export function parseClock(value: string | undefined | null): Clock | undefined {
  return value === "working" || value === "wall" ? value : undefined;
}

export interface DayChoice {
  day: string;
  /** `day` lay in the future and was moved to today. */
  clamped: boolean;
}

/** `?day=`: today when missing or not a day, today when later than today. */
export function parseDay(value: string | undefined | null, today: string): DayChoice {
  if (!isIsoDay(value)) return { day: today, clamped: false };
  if (value > today) return { day: today, clamped: true };
  return { day: value, clamped: false };
}

export interface PeriodChoice {
  from: string;
  to: string;
  /** A day was moved: after today, or the span was too long. */
  clamped: boolean;
}

/** The period view's default: this week so far. */
export function defaultPeriod(today: string): { from: string; to: string } {
  return { from: startOfWeek(today), to: today };
}

/**
 * `?from=&to=`. A missing day takes the default's, a day after today becomes
 * today, reversed days are swapped, and a span over MAX_PERIOD_DAYS keeps
 * `to` and moves `from`.
 */
export function parsePeriod(
  fromParam: string | undefined | null,
  toParam: string | undefined | null,
  today: string
): PeriodChoice {
  const fallback = defaultPeriod(today);
  let clamped = false;
  let from = isIsoDay(fromParam) ? fromParam : fallback.from;
  let to = isIsoDay(toParam) ? toParam : fallback.to;
  if (from > today) [from, clamped] = [today, true];
  if (to > today) [to, clamped] = [today, true];
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) {
    from = addDays(to, -(MAX_PERIOD_DAYS - 1));
    clamped = true;
  }
  return { from, to, clamped };
}

export interface PeriodPresetChoice {
  label: string;
  from: string;
  to: string;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Quick picks for the period view, all ending no later than today. */
export function periodPresets(today: string): PeriodPresetChoice[] {
  const week = startOfWeek(today);
  const month = monthStart(today);
  const lastMonthEnd = addDays(month, -1);
  return [
    { label: "Denne uge", from: week, to: today },
    { label: "Sidste uge", from: addDays(week, -7), to: addDays(week, -1) },
    { label: "Seneste 4 uger", from: addDays(week, -21), to: today },
    { label: "Denne måned", from: month, to: today },
    { label: "Sidste måned", from: monthStart(lastMonthEnd), to: lastMonthEnd },
  ];
}

/** A station number from the path: a whole number from 0, else null. */
export function parseStationNo(value: string): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/** A path with the given search params, leaving out the empty ones. */
export function hrefWith(path: string, params: Record<string, string | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** The detail page of a station on a day. Today is left out of the URL. */
export function stationHref(
  stationNo: number,
  opts: { day?: string; today?: string; clock?: Clock } = {}
): string {
  const day = opts.day && opts.day !== opts.today ? opts.day : undefined;
  return hrefWith(`/stationer/${stationNo}`, { day, clock: opts.clock });
}
