// Pure helpers of the Ledelse page and the monthly snapshot cron: which month
// the URL asks for, which months are over, and the notes as typed lines.
// Months are "yyyy-MM" in the URL and Europe/Copenhagen calendar months.

import { dayKey } from "@/lib/time";

/** How far back the month picker goes. */
export const MONTHS_BACK = 36;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for "yyyy-MM" with a real month. */
export function isMonth(value: string | undefined | null): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** The month `months` after (or before) `month`, both "yyyy-MM". */
export function shiftMonth(month: string, months: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 7);
}

/** The Copenhagen calendar month of an instant, "yyyy-MM". */
export function currentMonth(now: number): string {
  return dayKey(now).slice(0, 7);
}

/** The last full month: what the page shows without a month in the URL, and what the cron freezes. */
export function lastFullMonth(now: number): string {
  return shiftMonth(currentMonth(now), -1);
}

/** The earliest month the picker offers. */
export function earliestMonth(now: number): string {
  return shiftMonth(currentMonth(now), -MONTHS_BACK);
}

/** True when the month has ended in Copenhagen time, so it can be frozen. */
export function isMonthOver(month: string, now: number): boolean {
  return month < currentMonth(now);
}

/**
 * The month of the `maaned` search param. Missing or malformed: the last full
 * month. Later than the current month or earlier than the picker reaches: the
 * nearest month it reaches, with `clamped`.
 */
export function parseMonthParam(
  value: string | string[] | undefined,
  now: number
): { month: string; clamped: boolean } {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!isMonth(raw)) return { month: lastFullMonth(now), clamped: raw !== undefined && raw !== "" };
  const latest = currentMonth(now);
  const earliest = earliestMonth(now);
  if (raw > latest) return { month: latest, clamped: true };
  if (raw < earliest) return { month: earliest, clamped: true };
  return { month: raw, clamped: false };
}

/** Every month the picker offers, newest first. */
export function monthChoices(now: number): string[] {
  const out: string[] = [];
  for (let m = currentMonth(now), end = earliestMonth(now); m >= end; m = shiftMonth(m, -1)) out.push(m);
  return out;
}

export type Clock = "working" | "wall";

/** The `clock` search param (as on Overblik), or undefined for the setting's clock. */
export function parseClockParam(value: string | string[] | undefined): Clock | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "working" || raw === "wall" ? raw : undefined;
}

/**
 * The URL of the page for a month and clock. The last full month is left
 * out of the URL, and so is a clock that is not given.
 */
export function monthHref(month: string, now: number, clock?: Clock): string {
  const search = new URLSearchParams();
  if (month !== lastFullMonth(now)) search.set("maaned", month);
  if (clock) search.set("clock", clock);
  const q = search.toString();
  return q ? `/ledelse?${q}` : "/ledelse";
}

/** The lines limit of rpt.management_notes (lib/reports saveNotesParams). */
export const MAX_NOTE_LINES = 20;
export const MAX_NOTE_LENGTH = 1000;

/**
 * Notes typed one per line as the lines saveManagementNotes takes: trimmed,
 * empty lines and leading bullet marks dropped.
 */
export function noteLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);
}

/** Why the lines cannot be saved, in Danish, or null when they can. */
export function noteLinesProblem(lines: string[]): string | null {
  if (lines.length > MAX_NOTE_LINES) return `Højst ${MAX_NOTE_LINES} punkter.`;
  if (lines.some((line) => line.length > MAX_NOTE_LENGTH)) return `Højst ${MAX_NOTE_LENGTH} tegn pr. punkt.`;
  return null;
}
