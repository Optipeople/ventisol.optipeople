// Pairing over the full scan history. The same rules as the station screen
// and lib/report.ts (docs/opticloud-scans.md, "Rules"), with two differences
// that only add information:
//
//   - lib/report.ts drops an In that never got its Out. Here it is kept as an
//     interval with status "missing_out", so Indstillinger can list it. It
//     never counts in any time or count.
//   - There is no 36 hour read window. The 36 hours only decide when an open
//     In stops being "in progress" and becomes a missing scan-out.
//
// docs/scan-rules-vectors.json runs against this in pairing.test.ts.

import { dedupeScans, LATE_OUT_MAX_MS, maxOpenAt, numberVisits, stationKey, type MaxOpen } from "@/lib/report";
import { isPacking, toEndEvent, type EndEvent, type Scan } from "@/lib/scans";
import { workingMsBetween } from "./calendar";
import { DEFAULT_PARAMS, type IntervalStatus, type MissingReason, type StationKind, type WorkCalendar } from "./types";

export interface PairedInterval {
  /** The In scan's id, or the Out scan's when the In is missing. */
  id: string;
  barcode: string;
  orderNo: number;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  station: string;
  /** 0 when the scan carried no station number. */
  stationNo: number;
  stationKind: StationKind;
  /** Epoch ms. */
  start: number;
  /** Epoch ms. Null while open and on a missing scan-out. */
  end: number | null;
  status: IntervalStatus;
  missingReason: MissingReason | null;
  startEstimated: boolean;
  /** 1 for the first pass, 2+ for rework. Null on a missing scan-out. */
  visit: number | null;
  inScanId: string | null;
  outScanId: string | null;
  /**
   * The Event of the row that ended the pass (core.station_intervals.end_event):
   * shift_end when the station stopped it at shift end. Null for an ordinary
   * Out, and while open or missing.
   */
  endEvent: EndEvent | null;
  /** Stopped by the station at shift end, not scanned out (endEvent shift_end). */
  autoStopped: boolean;
}

export interface PairOptions {
  now: number;
  /** Default 36 hours, as the station app. */
  staleOpenSeconds?: number;
  /** "Max i gang" per station number (config.stations.max_open). A station not listed has 1. */
  maxOpen?: MaxOpen;
  /** See DeriveContext.otherOpenInsByStation. */
  otherOpenInsByStation?: Record<number, number[]>;
  /**
   * Shifts: the gap before a pass back at the same station is measured in
   * shift time, so out at the end of the day and in the next morning is a
   * pause, not rework. Left out: wall clock.
   */
  calendar?: WorkCalendar;
}

/** Chronological, In before Out on a tie so a zero-length pass still pairs. */
function byTime(a: Scan, b: Scan): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.direction === b.direction) return 0;
  return a.direction === "In" ? -1 : 1;
}

const pairKey = (s: Scan) => `${s.barcode}\u0000${stationKey(s)}`;

export function kindOf(scan: Pick<Scan, "stationKind">): StationKind {
  return isPacking(scan) ? "packing" : "assembly";
}

function make(scan: Scan, start: number, end: number | null, extra: Partial<PairedInterval>): PairedInterval {
  return {
    id: scan.id,
    barcode: scan.barcode,
    orderNo: scan.orderNo,
    position: scan.position,
    subPosition: scan.subPosition,
    piece: scan.piece,
    station: scan.station,
    stationNo: scan.stationNo ?? 0,
    stationKind: kindOf(scan),
    start,
    end,
    status: "done",
    missingReason: null,
    startEstimated: false,
    visit: null,
    inScanId: null,
    outScanId: null,
    endEvent: null,
    autoStopped: false,
    ...extra,
  };
}

/** How an Out (or a Mark closing a pause) ends its pass. */
function ending(row: Scan): Pick<PairedInterval, "endEvent" | "autoStopped"> {
  const endEvent = toEndEvent(row.event);
  return { endEvent, autoStopped: endEvent === "shift_end" };
}

/** Where an interval ends for counting: its Out, or now while it is open. */
export function endOrNow(iv: Pick<PairedInterval, "start" | "end">, now: number): number {
  return iv.end ?? Math.max(iv.start, now);
}

/**
 * The open Ins that are in progress: per station the latest, as many as its
 * "Max i gang", where the open Ins of other orders at the station take their
 * place too. One of these wins a tie in time against another order's (as
 * before there was a max), and among these the one handed in first.
 */
function inProgress(fresh: Scan[], opts: PairOptions): Set<Scan> {
  const byStation = new Map<string, Scan[]>();
  for (const scan of fresh) {
    const key = stationKey(scan);
    const list = byStation.get(key);
    if (list) list.push(scan);
    else byStation.set(key, [scan]);
  }
  const kept = new Set<Scan>();
  for (const list of byStation.values()) {
    const stationNo = list[0].stationNo;
    const others = stationNo != null ? (opts.otherOpenInsByStation?.[stationNo] ?? []) : [];
    // Own first, then the others; the stable sort keeps that order on a tie.
    const entries = [...list.map((scan) => ({ time: scan.time, scan })), ...others.map((time) => ({ time, scan: null }))];
    entries.sort((a, b) => b.time - a.time);
    for (const e of entries.slice(0, maxOpenAt(opts.maxOpen, stationNo))) if (e.scan) kept.add(e.scan);
  }
  return kept;
}

