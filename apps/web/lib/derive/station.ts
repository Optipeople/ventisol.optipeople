// Station figures per Copenhagen day, and the read-time status label. Pure.
//
// deriveStationDay turns the interval rows of one station around one day into
// one core.station_day_facts row. It stores primitives only (median time per
// piece, the in-shift gaps, the longest wait). Everything that depends on a
// setting (normal time, thresholds) is applied at read time by stationStatus,
// so changing a normal time or a threshold needs no rebuild.

import { dayEnd, dayStart } from "@/lib/time";
import { shiftBlocksOn } from "./calendar";
import { resolveParams } from "./order";
import type {
  DeriveContext,
  ElementTypeCount,
  LocalDay,
  StationDayFactsRow,
  StationGap,
  StationIntervalRow,
} from "./types";

const iso = (ms: number) => new Date(ms).toISOString();
const sum = (values: number[]) => values.reduce((t, v) => t + v, 0);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

type Span = [number, number];

/** Sorted, merged union of spans. */
function union(spans: Span[]): Span[] {
  const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function clip(spans: Span[], from: number, to: number): Span[] {
  return spans.map(([s, e]): Span => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s);
}

/** The parts of `within` (merged, sorted) not covered by `busy` (merged, sorted). */
function subtract(within: Span[], busy: Span[]): Span[] {
  const out: Span[] = [];
  for (const [s, e] of within) {
    let cursor = s;
    for (const [bs, be] of busy) {
      if (be <= cursor) continue;
      if (bs >= e) break;
      if (bs > cursor) out.push([cursor, bs]);
      cursor = Math.max(cursor, be);
      if (cursor >= e) break;
    }
    if (cursor < e) out.push([cursor, e]);
  }
  return out;
}

const length = (spans: Span[]) => sum(spans.map(([s, e]) => e - s));
const seconds = (ms: number) => Math.round(ms / 1000);

/**
 * One station, one local day. `rows` are the station's interval rows that
 * touch the day (any order): started before the day ends and not ended before
 * it starts. Rows of other stations are ignored. Null when nothing touches
 * the day: delete the stored row then.
 */
export function deriveStationDay(
  stationNo: number,
  localDay: LocalDay,
  rows: StationIntervalRow[],
  ctx: Pick<DeriveContext, "now" | "calendar" | "params">
): StationDayFactsRow | null {
  const params = resolveParams(ctx.params);
  const from = dayStart(localDay);
  const to = dayEnd(localDay);
  const cutoff = Math.min(to, Math.max(from, ctx.now));
  const inDay = (t: number) => t >= from && t < to;

  const mine = rows
    .filter((r) => r.stationNo === stationNo)
    .map((r) => {
      const start = Date.parse(r.startAt);
      const end = r.endAt != null ? Date.parse(r.endAt) : null;
      return { row: r, start, end, until: end ?? Math.max(start, ctx.now) };
    });
  const missing = mine.filter((m) => m.row.status === "missing_out" && inDay(m.start));
  const counted = mine.filter((m) => m.row.status !== "missing_out");
  const done = counted.filter((m) => m.row.status === "done" && inDay(m.end as number));
  const openNow = counted.filter((m) => m.row.status === "open" && m.start < cutoff);
  const touching = counted.filter((m) => m.start < cutoff && m.until > from);
  if (done.length === 0 && touching.length === 0 && missing.length === 0) return null;

  const named = [...mine].sort((a, b) => b.start - a.start)[0].row;

  // Scans inside the day: an In (not an estimated start) and an Out.
  const scanTimes = [
    ...counted.filter((m) => !m.row.startEstimated && inDay(m.start)).map((m) => m.start),
    ...counted.filter((m) => m.end != null && inDay(m.end)).map((m) => m.end as number),
    ...missing.map((m) => m.start),
  ];
  const firstScan = scanTimes.length > 0 ? Math.min(...scanTimes) : null;
  const lastScan = scanTimes.length > 0 ? Math.max(...scanTimes) : null;

  const shifts = shiftBlocksOn(localDay, ctx.calendar).map(([s, e]): Span => [s, e]);
  const observedShifts = clip(shifts, from, cutoff);
  const busy = union(clip(touching.map((m): Span => [m.start, m.until]), from, cutoff));
  const busyInShift = observedShifts.flatMap(([s, e]) => clip(busy, s, e));

  // Standstill window: from the first scan of the day (or the start of the
  // day when an element was already on the station) to the end of the
  // observed day, unless the parameters say otherwise.
  const carriedIn = touching.some((m) => m.start < from);
  const windowStart = params.standstillCountBeforeFirstScan || carriedIn ? from : (firstScan ?? cutoff);
  const windowEnd =
    params.standstillCountAfterLastScan || openNow.length > 0 ? cutoff : Math.min(cutoff, lastScan ?? from);
  const idle = subtract(clip(observedShifts, windowStart, windowEnd), busy);
  const gaps: StationGap[] = idle
    .filter(([s, e]) => e - s >= params.gapFloorSeconds * 1000)
    .map(([s, e]) => ({ startAt: iso(s), endAt: iso(e), seconds: seconds(e - s) }));

  const durations = done.map((m) => m.row.durationSeconds ?? seconds((m.end as number) - m.start));
  const workingDurations = done.map((m) => m.row.durationWorkingSeconds).filter((v): v is number => v != null);

  const byType = new Map<string | null, number[]>();
  done.forEach((m, i) => {
    const list = byType.get(m.row.elementTypeId);
    if (list) list.push(durations[i]);
    else byType.set(m.row.elementTypeId, [durations[i]]);
  });
  const byElementType: ElementTypeCount[] = [...byType.entries()]
    .map(([elementTypeId, list]) => ({
      elementTypeId,
      count: list.length,
      medianSeconds: median(list) as number,
      meanSeconds: Math.round(sum(list) / list.length),
    }))
    .sort((a, b) => (a.elementTypeId ?? "").localeCompare(b.elementTypeId ?? ""));

  const waited = [...done, ...openNow];
  const waits = waited.map((m) => m.row.waitBeforeSeconds).filter((v): v is number => v != null);
  const workingWaits = waited.map((m) => m.row.waitBeforeWorkingSeconds).filter((v): v is number => v != null);

  return {
    stationNo,
    localDay,
    station: named.station,
    stationKind: named.stationKind,
    countThrough: done.length,
    elementsThrough: new Set(done.map((m) => m.row.barcode)).size,
    reworkPasses: done.filter((m) => m.row.isRework).length,
    missingScanOutCount: missing.length,
    openCount: openNow.length,
    timePerPieceSeconds: median(durations),
    timePerPieceWorkingSeconds: median(workingDurations),
    meanPieceSeconds: durations.length > 0 ? Math.round(sum(durations) / durations.length) : null,
    passSecondsTotal: sum(durations),
    availableSeconds: seconds(length(shifts)),
    observedSeconds: seconds(length(observedShifts)),
    busySeconds: seconds(length(busy)),
    busyInShiftSeconds: seconds(length(busyInShift)),
    idleSeconds: seconds(length(idle)),
    longestGapSeconds: idle.length > 0 ? seconds(Math.max(...idle.map(([s, e]) => e - s))) : 0,
    gaps,
    longestWaitBeforeSeconds: waits.length > 0 ? Math.max(...waits) : null,
    longestWaitBeforeWorkingSeconds: workingWaits.length > 0 ? Math.max(...workingWaits) : null,
    firstScanAt: firstScan != null ? iso(firstScan) : null,
    lastScanAt: lastScan != null ? iso(lastScan) : null,
    byElementType,
    isComplete: ctx.now >= to,
    computedAt: iso(ctx.now),
  };
}

// ---------------------------------------------------------------------------
// Read time: comparison with normal, and the status label
// ---------------------------------------------------------------------------

export interface StationThresholds {
  /** Langsommere: time per piece more than this many percent over normal. config: slow_threshold_percent. */
  slowPercent: number;
  /** A gap counts as standstill from this length. config: standstill_threshold_minutes * 60. */
  standstillMinGapSeconds: number;
  /**
   * Stod stille as a status: the standstill must add up to at least this many
   * percent of the shift time so far. One pause over the threshold is shown
   * as a figure, but does not mark the station for the rest of the day.
   */
  standstillSharePercent: number;
  /** Lang liggetid: an element waited longer than this before the station. config: long_dwell_threshold_minutes * 60. */
  longDwellSeconds: number;
  /** Judge waits and time per piece in shift time (config: deduct_off_shift). */
  useWorkingTime: boolean;
}

export const DEFAULT_THRESHOLDS: StationThresholds = {
  slowPercent: 20,
  standstillMinGapSeconds: 15 * 60,
  standstillSharePercent: 10,
  longDwellSeconds: 480 * 60,
  useWorkingTime: true,
};

export type StationStatusKey = "normal" | "long_dwell" | "slower" | "stood_still" | "no_data";

export const STATION_STATUS_LABELS: Record<StationStatusKey, string> = {
  normal: "Normal",
  long_dwell: "Lang liggetid",
  slower: "Langsommere",
  stood_still: "Stod stille",
  no_data: "Ingen data endnu",
};

export interface StationStatus {
  status: StationStatusKey;
  /** Danish, for the UI. */
  label: string;
  timePerPieceSeconds: number | null;
  normalSeconds: number | null;
  /** "Mod normalt": percent over (+) or under (-) normal. Null without both figures. */
  deviationPercent: number | null;
  /** "Stod stille": the in-shift gaps of at least the threshold, summed. 0 shows as "Ingen". */
  standstillSeconds: number;
  longestWaitBeforeSeconds: number | null;
}

/**
 * The status of a station day. One label, the most pressing first:
 * Stod stille (the standstill is at least standstillSharePercent of the
 * shift time so far), then Lang liggetid, then Langsommere, else Normal.
 * `facts` null (a machine with no connector yet) gives "Ingen data endnu".
 */
export function stationStatus(
  facts: Pick<
    StationDayFactsRow,
    | "timePerPieceSeconds"
    | "timePerPieceWorkingSeconds"
    | "gaps"
    | "longestWaitBeforeSeconds"
    | "longestWaitBeforeWorkingSeconds"
  > &
    Partial<Pick<StationDayFactsRow, "observedSeconds">> | null,
  normalSeconds: number | null,
  thresholds: Partial<StationThresholds> = {}
): StationStatus {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (!facts) {
    return {
      status: "no_data",
      label: STATION_STATUS_LABELS.no_data,
      timePerPieceSeconds: null,
      normalSeconds,
      deviationPercent: null,
      standstillSeconds: 0,
      longestWaitBeforeSeconds: null,
    };
  }
  const perPiece = t.useWorkingTime
    ? (facts.timePerPieceWorkingSeconds ?? facts.timePerPieceSeconds)
    : facts.timePerPieceSeconds;
  const wait = t.useWorkingTime
    ? (facts.longestWaitBeforeWorkingSeconds ?? facts.longestWaitBeforeSeconds)
    : facts.longestWaitBeforeSeconds;
  const standstillSeconds = sum(
    facts.gaps.filter((g) => g.seconds >= t.standstillMinGapSeconds).map((g) => g.seconds)
  );
  const deviationPercent =
    perPiece != null && normalSeconds != null && normalSeconds > 0
      ? Math.round(((perPiece - normalSeconds) / normalSeconds) * 100)
      : null;
  // Without the shift time (older rows), any standstill counts.
  const standstillFloor = ((facts.observedSeconds ?? 0) * t.standstillSharePercent) / 100;
  const status: StationStatusKey =
    standstillSeconds > 0 && standstillSeconds >= standstillFloor
      ? "stood_still"
      : wait != null && wait > t.longDwellSeconds
        ? "long_dwell"
        : deviationPercent != null && deviationPercent > t.slowPercent
          ? "slower"
          : "normal";
  return {
    status,
    label: STATION_STATUS_LABELS[status],
    timePerPieceSeconds: perPiece,
    normalSeconds,
    deviationPercent,
    standstillSeconds,
    longestWaitBeforeSeconds: wait,
  };
}

/**
 * The normal time to hold a station day against when it ran a mix of element
 * types: the normal times weighted by how many pieces of each type went
 * through. Types without a normal time use `fallbackSeconds`, or are left out.
 * Null when nothing can be compared.
 */
export function normalForMix(
  byElementType: ElementTypeCount[],
  normalByType: Record<string, number>,
  fallbackSeconds: number | null = null
): number | null {
  let total = 0;
  let count = 0;
  for (const t of byElementType) {
    const normal = (t.elementTypeId != null ? normalByType[t.elementTypeId] : undefined) ?? fallbackSeconds;
    if (normal == null) continue;
    total += normal * t.count;
    count += t.count;
  }
  return count > 0 ? Math.round(total / count) : null;
}
