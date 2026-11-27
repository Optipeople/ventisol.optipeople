// The scan rows of the VentisolScans master-data table (docs/opticloud-scans.md)
// and how one raw row becomes a typed Scan. Pure: no I/O.

export const SCAN_TABLE_NAME = "VentisolScans";

/**
 * In and Out pair. Mark carries no time and never pairs: it closes a pause
 * (docs/opticloud-scans.md, Events). Old rows have only In and Out.
 */
export type Direction = "In" | "Out" | "Mark";

/**
 * Why a row was written (the Event column, docs/plan-scan-commands.md §6.1).
 * An empty or unknown value reads as Scan, as in the station app.
 */
export type ScanEventKind = "Scan" | "Pause" | "Resume" | "Hold" | "CheckedOut" | "Undo" | "ShiftEnd";

const EVENT_KINDS: readonly ScanEventKind[] = ["Scan", "Pause", "Resume", "Hold", "CheckedOut", "Undo", "ShiftEnd"];

/** The Event column to a kind: case-insensitive, empty or unknown is Scan. */
export function parseScanEvent(v: unknown): ScanEventKind {
  const s = v == null ? "" : String(v).trim().toLowerCase();
  return EVENT_KINDS.find((k) => k.toLowerCase() === s) ?? "Scan";
}

/**
 * How a pass ended, as core.station_intervals.end_event stores it: the Event
 * of the row that closed it in snake case, null for an ordinary scan.
 */
export type EndEvent = "pause" | "resume" | "hold" | "checked_out" | "undo" | "shift_end";

const END_EVENTS: Record<Exclude<ScanEventKind, "Scan">, EndEvent> = {
  Pause: "pause",
  Resume: "resume",
  Hold: "hold",
  CheckedOut: "checked_out",
  Undo: "undo",
  ShiftEnd: "shift_end",
};

export function toEndEvent(event: ScanEventKind | undefined): EndEvent | null {
  return event == null || event === "Scan" ? null : END_EVENTS[event];
}

export interface Scan {
  /** ScanId (uuid from the station app); falls back to the row id. */
  id: string;
  barcode: string;
  orderNo: number;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  station: string;
  stationNo: number | null;
  /** "Assembly" or "Packing". */
  stationKind: string;
  direction: Direction;
  /** ScanTime as epoch milliseconds (UTC). */
  time: number;
  /** On Out: seconds since the matching In, as the station app measured it. */
  durationSec: number | null;
  device: string | null;
  /** The Event column. Left out means Scan. */
  event?: ScanEventKind;
}

/** One row as GetRowsPaged returns it. */
export interface MasterDataRow {
  id: string;
  createdDate?: string | null;
  values: Record<string, unknown>;
}

/**
 * Reads a value by column name. The API may camelCase the keys
 * ("scanTime" for column "ScanTime"), so names match case-insensitively.
 */
export function getValue(values: Record<string, unknown>, column: string): unknown {
  if (column in values) return values[column];
  const target = column.toLowerCase();
  for (const [key, value] of Object.entries(values)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function asInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * ScanTime is UTC ISO 8601. A value without a zone designator is still UTC
 * (the station writes UTC, and some serializers drop the Z).
 */
export function parseScanTime(v: unknown): number | null {
  const s = asString(v);
  if (!s) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export interface BarcodeParts {
  orderNo: number;
  position: number;
  subPosition: number;
  piece: number;
}

/**
 * 0 58556 05 01 03: leading 0, order (5), position (2), sub-position (2),
 * piece (2). Longer codes (the 14-digit Schirmer form) keep the same start.
 * A short order (4 digits or fewer) is padded with 0s: 0 02634 01 03 01 is order 2634.
 */
export function parseBarcode(barcode: string): BarcodeParts | null {
  const digits = barcode.trim();
  if (!/^\d{12,}$/.test(digits)) return null;
  return {
    orderNo: Number(digits.slice(1, 6)),
    position: Number(digits.slice(6, 8)),
    subPosition: Number(digits.slice(8, 10)),
    piece: Number(digits.slice(10, 12)),
  };
}

/**
 * "Pos. 5" or "Pos. 5.1". Sub-position 01 is the position itself (as on the
 * label), so SubPosition 2 is ".1", 3 is ".2" and so on.
 */
export function positionLabel(position: number | null, subPosition: number | null): string {
  if (position == null) return "–";
  if (subPosition == null || subPosition <= 1) return `Pos. ${position}`;
  return `Pos. ${position}.${subPosition - 1}`;
}

export function isPacking(scan: Pick<Scan, "stationKind">): boolean {
  return scan.stationKind.toLowerCase() === "packing";
}

/**
 * One raw row to a Scan, or null when it lacks what a scan needs (barcode,
 * station, direction, time, order). Order and position fall back to the
 * barcode when the columns are empty.
 */
export function parseScanRow(row: MasterDataRow): Scan | null {
  const v = row.values ?? {};
  const barcode = asString(getValue(v, "Barcode"));
  const station = asString(getValue(v, "Station"));
  const directionRaw = asString(getValue(v, "Direction"))?.toLowerCase();
  const time = parseScanTime(getValue(v, "ScanTime"));
  if (!barcode || !station || time == null) return null;
  const direction: Direction | null =
    directionRaw === "in" ? "In" : directionRaw === "out" ? "Out" : directionRaw === "mark" ? "Mark" : null;
  if (!direction) return null;

  const fromCode = parseBarcode(barcode);
  const orderNo = asInt(getValue(v, "OrderNo")) ?? fromCode?.orderNo ?? null;
  if (orderNo == null) return null;

  const duration = asInt(getValue(v, "DurationSec"));
  return {
    id: asString(getValue(v, "ScanId")) ?? row.id,
    barcode,
    orderNo,
    position: asInt(getValue(v, "Position")) ?? fromCode?.position ?? null,
    subPosition: asInt(getValue(v, "SubPosition")) ?? fromCode?.subPosition ?? null,
    piece: asInt(getValue(v, "Piece")) ?? fromCode?.piece ?? null,
    station,
    stationNo: asInt(getValue(v, "StationNo")),
    stationKind: asString(getValue(v, "StationKind")) ?? "Assembly",
    direction,
    time,
    durationSec: duration != null && duration >= 0 ? duration : null,
    device: asString(getValue(v, "Device")),
    ...eventField(getValue(v, "Event")),
  };
}

/** `{ event }` unless it is Scan, so an ordinary row looks as it did before the column. */
export function eventField(v: unknown): { event?: ScanEventKind } {
  const event = parseScanEvent(v);
  return event === "Scan" ? {} : { event };
}