/**
 * Pairs In and Out per station (StationNo) and barcode over whatever scans
 * are handed in, oldest first, an In before an Out at the same time.
 *
 * - In then Out: a done interval.
 * - A second In while one is open on the same element and station: the later
 *   In wins; the earlier becomes a missing scan-out (superseded).
 * - An Out with no open In: the start is put back from DurationSec
 *   (startEstimated). Without DurationSec it cannot be timed and is skipped.
 * - A late Out (docs/plan-shift-end.md §4.6): an Out with no open In, at most
 *   12 hours after a ShiftEnd Out of the same element at the same station
 *   with no In between, ends that pass instead (the ShiftEnd is ignored).
 *   Later than that it is skipped.
 * - A Mark carries no time and never pairs. One right after a Pause Out of
 *   the same element at the same station closes the pause: that pass ends
 *   with the Mark's event (shift_end when the station stopped it).
 * - An In still open at the end: open (in progress) while it is at most
 *   staleOpenSeconds old, a missing scan-out (stale) after that. A station
 *   works on at most its "Max i gang" elements at once (`maxOpen`, 1 unless
 *   set): of the open Ins at one station only that many of the latest are
 *   open, counting those of other orders (`otherOpenInsByStation`); the
 *   older ones are missing scan-outs (superseded).
 *
 * Visits number the done and open intervals per element and station, oldest
 * first; a pass back after a short pause continues its visit (numberVisits),
 * and so does the next pass after one stopped at shift end.
 * Sorted by start.
 */
export function pairHistory(scans: Scan[], opts: PairOptions): PairedInterval[] {
  const { now } = opts;
  const staleMs = (opts.staleOpenSeconds ?? DEFAULT_PARAMS.staleOpenSeconds) * 1000;
  const sorted = dedupeScans(scans).sort(byTime);
  const open = new Map<string, Scan>();
  // The pass each element and station last ended, until its next In: a late
  // Out or a Mark may still change how it ends.
  const closed = new Map<string, PairedInterval>();
  const result: PairedInterval[] = [];

  const missing = (scan: Scan, reason: MissingReason) =>
    result.push(make(scan, scan.time, null, { status: "missing_out", missingReason: reason, inScanId: scan.id }));
  const done = (key: string, iv: PairedInterval) => {
    result.push(iv);
    closed.set(key, iv);
  };

  for (const scan of sorted) {
    const key = pairKey(scan);
    if (scan.direction === "In") {
      const earlier = open.get(key);
      if (earlier) missing(earlier, "superseded");
      open.set(key, scan);
      closed.delete(key);
      continue;
    }
    if (scan.direction === "Mark") {
      const last = closed.get(key);
      if (last?.endEvent === "pause") {
        Object.assign(last, ending(scan));
        closed.delete(key);
      }
      continue;
    }
    const opening = open.get(key);
    if (opening) {
      open.delete(key);
      done(key, make(opening, opening.time, scan.time, { inScanId: opening.id, outScanId: scan.id, ...ending(scan) }));
      continue;
    }
    const stopped = closed.get(key);
    if (stopped?.autoStopped && stopped.end != null && scan.time >= stopped.end) {
      // A late Out after a ShiftEnd: within 12 hours it ends the pass, later it is skipped.
      if (scan.time - stopped.end <= LATE_OUT_MAX_MS) {
        Object.assign(stopped, { end: scan.time, outScanId: scan.id, ...ending(scan) });
        closed.delete(key);
      }
      continue;
    }
    if (scan.durationSec != null) {
      done(
        key,
        make(scan, scan.time - scan.durationSec * 1000, scan.time, { startEstimated: true, outScanId: scan.id, ...ending(scan) })
      );
    }
  }

  // Of the open Ins that are not stale, the latest per station are in progress.
  const fresh: Scan[] = [];
  for (const scan of open.values()) {
    if (now - scan.time > staleMs) missing(scan, "stale");
    else fresh.push(scan);
  }
  const current = inProgress(fresh, opts);
  for (const scan of fresh) {
    if (current.has(scan)) result.push(make(scan, scan.time, null, { status: "open", inScanId: scan.id }));
    else missing(scan, "superseded");
  }

  result.sort((a, b) => a.start - b.start || endOrNow(a, now) - endOrNow(b, now));
  const { calendar } = opts;
  numberVisits(
    result.filter((iv) => iv.status !== "missing_out"),
    (iv) => `${iv.stationNo}\u0000${iv.stationNo === 0 ? iv.station : ""}`,
    calendar ? (from, to) => workingMsBetween(from, to, calendar) : undefined,
    // The same work going on after the station stopped it at shift end: not rework.
    (prev) => prev.autoStopped
  );
  return result;
}
