// One value, two outputs: an Excel cell (a real number or date with a number
// format, so it sorts and sums) and the Danish text of the PDF. Pure.
//
// Times are Europe/Copenhagen (lib/time.ts): the server runs in UTC, so
// nothing here leans on the process time zone. Excel has no time zones, so
// an instant is written as the Copenhagen wall clock.

import { NO_DATA } from "@/lib/reports/format";
import { TIME_ZONE, formatDisplayDay, isIsoDay } from "@/lib/time";
import type { CellValue, ColumnKind } from "./columns";

/** Default column width in characters, by kind. */
export const KIND_WIDTH: Record<ColumnKind, number> = {
  text: 16,
  int: 9,
  decimal: 9,
  percent: 9,
  duration: 10,
  day: 11,
  datetime: 16,
  bool: 7,
};

/** Numbers and dates are right aligned in the PDF. */
export const KIND_ALIGN_RIGHT: Record<ColumnKind, boolean> = {
  text: false,
  int: true,
  decimal: true,
  percent: true,
  duration: true,
  day: false,
  datetime: false,
  bool: false,
};

/** Excel number formats. Excel shows them with the reader's own separators. */
export const KIND_FORMAT: Partial<Record<ColumnKind, string>> = {
  int: "#,##0",
  decimal: "#,##0.0",
  percent: "0%",
  duration: "[h]:mm",
  day: "dd-mm-yyyy",
  datetime: "dd-mm-yyyy hh:mm",
};

const wallClockParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The Copenhagen wall clock of an instant, as numbers. */
function wallClock(iso: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p: Record<string, number> = {};
  for (const part of wallClockParts.formatToParts(ms)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "7:05", "26:40": whole minutes, hours not wrapped at 24. */
export function formatHoursMinutes(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  return `${Math.floor(totalMinutes / 60)}:${pad(totalMinutes % 60)}`;
}

/** "21-10-2026 07:42", Copenhagen time. */
export function formatInstant(iso: string): string {
  const p = wallClock(iso);
  if (!p) return iso;
  return `${pad(p.day)}-${pad(p.month)}-${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

const integer = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const isBlank = (v: CellValue | undefined): v is null | undefined => v == null || v === "";

/** The text of a value in the PDF. Unknown reads "Ingen data endnu", never 0. */
export function cellText(kind: ColumnKind, value: CellValue | undefined): string {
  if (isBlank(value)) return kind === "text" ? "" : NO_DATA;
  switch (kind) {
    case "int":
      return typeof value === "number" ? integer.format(value) : String(value);
    case "decimal":
      return typeof value === "number" ? decimal.format(value) : String(value);
    case "percent":
      return typeof value === "number" ? `${integer.format(Math.round(value))} %` : String(value);
    case "duration":
      return typeof value === "number" ? formatHoursMinutes(value) : String(value);
    case "day":
      return typeof value === "string" && isIsoDay(value) ? formatDisplayDay(value) : String(value);
    case "datetime":
      return typeof value === "string" ? formatInstant(value) : String(value);
    case "bool":
      return value === true ? "Ja" : value === false ? "Nej" : String(value);
    default:
      return String(value);
  }
}

/** An Excel cell: write-excel-file's cell object, or null for an empty cell. */
export interface XlsxCell {
  value: string | number | boolean | Date;
  type: StringConstructor | NumberConstructor | BooleanConstructor | DateConstructor;
  format?: string;
}

/**
 * The Excel cell of a value. Durations become days (Excel's time unit) with
 * [h]:mm, percents become ratios with 0 %, days and instants become dates.
 * Unknown stays an empty cell.
 */
export function xlsxCell(kind: ColumnKind, value: CellValue | undefined): XlsxCell | null {
  if (isBlank(value)) return null;
  const format = KIND_FORMAT[kind];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (kind === "duration") return { value: value / 86_400, type: Number, format };
    if (kind === "percent") return { value: value / 100, type: Number, format };
    if (kind === "int" || kind === "decimal") return { value, type: Number, format };
    return { value, type: Number };
  }
  if (typeof value === "boolean") return { value: value ? "Ja" : "Nej", type: String };
  if (kind === "day" && isIsoDay(value)) {
    return { value: new Date(`${value}T00:00:00Z`), type: Date, format };
  }
  if (kind === "datetime") {
    const p = wallClock(value);
    if (p) return { value: new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)), type: Date, format };
  }
  return { value, type: String };
}
