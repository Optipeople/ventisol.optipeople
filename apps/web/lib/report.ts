// Time per order, worked out from the raw In/Out scans. Pure functions, no
// I/O, so every rule here is unit tested (lib/report.test.ts).
//
// The rules (docs/opticloud-scans.md, "Rules"):
//   - An element is worked on at a station from its In to its Out there. A
//     station is its StationNo, not its name (names can be edited).
//   - Time per order is the sum over its elements and stations. A re-scan for
//     rework is just another In/Out pair, so it adds time.
//   - A second In of the same element at the same station while one is open:
//     the later In wins.
//   - An Out with no In: its start is put back from DurationSec, or it is
//     skipped when there is none.
//   - No order is called packed or done: without the order's element count the
//     scans can't tell that. An order is active while something on it is in
//     progress, else idle.
//   - An element still in progress counts up to "now"; an In older than
//     36 hours with no Out is ignored.
//
// These mirror DayReport in the station app (apps/station), so the reports
// site and the operators' screen agree on the numbers.

import { dayKey } from "@/lib/time";
import { isPacking, type Scan } from "@/lib/scans";

/**
 * An In with no Out for longer than this is treated as abandoned (a missed
 * Out scan) and does not count, rather than letting one forgotten scan add
 * days to an order. 36 hours, as in the station app: long enough for an
 * element left overnight to still be in progress the next working day.
 */
export const STALE_OPEN_MS = 36 * 3_600_000;

/** One element at one station: from its In to its Out (or to now). */
export interface WorkInterval {
  barcode: string;
  orderNo: number;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  station: string;
  stationNo: number | null;
  stationKind: string;
  start: number;
  end: number;
  durationMs: number;
  /** No Out yet: the interval runs to now. */
  inProgress: boolean;
  /**
   * No In in the data (it fell before the period read): the start was put
   * back from the Out's DurationSec.
   */
  startEstimated: boolean;
  /**
   * 1 for the element's first pass at this station, 2+ for rework passes.
   * Counted over the scans that were read: a first pass that fell before the
   * period read is not seen, so the rework after it reads as 1.
   */
  visit: number;
}

type StationRef = Pick<Scan, "station" | "stationNo">;

/**
 * Which station a scan or interval belongs to: its StationNo, as the station
 * app pairs them. Only a row without a StationNo falls back to the name.
 */
export function stationKey(s: StationRef): string {
  return s.stationNo != null ? `#${s.stationNo}` : `name:${s.station}`;
}

const keyOf = (s: Pick<Scan, "barcode"> & StationRef) => `${s.barcode}\u0000${stationKey(s)}`;

/** Drops repeats of the same ScanId (sending a scan twice is harmless). */
export function dedupeScans(scans: Scan[]): Scan[] {
  const seen = new Set<string>();
  const out: Scan[] = [];
  for (const s of scans) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Chronological, In before Out on a tie so a zero-length pass still pairs. */
function byTime(a: Scan, b: Scan): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.direction === b.direction) return 0;
  return a.direction === "In" ? -1 : 1;
}

/** "Max i gang" per station number. A station not listed has 1. */
export type MaxOpen = Readonly<Record<number, number>>;

