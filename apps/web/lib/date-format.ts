/**
 * Date display format for the UI: dd-MM-yyyy.
 *
 * The app stores and transports dates as ISO yyyy-MM-dd (URL params, API
 * calls, report filenames). Only what the user reads and types is dd-MM-yyyy,
 * the everyday Danish/EU convention. This replaces the native
 * <input type="date">, whose rendering follows the *browser's* locale — a
 * Danish operator on an English Windows install was shown 09/14/2026.
 *
 * All arithmetic runs in UTC so a DST boundary can never shift a day.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Earliest year we accept from typed input — guards against half-typed years. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

/** Parses yyyy-MM-dd into a UTC-midnight Date, or null if it is not a real date. */
export function isoToDate(iso: string): Date | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  return makeDate(Number(y), Number(mo), Number(d));
}

/** Builds a UTC-midnight Date, rejecting non-existent dates like 31-02. */
export function makeDate(year: number, month: number, day: number): Date | null {
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31-02 over into March, so round-trip to catch it.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function dateToIso(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isIsoDate(value: string): boolean {
  return isoToDate(value) !== null;
}

/** yyyy-MM-dd → dd-MM-yyyy. Returns "" for anything unparseable. */
export function formatDisplayDate(iso: string): string {
  const m = ISO_RE.exec(iso);
  if (!m || !isoToDate(iso)) return "";
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
}

/**
 * Reads what the user typed and returns yyyy-MM-dd, or null.
 *
 * Deliberately forgiving, because operators paste and type dates in every
 * shape they meet elsewhere in the business:
 *   14-09-2026  14.09.2026  14/09/2026  14 09 2026  14092026  140926
 *   2026-09-14  (ISO, e.g. copied out of the URL)
 */
export function parseDisplayDate(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  const digitsOnly = /^\d+$/.test(text);
  if (digitsOnly) {
    if (text.length === 8) {
      // ddMMyyyy — but accept yyyyMMdd too when ddMMyyyy cannot be real.
      return (
        fromParts(text.slice(4), text.slice(2, 4), text.slice(0, 2)) ??
        fromParts(text.slice(0, 4), text.slice(4, 6), text.slice(6))
      );
    }
    if (text.length === 6) return fromParts(text.slice(4), text.slice(2, 4), text.slice(0, 2));
    return null;
  }

  const parts = text.split(/[-./\s]+/).filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  // A 4-digit leading group means it was written ISO-first.
  return parts[0].length === 4
    ? fromParts(parts[0], parts[1], parts[2])
    : fromParts(parts[2], parts[1], parts[0]);
}

function fromParts(year: string, month: string, day: string): string | null {
  if (year.length !== 2 && year.length !== 4) return null;
  if (month.length > 2 || day.length > 2) return null;
  // Two-digit years are always this century: this app reports on recent shifts.
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const date = makeDate(y, Number(month), Number(day));
  return date ? dateToIso(date) : null;
}

/**
 * Progressive dd-MM-yyyy mask. Groups bare digits with dashes as they are
 * typed, but leaves anything containing another separator alone so a pasted
 * "2026-09-14" or "14.09.2026" survives to parseDisplayDate.
 */
export function maskDateInput(raw: string): string {
  if (!/^[\d-]*$/.test(raw)) return raw;
  // A 4-digit leading group means an ISO paste — never reachable by typing
  // through the mask, which breaks after two digits.
  if (/^\d{4}-/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  let out = digits.slice(0, 2);
  // Only join a separator when digits follow it, so backspace can delete past it.
  if (digits.length > 2) out += `-${digits.slice(2, 4)}`;
  if (digits.length > 4) out += `-${digits.slice(4, 8)}`;
  return out;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Adds whole months, clamping the day to the end of the target month. */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const day = Math.min(date.getUTCDate(), daysInMonth(y, m));
  return new Date(Date.UTC(y, m, day));
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Monday of the week containing `date`. Danish weeks start on Monday. */
export function startOfIsoWeek(date: Date): Date {
  const dow = date.getUTCDay() || 7;
  return addDays(date, 1 - dow);
}

/**
 * ISO 8601 week number. Danish production planning runs on week numbers, so
 * the calendar shows them as a leading column.
 */
export function isoWeekNumber(date: Date): number {
  // The Thursday of this week decides which year (and week) the week belongs to.
  const thursday = addDays(startOfIsoWeek(date), 3);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / MS_PER_DAY / 7) + 1;
}

/** Today as a UTC-midnight Date, taken from the viewer's local calendar day. */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
