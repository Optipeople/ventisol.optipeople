// Working time: shifts per ISO weekday and closed days, in Europe/Copenhagen
// wall clock, DST safe. Pure.
//
// A shift block "06:00" to "14:00" is turned into two UTC instants per local
// day, so a day with a clock change simply gets blocks that are an hour
// shorter or longer in real time when they span the change.

import { addDays, dayKey, TIME_ZONE } from "@/lib/time";
import type { ShiftBlock, WorkCalendar } from "./types";

/** Monday to Friday 06:00 to 14:00, as seeded in config.calendar_shifts. Not confirmed by Ventisol. */
export const DEFAULT_CALENDAR: WorkCalendar = {
  shifts: {
    1: [{ start: "06:00", end: "14:00" }],
    2: [{ start: "06:00", end: "14:00" }],
    3: [{ start: "06:00", end: "14:00" }],
    4: [{ start: "06:00", end: "14:00" }],
    5: [{ start: "06:00", end: "14:00" }],
  },
  closedDays: [],
};

/** A calendar where every second counts: working time equals wall clock. */
export const ALWAYS_OPEN: WorkCalendar = {
  shifts: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [{ start: "00:00", end: "24:00" }]])),
  closedDays: [],
};

// Copied from lib/time.ts, where zoneOffset is not exported.
const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Offset of Copenhagen from UTC at `ms`, in milliseconds. */
function zoneOffset(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "06:00" to minutes after local midnight. "24:00" is the end of the day. */
export function parseClock(clock: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim());
  if (!m) throw new Error(`Not a clock time: ${clock}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes < 0 || minutes > 24 * 60) throw new Error(`Not a clock time: ${clock}`);
  return minutes;
}

/**
 * The UTC instant of a Copenhagen wall-clock time on a local day. Two passes,
 * so a time on either side of a clock change is right. A time that does not
 * exist (02:30 on the spring change) lands an hour later.
 */
export function localInstant(isoDay: string, minutes: number): number {
  const [y, m, d] = isoDay.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * 60_000;
  const first = guess - zoneOffset(guess);
  return guess - zoneOffset(first);
}

/** ISO weekday of a yyyy-MM-dd: 1 Monday to 7 Sunday. */
export function isoWeekday(isoDay: string): number {
  return new Date(`${isoDay}T00:00:00Z`).getUTCDay() || 7;
}

/** Monday of ISO week `week` of ISO year `year`. Week 1 holds January 4. */
export function isoWeekMonday(year: number, week: number): string {
  const jan4 = `${year}-01-04`;
  return addDays(addDays(jan4, 1 - isoWeekday(jan4)), (week - 1) * 7);
}

const blockCache = new WeakMap<WorkCalendar, Map<string, [number, number][]>>();

/** The shift blocks of one local day as [start, end) UTC instants, in order, merged where they touch. */
export function shiftBlocksOn(isoDay: string, calendar: WorkCalendar): [number, number][] {
  let perDay = blockCache.get(calendar);
  if (!perDay) {
    perDay = new Map();
    blockCache.set(calendar, perDay);
  }
  const cached = perDay.get(isoDay);
  if (cached) return cached;

  let blocks: [number, number][] = [];
  if (!calendar.closedDays.includes(isoDay)) {
    const shifts: ShiftBlock[] = calendar.shifts[isoWeekday(isoDay)] ?? [];
    blocks = shifts
      .map((s): [number, number] => [localInstant(isoDay, parseClock(s.start)), localInstant(isoDay, parseClock(s.end))])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const b of blocks) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
      else merged.push([b[0], b[1]]);
    }
    blocks = merged;
  }
  perDay.set(isoDay, blocks);
  return blocks;
}

/** Shift time between two instants, in milliseconds. Additive: [a,b) + [b,c) = [a,c). */
export function workingMsBetween(a: number, b: number, calendar: WorkCalendar): number {
  if (!(b > a)) return 0;
  let total = 0;
  const last = dayKey(b);
  for (let day = dayKey(a); day <= last; day = addDays(day, 1)) {
    for (const [s, e] of shiftBlocksOn(day, calendar)) {
      const overlap = Math.min(e, b) - Math.max(s, a);
      if (overlap > 0) total += overlap;
    }
  }
  return total;
}

/** Shift time between two instants, in whole seconds. */
export function workingSecondsBetween(a: number, b: number, calendar: WorkCalendar): number {
  return Math.round(workingMsBetween(a, b, calendar) / 1000);
}

/**
 * The instant at which `seconds` of shift time have passed since `from`.
 * Null when the calendar has no shift within `maxDays` (an empty calendar).
 */
export function addWorkingSeconds(
  from: number,
  seconds: number,
  calendar: WorkCalendar,
  maxDays = 370
): number | null {
  let left = Math.max(0, seconds) * 1000;
  if (left === 0) return from;
  let day = dayKey(from);
  for (let i = 0; i <= maxDays; i++, day = addDays(day, 1)) {
    for (const [s, e] of shiftBlocksOn(day, calendar)) {
      const start = Math.max(s, from);
      if (e <= start) continue;
      if (e - start >= left) return start + left;
      left -= e - start;
    }
  }
  return null;
}
