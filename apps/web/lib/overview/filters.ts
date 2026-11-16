// The Overblik filters as they live in the URL: the period (from, to), the
// clock (working or wall) and the chart bucket (week or month). Pure: "today"
// comes in as a Copenhagen day, nothing here reads the clock.

import type { Clock } from "@/lib/reports";
import { addDays, daysBetween, isIsoDay, startOfWeek } from "@/lib/time";

export type PresetId = "last4weeks" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";
export type Bucket = "week" | "month";

export interface PeriodPresetDef {
  id: PresetId;
  label: string;
  from: string;
  to: string;
}

export interface OverviewFilters {
  from: string;
  to: string;
  /** The preset the period matches, or "custom". */
  preset: PresetId | "custom";
  /** Undefined: the report setting decides (deduct_off_shift). */
  clock: Clock | undefined;
  bucket: Bucket;
  /** True when the bucket came from the URL, not from the period length. */
  bucketChosen: boolean;
  /** Why the period in the URL was not used as it stood, in Danish. Null when it was. */
  correction: string | null;
}

/** The longest period the page shows: two years. */
export const MAX_PERIOD_DAYS = 731;
/** Up to this many days the chart defaults to weeks, above it to months. */
export const WEEK_BUCKET_MAX_DAYS = 126;

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The last day of the month before the one `day` is in. */
function endOfPreviousMonth(day: string): string {
  return addDays(monthStart(day), -1);
}

/** The presets, newest first in the order the filter shows them. Periods end today at the latest. */
export function periodPresets(today: string): PeriodPresetDef[] {
  const monday = startOfWeek(today);
  const lastMonthEnd = endOfPreviousMonth(today);
  return [
    { id: "last4weeks", label: "Seneste 4 uger", from: addDays(monday, -21), to: today },
    { id: "thisWeek", label: "Denne uge", from: monday, to: today },
    { id: "lastWeek", label: "Sidste uge", from: addDays(monday, -7), to: addDays(monday, -1) },
    { id: "thisMonth", label: "Denne måned", from: monthStart(today), to: today },
    { id: "lastMonth", label: "Sidste måned", from: monthStart(lastMonthEnd), to: lastMonthEnd },
  ];
}

/** The period the page shows when the URL has none: the last four ISO weeks up to today. */
export function defaultPeriod(today: string): { from: string; to: string } {
  const { from, to } = periodPresets(today)[0];
  return { from, to };
}

export function defaultBucket(from: string, to: string): Bucket {
  return daysBetween(from, to) + 1 > WEEK_BUCKET_MAX_DAYS ? "month" : "week";
}

type Param = string | string[] | undefined;

const one = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Reads the filters from the search params. Anything unreadable falls back:
 * a missing or broken day gives the default period, reversed days swap, a
 * day after today becomes today, and a period longer than two years is cut
 * from the start.
 */
export function parseOverviewFilters(
  params: Record<string, Param>,
  today: string
): OverviewFilters {
  const rawFrom = one(params.from);
  const rawTo = one(params.to);
  const notes: string[] = [];

  let from: string;
  let to: string;
  if (isIsoDay(rawFrom) && isIsoDay(rawTo)) {
    from = rawFrom;
    to = rawTo;
  } else {
    ({ from, to } = defaultPeriod(today));
    if (rawFrom || rawTo) notes.push("Perioden kunne ikke læses, så de seneste 4 uger vises.");
  }
  if (from > to) [from, to] = [to, from];
  if (to > today) {
    to = today;
    if (from > today) from = today;
    notes.push("Perioden sluttede efter i dag og er rettet til i dag.");
  }
  if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) {
    from = addDays(to, -(MAX_PERIOD_DAYS - 1));
    notes.push("Der kan vises højst to år ad gangen. Starten er rykket frem.");
  }

  const rawClock = one(params.clock);
  const clock: Clock | undefined = rawClock === "working" || rawClock === "wall" ? rawClock : undefined;

  const rawBucket = one(params.bucket);
  const bucketChosen = rawBucket === "week" || rawBucket === "month";
  const bucket: Bucket = bucketChosen ? (rawBucket as Bucket) : defaultBucket(from, to);

  const match = periodPresets(today).find((p) => p.from === from && p.to === to);

  return {
    from,
    to,
    preset: match?.id ?? "custom",
    clock,
    bucket,
    bucketChosen,
    correction: notes.length > 0 ? notes.join(" ") : null,
  };
}

/** The search params that carry the filters to another page or back to this one. Leaves out what is default. */
export function filterQuery(
  f: { from: string; to: string; clock?: Clock; bucket?: Bucket },
  extra: Record<string, string | undefined> = {}
): string {
  const search = new URLSearchParams();
  search.set("from", f.from);
  search.set("to", f.to);
  if (f.clock) search.set("clock", f.clock);
  if (f.bucket) search.set("bucket", f.bucket);
  for (const [key, value] of Object.entries(extra)) if (value) search.set(key, value);
  return search.toString();
}

export function filterHref(
  path: string,
  f: { from: string; to: string; clock?: Clock; bucket?: Bucket },
  extra?: Record<string, string | undefined>
): string {
  return `${path}?${filterQuery(f, extra)}`;
}

/** "20.10.2026", the day as the period line shows it. */
export function formatPeriodDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

/** "20.10.2026 til 16.11.2026", or one day when from equals to. */
export function formatPeriod(from: string, to: string): string {
  return from === to ? formatPeriodDay(from) : `${formatPeriodDay(from)} til ${formatPeriodDay(to)}`;
}

/**
 * Whether a change is good news. Lead and waiting time: down is good.
 * Orders packed and on time: up is good. Null when there is no change or no
 * data, so the tile stays neutral.
 */
export function changeTone(value: number | null, lowerIsBetter: boolean): "good" | "bad" | null {
  if (value == null || Math.round(value) === 0) return null;
  return (value < 0) === lowerIsBetter ? "good" : "bad";
}
