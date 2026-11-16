// Danish formatters shared by the report pages and the chat, so the same
// number reads the same everywhere. Pure. Input is what lib/reports returns:
// whole seconds, percents as numbers, days as yyyy-MM-dd, instants as ISO.
//
// A null always reads NO_DATA ("Ingen data endnu"), never 0.

import { TIME_ZONE, isoWeek } from "@/lib/time";

export const NO_DATA = "Ingen data endnu";

/** U+2212, the real minus sign, as the deck uses. */
const MINUS = "−";
const PLUS_MINUS = "±";

const isNumber = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * A duration as the deck shows it: "11 t 20 min", "1 t 00 min", "55 min",
 * "45 s". Rounded to whole minutes from one minute up.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return NO_DATA;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return `${hours} t ${String(minutes % 60).padStart(2, "0")} min`;
}

const oneDecimal = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 1 });

/**
 * A time per piece: "4,5 min", "9 min", "14 min". Below an hour in minutes
 * with at most one decimal, from an hour up as formatDuration.
 */
export function formatMinutes(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return NO_DATA;
  if (seconds >= 3600) return formatDuration(seconds);
  const minutes = Math.max(0, seconds) / 60;
  return `${oneDecimal.format(minutes >= 10 ? Math.round(minutes) : Math.round(minutes * 10) / 10)} min`;
}

const integer = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });

/** "94 %". */
export function formatPercent(percent: number | null | undefined): string {
  if (!isNumber(percent)) return NO_DATA;
  return `${integer.format(Math.round(percent))} %`;
}

function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return `${PLUS_MINUS}0`;
  return `${rounded < 0 ? MINUS : "+"}${integer.format(Math.abs(rounded))}`;
}

/** A change in percent: "−6 %", "+8 %", "±0 %". */
export function formatSignedPercent(percent: number | null | undefined): string {
  if (!isNumber(percent)) return NO_DATA;
  return `${signed(percent)} %`;
}

/** A change in percentage points: "+3 point", "−2 point". */
export function formatPoints(points: number | null | undefined): string {
  if (!isNumber(points)) return NO_DATA;
  return `${signed(points)} point`;
}

/** "186", "1.204". */
export function formatNumber(n: number | null | undefined): string {
  if (!isNumber(n)) return NO_DATA;
  return integer.format(n);
}

/** "1 element", "12 elementer". */
export function formatCount(n: number | null | undefined, singular: string, plural: string): string {
  if (!isNumber(n)) return NO_DATA;
  return `${integer.format(n)} ${n === 1 ? singular : plural}`;
}

/** "Station 10", "Station 10 og Pakning", "Buffer, Station 30 og Montagebord 2". */
export function joinDanish(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} og ${items[items.length - 1]}`;
}

/** The ISO week number of a day, as the chart axis shows it: "43". */
export function weekLabel(day: string): string {
  return String(isoWeek(day));
}

/** "Uge 43". */
export function weekTitle(day: string): string {
  return `Uge ${isoWeek(day)}`;
}

const monthShort = new Intl.DateTimeFormat("da-DK", { timeZone: "UTC", month: "short" });
const monthLong = new Intl.DateTimeFormat("da-DK", { timeZone: "UTC", month: "long", year: "numeric" });

/** "okt." for any day of October. */
export function monthLabel(day: string): string {
  return monthShort.format(new Date(`${day.slice(0, 7)}-01T00:00:00Z`));
}

/** "oktober 2026". */
export function monthTitle(day: string): string {
  return monthLong.format(new Date(`${day.slice(0, 7)}-01T00:00:00Z`));
}

const dayMonthParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekdayShort = new Intl.DateTimeFormat("da-DK", { timeZone: TIME_ZONE, weekday: "short" });

function parts(iso: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of dayMonthParts.formatToParts(new Date(iso))) out[p.type] = p.value;
  return out;
}

/** An instant as the order tables show it, Copenhagen time: "15.9 kl. 06:00". */
export function formatDayTime(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const p = parts(iso);
  return `${Number(p.day)}.${Number(p.month)} kl. ${p.hour}:${p.minute}`;
}

/** A forecast, Copenhagen time: "fre. kl. 14", or "fre. kl. 14:30" off the hour. */
export function formatForecast(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const p = parts(iso);
  const weekday = weekdayShort.format(new Date(iso)).replace(/\.?$/, ".");
  return `${weekday} kl. ${Number(p.hour)}${p.minute === "00" ? "" : `:${p.minute}`}`;
}