/** A station's "Max i gang": at least 1, 1 when not set or without a station number. */
export function maxOpenAt(maxOpen: MaxOpen | undefined, stationNo: number | null): number {
  const n = stationNo != null ? maxOpen?.[stationNo] : undefined;
  return n != null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Of these open Ins, the ones in progress: per station the latest, as many as
 * its "Max i gang". On a tie in time the one handed in first is kept (the
 * sort is stable), as before there was a max.
 */
export function latestOpenPerStation<T extends Scan>(opens: T[], maxOpen: MaxOpen = {}): Set<T> {
  const byStation = new Map<string, T[]>();
  for (const scan of opens) {
    const key = stationKey(scan);
    const list = byStation.get(key);
    if (list) list.push(scan);
    else byStation.set(key, [scan]);
  }
  const kept = new Set<T>();
  for (const list of byStation.values()) {
    list.sort((a, b) => b.time - a.time);
    for (const scan of list.slice(0, maxOpenAt(maxOpen, list[0].stationNo))) kept.add(scan);
  }
  return kept;
}

function interval(open: Scan, start: number, end: number, extra: Partial<WorkInterval>): WorkInterval {
  return {
    barcode: open.barcode,
    orderNo: open.orderNo,
    position: open.position,
    subPosition: open.subPosition,
    piece: open.piece,
    station: open.station,
    stationNo: open.stationNo,
    stationKind: open.stationKind,
    start,
    end,
    durationMs: Math.max(0, end - start),
    inProgress: false,
    startEstimated: false,
    visit: 1,
    ...extra,
  };
}

/**
 * Pairs In and Out per station (StationNo) and barcode.
 *
 * - In then Out: one interval.
 * - A second In while one is open: the later In wins. The earlier one never
 *   got its Out (a missed scan, not parallel work), so it is dropped.
 * - An Out with no open In: its In fell before the period read, so the start
 *   is put back from DurationSec. Without DurationSec it cannot be timed and
 *   is skipped.
 * - An In still open at the end: in progress, counting up to `now`, unless it
 *   is older than STALE_OPEN_MS. As many per station as its "Max i gang"
 *   (`maxOpen`, by station number; 1 when not given): when more elements are
 *   open at one station, only the latest Ins are in progress.
 */
export function pairScans(scans: Scan[], now: number, maxOpen: MaxOpen = {}): WorkInterval[] {
  const sorted = dedupeScans(scans).sort(byTime);
  const open = new Map<string, Scan>();
  const result: WorkInterval[] = [];

  for (const scan of sorted) {
    const key = keyOf(scan);
    if (scan.direction === "In") {
      open.set(key, scan);
      continue;
    }
    const opening = open.get(key);
    if (opening) {
      open.delete(key);
      result.push(interval(opening, opening.time, scan.time, {}));
    } else if (scan.durationSec != null) {
      result.push(
        interval(scan, scan.time - scan.durationSec * 1000, scan.time, { startEstimated: true })
      );
    }
  }

  // A station works on at most its "Max i gang" elements at once: of its
  // open Ins, only that many of the latest are in progress (as on the
  // station's screen); the others never got their Out and do not count.
  const fresh = [...open.values()].filter((scan) => now - scan.time <= STALE_OPEN_MS);
  for (const scan of latestOpenPerStation(fresh, maxOpen)) {
    result.push(interval(scan, scan.time, Math.max(scan.time, now), { inProgress: true }));
  }

  result.sort((a, b) => a.start - b.start || a.end - b.end);
  numberVisits(result, stationKey);
  return result;
}

/**
 * A gap this short between two passes of an element at the same station is a
 * pause (a break, lunch: scanned out on the way, back in on return), not a
 * return for rework.
 */
export const PAUSE_MAX_MS = 60 * 60_000;

/**
 * Sets `visit` on passes sorted by start: 1 for an element's first pass at a
 * station, 2+ when it comes back. A pass continues the visit before it (same
 * number) when the element's previous pass was at the same station, with no
 * other station in between, and ended at most PAUSE_MAX_MS before this one
 * started.
 */
export function numberVisits<T extends { barcode: string; start: number; end: number | null; visit: number | null }>(
  passes: T[],
  station: (pass: T) => string
): void {
  const visits = new Map<string, number>();
  const last = new Map<string, { station: string; end: number | null }>();
  for (const pass of passes) {
    const at = station(pass);
    const key = `${pass.barcode}\u0000${at}`;
    const n = visits.get(key) ?? 0;
    const prev = last.get(pass.barcode);
    const paused = n > 0 && prev?.station === at && prev.end != null && pass.start - prev.end <= PAUSE_MAX_MS;
    const visit = paused ? n : n + 1;
    visits.set(key, visit);
    pass.visit = visit;
    last.set(pass.barcode, { station: at, end: pass.end });
  }
}

/**
 * Intervals that ended in [from, to). As in the station app, work belongs to the day it ended, so
 * an element left overnight counts on the morning it was finished. One in progress ends "now", so
 * it shows on today only.
 */
export function intervalsEndingIn(intervals: WorkInterval[], from: number, to: number): WorkInterval[] {
  return intervals.filter((iv) => iv.end >= from && iv.end < to);
}

/** Station order on the floor: by station number, then by name. */
export function compareStations(
  a: { station: string; stationNo: number | null },
  b: { station: string; stationNo: number | null }
): number {
  const an = a.stationNo ?? Number.MAX_SAFE_INTEGER;
  const bn = b.stationNo ?? Number.MAX_SAFE_INTEGER;
  return an - bn || a.station.localeCompare(b.station, "da");
}

function stationNames(intervals: WorkInterval[]): string[] {
  const byStation = new Map<string, WorkInterval>();
  for (const iv of intervals) {
    const key = stationKey(iv);
    if (!byStation.has(key)) byStation.set(key, iv);
  }
  return [...byStation.values()].sort(compareStations).map((iv) => iv.station);
}

const sum = (values: number[]) => values.reduce((t, v) => t + v, 0);

export type OrderStatus = "active" | "idle";

export interface OrderSummary {
  orderNo: number;
  /**
   * Distinct elements (barcodes) with a timed pass, done or in progress: the
   * same count as the KPI and the station app. A barcode that was only
   * scanned (no pass could be timed) is not an element worked on.
   */
  elements: number;
  totalMs: number;
  /** Stations the order passed through, in floor order. */
  stations: string[];
  /** Stations where an element of the order is in progress now. */
  activeAt: string[];
  /** active: something on it is in progress now. idle: nothing is. */
  status: OrderStatus;
  firstScan: number;
  lastScan: number;
  /** Passes after the first at the same station (rework re-scans). */
  reworkPasses: number;
  /** Copenhagen days the order had a pass ending (work counts on the day it ends), ascending. */
  days: string[];
}

/**
 * The status rule on its own, for one order's intervals: active while
 * anything is in progress, else idle. Nothing more is guessed from the scans
 * (a pass at packing does not make an order packed).
 */
export function orderStatus(orderIntervals: WorkInterval[]): OrderStatus {
  return orderIntervals.some((iv) => iv.inProgress) ? "active" : "idle";
}

/**
 * One line per order. `intervals` decide the time and the status; `scans`
 * (the same period) add first/last scan and orders with no timed pass. Most recent activity first.
 */
export function summarizeOrders(intervals: WorkInterval[], scans: Scan[]): OrderSummary[] {
  const ivByOrder = groupBy(intervals, (iv) => iv.orderNo);
  const scansByOrder = groupBy(scans, (s) => s.orderNo);
  const orders = new Set<number>([...ivByOrder.keys(), ...scansByOrder.keys()]);

  const lines: OrderSummary[] = [];
  for (const orderNo of orders) {
    const ivs = ivByOrder.get(orderNo) ?? [];
    const sc = scansByOrder.get(orderNo) ?? [];
    const times = [...sc.map((s) => s.time), ...ivs.map((iv) => iv.start), ...ivs.map((iv) => iv.end)];
    const active = ivs.filter((iv) => iv.inProgress);
    lines.push({
      orderNo,
      elements: new Set(ivs.map((iv) => iv.barcode)).size,
      totalMs: sum(ivs.map((iv) => iv.durationMs)),
      stations: stationNames(ivs.length > 0 ? ivs : sc.map(scanAsStationRef)),
      activeAt: stationNames(active),
      status: orderStatus(ivs),
      firstScan: Math.min(...times),
      // An interval in progress ends at now, so an active order sorts to the top.
      lastScan: Math.max(...times),
      reworkPasses: ivs.filter((iv) => iv.visit > 1).length,
      days: [...new Set(ivs.map((iv) => dayKey(iv.end)))].sort(),
    });
  }
  return lines.sort((a, b) => b.lastScan - a.lastScan || b.orderNo - a.orderNo);
}

function scanAsStationRef(s: Scan): WorkInterval {
  return interval(s, s.time, s.time, {});
}

export interface StationSummary {
  station: string;
  stationNo: number | null;
  stationKind: string;
  /** Finished passes (In and Out). */
  done: number;
  /** Mean time of a finished pass. */
  averageMs: number | null;
  /**
   * Time worked, including what is in progress. Whole passes, also the part
   * before the day: a pass counts whole on the day it ended, so this can be
   * more than the day holds while utilisation (cut to the span) stays under 1.
   */
  busyMs: number;
  /** Time worked inside the working span / the working span, 0 to 1. */
  utilisation: number;
  /** Elements in progress here now. */
  active: number;
}

export interface StationSpan {
  /**
   * Start of the day shown. The working span starts at the first scan on or
   * after it, and only the part of a pass inside the span counts as worked, so
   * an element left overnight (it counts for the day it ends) cannot stretch
   * the day back to midnight or fill it with the night's hours.
   */
  from?: number;
  /** End of the span: now, for today. Left out: the last end (a finished day). */
  until?: number;
}

/**
 * Per station: passes done, average time per pass, and utilisation. With
 * `from`, the span starts at the first scan inside the day: a pass counts
 * from its start when that is in the day, otherwise from its end (a pass left
 * overnight is first seen today at its Out; one still in progress has no scan
 * today, so it ends "now" and does not open the day). Without `from` it starts
 * at the first start anywhere. It ends at `until` or the last end. Utilisation
 * is the time worked inside the span over the span, so one overnight pass
 * neither stretches the day back to midnight for every station nor gets the
 * night as work. The station app (DayReport.Stations) follows the same rule.
 */
export function summarizeStations(intervals: WorkInterval[], { from, until }: StationSpan = {}): StationSummary[] {
  if (intervals.length === 0) return [];
  const firstScan = (iv: WorkInterval) => (from == null || iv.start >= from ? iv.start : iv.end);
  const first = Math.min(...intervals.map(firstScan));
  const spanStart = from != null ? Math.max(from, first) : first;
  const spanEnd = until ?? Math.max(...intervals.map((iv) => iv.end));
  const span = Math.max(0, spanEnd - spanStart);
  const inSpan = (iv: WorkInterval) => Math.max(0, Math.min(iv.end, spanEnd) - Math.max(iv.start, spanStart));

  return [...groupBy(intervals, stationKey).values()]
    .map((ivs) => {
      const done = ivs.filter((iv) => !iv.inProgress);
      const busy = sum(ivs.map((iv) => iv.durationMs));
      return {
        station: ivs[0].station,
        stationNo: ivs[0].stationNo,
        stationKind: ivs[0].stationKind,
        done: done.length,
        averageMs: done.length > 0 ? sum(done.map((iv) => iv.durationMs)) / done.length : null,
        busyMs: busy,
        utilisation: span > 0 ? Math.min(1, Math.max(0, sum(ivs.map(inSpan)) / span)) : 0,
        active: ivs.length - done.length,
      };
    })
    .sort(compareStations);
}

export interface Kpis {
  /** Distinct elements worked on. */
  elements: number;
  orders: number;
  /** Orders with a finished pass at a Packing station: a count of scans, not a claim they are packed. */
  ordersAtPacking: number;
  /** Mean time of a finished pass at a station (time per element per station). */
  averagePassMs: number | null;
  /** All time worked, in progress included. */
  totalWorkedMs: number;
  /** Elements in progress now. */
  inProgress: number;
}

export function computeKpis(intervals: WorkInterval[], orders: OrderSummary[]): Kpis {
  const done = intervals.filter((iv) => !iv.inProgress);
  return {
    elements: new Set(intervals.map((iv) => iv.barcode)).size,
    orders: orders.length,
    ordersAtPacking: new Set(done.filter((iv) => isPacking(iv)).map((iv) => iv.orderNo)).size,
    averagePassMs: done.length > 0 ? sum(done.map((iv) => iv.durationMs)) / done.length : null,
    totalWorkedMs: sum(intervals.map((iv) => iv.durationMs)),
    inProgress: intervals.filter((iv) => iv.inProgress).length,
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
