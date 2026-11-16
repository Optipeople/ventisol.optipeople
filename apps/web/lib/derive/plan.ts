// What to recompute when scans arrive. Pure.
//
// The writer (lib/sync, built next) keeps core.* right in these steps; the
// full recipe is in docs/read-model.md, "Keeping core.* right".

import type { Scan } from "@/lib/scans";
import { addDays, dayKey, MS_PER_DAY } from "@/lib/time";
import type { LocalDay, OrderRow, StationIntervalRow } from "./types";

export interface StationDay {
  stationNo: number;
  localDay: LocalDay;
}

export interface Affected {
  /** Orders whose rows must be rebuilt from their whole scan history. */
  orderNos: number[];
  /**
   * Station days the new scans themselves touch. A first cut: after the
   * orders are rebuilt, add stationDaysTouched(old rows, new rows).
   */
  stationDays: StationDay[];
}

/** A pass longer than this is not walked day by day (a guard, not a rule). */
const MAX_SPAN_DAYS = 62;

function addSpan(into: Map<string, StationDay>, stationNo: number, fromMs: number, toMs: number) {
  const last = dayKey(toMs);
  let day = dayKey(Math.max(fromMs, toMs - MAX_SPAN_DAYS * MS_PER_DAY));
  for (; day <= last; day = addDays(day, 1)) into.set(`${stationNo}:${day}`, { stationNo, localDay: day });
}

function sorted(map: Map<string, StationDay>): StationDay[] {
  return [...map.values()].sort((a, b) => a.stationNo - b.stationNo || a.localDay.localeCompare(b.localDay));
}

/**
 * From new (or late, or changed) scans: the orders to rebuild and the station
 * days the scans fall on. Goes by ScanTime, not arrival, so a scan sent late
 * with an old time names the old day. An Out with DurationSec also names the
 * days back to its start.
 */
export function affectedBy(newScans: Scan[]): Affected {
  const orders = new Set<number>();
  const days = new Map<string, StationDay>();
  for (const s of newScans) {
    orders.add(s.orderNo);
    const from = s.direction === "Out" && s.durationSec != null ? s.time - s.durationSec * 1000 : s.time;
    addSpan(days, s.stationNo ?? 0, from, s.time);
  }
  return { orderNos: [...orders].sort((a, b) => a - b), stationDays: sorted(days) };
}

/**
 * Every station day the given interval rows lie on: from the day a pass
 * started to the day it ended (to `now` while open; the start day only for a
 * missing scan-out). Call it with an order's rows before AND after a rebuild:
 * a pass that moved, shrank or vanished changes the days it used to lie on.
 */
export function stationDaysTouched(rows: StationIntervalRow[], now: number): StationDay[] {
  const days = new Map<string, StationDay>();
  for (const r of rows) {
    const start = Date.parse(r.startAt);
    const end = r.endAt != null ? Date.parse(r.endAt) : r.status === "open" ? Math.max(start, now) : start;
    addSpan(days, r.stationNo, start, end);
  }
  return sorted(days);
}

/** The union of several station-day lists, each pair once. */
export function mergeStationDays(...lists: StationDay[][]): StationDay[] {
  const days = new Map<string, StationDay>();
  for (const list of lists) for (const d of list) days.set(`${d.stationNo}:${d.localDay}`, d);
  return sorted(days);
}

/**
 * An order in progress carries figures that move with the clock (time so far,
 * current step, open passes going stale, the forecast). True when its rows
 * should be rebuilt on this run even with no new scan: while it is in
 * progress and was scanned within `maxQuietDays`. Older ones only change
 * again when a scan arrives.
 */
export function needsClockRefresh(
  order: Pick<OrderRow, "status" | "lastScanAt">,
  now: number,
  maxQuietDays = 14
): boolean {
  return order.status === "in_progress" && now - Date.parse(order.lastScanAt) <= maxQuietDays * MS_PER_DAY;
}
