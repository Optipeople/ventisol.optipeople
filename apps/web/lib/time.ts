// Calendar days and display formats. Ventisol works on Danish local time, so
// a "day" is a Europe/Copenhagen calendar day, while scans are stored as UTC
// instants (ScanTime). The server runs in UTC on Vercel, so nothing here may
// lean on the process time zone.

export const TIME_ZONE = "Europe/Copenhagen";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

function zonedParts(ms: number) {
  const parts: Record<string, number> = {};
  for (const p of partsFormat.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Offset of Copenhagen from UTC at `ms`, in milliseconds (+1 h or +2 h). */
function zoneOffset(ms: number): number {
  const p = zonedParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The Copenhagen calendar day an instant falls on, as yyyy-MM-dd. */
export function dayKey(ms: number): string {
  const p = zonedParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function isIsoDay(value: string | undefined | null): value is string {
  if (!value) return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Midnight Copenhagen time at the start of `isoDay`, as a UTC instant. */
export function dayStart(isoDay: string): number {
  const m = ISO_DATE_RE.exec(isoDay);
  if (!m) throw new Error(`Not a day: ${isoDay}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Two passes so a day that starts on one side of a DST switch is right.
  const first = guess - zoneOffset(guess);
  return guess - zoneOffset(first);
}

/** Start of the day after `isoDay` (days are 23, 24 or 25 hours long). */
export function dayEnd(isoDay: string): number {
  return dayStart(addDays(isoDay, 1));
}

/** Calendar arithmetic on yyyy-MM-dd strings. */
export function addDays(isoDay: string, days: number): string {
  const m = ISO_DATE_RE.exec(isoDay);
  if (!m) throw new Error(`Not a day: ${isoDay}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (yyyy-MM-dd), e.g. 0 for the same day. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** Monday of the ISO week containing `isoDay`. */
export function startOfWeek(isoDay: string): string {
  const dow = new Date(`${isoDay}T00:00:00Z`).getUTCDay() || 7;
  return addDays(isoDay, 1 - dow);
}

/** ISO 8601 week number of `isoDay`. */
export function isoWeek(isoDay: string): number {
  const thursday = addDays(startOfWeek(isoDay), 3);
  const jan1 = Date.UTC(Number(thursday.slice(0, 4)), 0, 1);
  return Math.floor((Date.parse(`${thursday}T00:00:00Z`) - jan1) / MS_PER_DAY / 7) + 1;
}

const clockFormat = new Intl.DateTimeFormat("da-DK", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateTimeFormat = new Intl.DateTimeFormat("da-DK", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const longDayFormat = new Intl.DateTimeFormat("da-DK", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const shortDayFormat = new Intl.DateTimeFormat("da-DK", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** 07:42, Copenhagen time. */
export function formatClock(ms: number): string {
  return clockFormat.format(ms).replace(".", ":");
}

/** 21. okt. 07:42, Copenhagen time. */
export function formatDateTime(ms: number): string {
  return dateTimeFormat.format(ms).replace(/(\d{2})\.(\d{2})$/, "$1:$2");
}

/** Today's date as shown when the time alone would be ambiguous: same day → clock, else date + clock. */
export function formatScanTime(ms: number, referenceDay?: string): string {
  return referenceDay && dayKey(ms) === referenceDay ? formatClock(ms) : formatDateTime(ms);
}

/** "tirsdag 21. oktober 2026" for a yyyy-MM-dd. */
export function formatLongDay(isoDay: string): string {
  return longDayFormat.format(new Date(`${isoDay}T00:00:00Z`));
}

/** "tir. 21. okt." for a yyyy-MM-dd. */
export function formatShortDay(isoDay: string): string {
  return shortDayFormat.format(new Date(`${isoDay}T00:00:00Z`));
}

/** 21-10-2026 for a yyyy-MM-dd. */
export function formatDisplayDay(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * A duration as people on the floor say it: "45 s", "6 min 12 s",
 * "38 min", "3 t 07 min". Seconds only while they still matter.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  if (hours > 0) return `${hours} t ${String(minutes).padStart(2, "0")} min`;
  const seconds = totalSeconds % 60;
  return minutes >= 10 || seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

const percentFormat = new Intl.NumberFormat("da-DK", {
  style: "percent",
  maximumFractionDigits: 0,
});

export function formatPercent(ratio: number): string {
  return percentFormat.format(ratio);
}

const integerFormat = new Intl.NumberFormat("da-DK");

export function formatInt(n: number): string {
  return integerFormat.format(n);
}

/** "tirsdag" -> "Tirsdag", for a date that opens a sentence. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The moment a request is answered. Server components are rendered once per
 * request, so reading the clock there is intended: "now" is what in-progress
 * elements count up to.
 */
export function requestTime(): number {
  return Date.now();
}
