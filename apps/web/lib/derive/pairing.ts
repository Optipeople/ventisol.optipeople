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

import { dedupeScans, maxOpenAt, stationKey, type MaxOpen } from "@/lib/report";
import { isPacking, type Scan } from "@/lib/scans";
import { DEFAULT_PARAMS, type IntervalStatus, type MissingReason, type StationKind } from "./types";

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
}

export interface PairOptions {
  now: number;
  /** Default 36 hours, as the station app. */
  staleOpenSeconds?: number;
  /** "Max i gang" per station number (config.stations.max_open). A station not listed has 1. */
  maxOpen?: MaxOpen;
  /** See DeriveContext.otherOpenInsByStation. */
  otherOpenInsByStation?: Record<number, number[]>;
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
    ...extra,
  };
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
 * - An In still open at the end: open (in progress) while it is at most
 *   staleOpenSeconds old, a missing scan-out (stale) after that. A station
 *   works on at most its "Max i gang" elements at once (`maxOpen`, 1 unless
 *   set): of the open Ins at one station only that many of the latest are
 *   open, counting those of other orders (`otherOpenInsByStation`); the
 *   older ones are missing scan-outs (superseded).
 *
 * Visits number the done and open intervals per element and station, oldest
 * first. Sorted by start.
 */
export function pairHistory(scans: Scan[], opts: PairOptions): PairedInterval[] {
  const { now } = opts;
  const staleMs = (opts.staleOpenSeconds ?? DEFAULT_PARAMS.staleOpenSeconds) * 1000;
  const sorted = dedupeScans(scans).sort(byTime);
  const open = new Map<string, Scan>();
  const result: PairedInterval[] = [];

  const missing = (scan: Scan, reason: MissingReason) =>
    result.push(make(scan, scan.time, null, { status: "missing_out", missingReason: reason, inScanId: scan.id }));

  for (const scan of sorted) {
    const key = pairKey(scan);
    if (scan.direction === "In") {
      const earlier = open.get(key);
      if (earlier) missing(earlier, "superseded");
      open.set(key, scan);
      continue;
    }
    const opening = open.get(key);
    if (opening) {
      open.delete(key);
      result.push(make(opening, opening.time, scan.time, { inScanId: opening.id, outScanId: scan.id }));
    } else if (scan.durationSec != null) {
      result.push(
        make(scan, scan.time - scan.durationSec * 1000, scan.time, { startEstimated: true, outScanId: scan.id })
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
  const visits = new Map<string, number>();
  for (const iv of result) {
    if (iv.status === "missing_out") continue;
    const key = `${iv.barcode}\u0000${iv.stationNo}\u0000${iv.stationNo === 0 ? iv.station : ""}`;
    const n = (visits.get(key) ?? 0) + 1;
    visits.set(key, n);
    iv.visit = n;
  }
  return result;
}
