// Stationer: the table per station for a day or a period, and the drill-down
// for one station. SQL: rpt.station_day, rpt.station_performance,
// rpt.station_timeline, rpt.station_type_distribution, rpt.stations.
//
// Normal time, deviation and the status label are applied HERE, with
// normalForMix() and stationStatus() of lib/derive, for the day table, the
// period table, the trend and the monthly report alike. Pages and the chat
// both come through this file, so they cannot disagree on a label.

import { z } from "zod";
import type { Claims, Db } from "@/lib/db";
import {
  normalForMix,
  stationStatus,
  type ElementTypeCount,
  type StationGap,
  type StationStatusKey,
} from "@/lib/derive";
import { addDays, dayEnd, dayStart, isoWeek, startOfWeek } from "@/lib/time";
import { joinDanish, weekLabel } from "./format";
import {
  clockSchema,
  daySchema,
  duration,
  NO_DURATION,
  percentChange,
  report,
  rows,
  stationNoSchema,
  type ReportContext,
} from "./shared";
import type {
  StationAttention,
  StationDayReport,
  StationDetail,
  StationInfo,
  StationKindKey,
  StationPeriodReport,
  StationRow,
  StationTrendPoint,
  TimelineInterval,
  TypeDistribution,
} from "./types";

export const STATION_KIND_LABELS: Record<StationKindKey, string> = {
  assembly: "Montage",
  packing: "Pakning",
  machine: "Maskine",
  buffer: "Liggetid",
};

const ATTENTION: ReadonlySet<StationStatusKey> = new Set(["stood_still", "long_dwell", "slower"]);

interface NormalTime {
  elementTypeId: string;
  seconds: number;
}

/** A row of rpt.station_day or rpt.station_performance, or of rpt.stations for a placeholder. */
export interface StationRaw {
  bucketStart?: string;
  stationNo: number;
  name: string;
  kind: StationKindKey;
  sortOrder: number;
  configured: boolean;
  hasFacts: boolean;
  countThrough: number | null;
  elementsThrough: number | null;
  reworkPasses: number | null;
  missingScanOutCount: number | null;
  /** rpt.station_day only. */
  autoStoppedCount?: number | null;
  openCount: number | null;
  timePerPieceSeconds: number | null;
  timePerPieceWorkingSeconds: number | null;
  meanPieceSeconds: number | null;
  availableSeconds: number | null;
  observedSeconds: number | null;
  busyInShiftSeconds: number | null;
  gaps: StationGap[] | null;
  longestWaitBeforeSeconds: number | null;
  longestWaitBeforeWorkingSeconds: number | null;
  avgWaitBeforeSeconds?: number | null;
  avgWaitBeforeWorkingSeconds?: number | null;
  firstScanAt: string | null;
  lastScanAt: string | null;
  byElementType: ElementTypeCount[] | null;
  isComplete?: boolean | null;
  daysActive: number | null;
  normalTimes: NormalTime[];
}

interface StationListRaw {
  stationNo: number;
  name: string;
  kind: StationKindKey;
  sortOrder: number;
  active: boolean;
  normalTimes: NormalTime[];
  /** "Max i gang": elements that may be in progress here at once. */
  maxOpen: number;
}

/** One station row with normal, deviation and status applied. */
export function toStationRow(raw: StationRaw, ctx: ReportContext): StationRow {
  const gaps = raw.gaps ?? [];
  const byElementType = raw.byElementType ?? [];
  const facts = raw.hasFacts
    ? {
        timePerPieceSeconds: raw.timePerPieceSeconds,
        timePerPieceWorkingSeconds: raw.timePerPieceWorkingSeconds,
        gaps,
        longestWaitBeforeSeconds: raw.longestWaitBeforeSeconds,
        longestWaitBeforeWorkingSeconds: raw.longestWaitBeforeWorkingSeconds,
        observedSeconds: raw.observedSeconds ?? undefined,
      }
    : null;
  const normalByType = Object.fromEntries(raw.normalTimes.map((n) => [n.elementTypeId, n.seconds]));
  const normal = facts ? normalForMix(byElementType, normalByType) : null;
  const status = stationStatus(facts, normal, ctx.thresholds);
  const observed = raw.observedSeconds ?? 0;
  return {
    stationNo: raw.stationNo,
    name: raw.name,
    kind: raw.kind,
    kindLabel: STATION_KIND_LABELS[raw.kind] ?? raw.kind,
    configured: raw.configured,
    hasData: raw.hasFacts,
    countThrough: raw.hasFacts ? (raw.countThrough ?? 0) : null,
    elementsThrough: raw.hasFacts ? (raw.elementsThrough ?? 0) : null,
    reworkPasses: raw.hasFacts ? (raw.reworkPasses ?? 0) : null,
    openCount: raw.hasFacts ? (raw.openCount ?? 0) : null,
    missingScanOutCount: raw.hasFacts ? (raw.missingScanOutCount ?? 0) : null,
    autoStoppedCount: raw.hasFacts && raw.autoStoppedCount !== undefined ? (raw.autoStoppedCount ?? 0) : null,
    timePerPiece: raw.hasFacts
      ? duration(raw.timePerPieceSeconds, raw.timePerPieceWorkingSeconds, ctx.useWorking)
      : NO_DURATION,
    meanPieceSeconds: raw.meanPieceSeconds ?? null,
    normalSeconds: status.normalSeconds,
    deviationPercent: status.deviationPercent,
    standstillSeconds: raw.hasFacts ? status.standstillSeconds : null,
    longestWaitBeforeSeconds: status.longestWaitBeforeSeconds,
    avgWaitBefore: duration(raw.avgWaitBeforeSeconds, raw.avgWaitBeforeWorkingSeconds, ctx.useWorking),
    status: status.status,
    statusLabel: status.label,
    utilisationPercent:
      raw.hasFacts && observed > 0 ? Math.round(((raw.busyInShiftSeconds ?? 0) / observed) * 100) : null,
    availableSeconds: raw.availableSeconds ?? null,
    observedSeconds: raw.observedSeconds ?? null,
    busyInShiftSeconds: raw.busyInShiftSeconds ?? null,
    gaps,
    byElementType,
    firstScanAt: raw.firstScanAt ?? null,
    lastScanAt: raw.lastScanAt ?? null,
    daysActive: raw.daysActive ?? 0,
    isComplete: raw.isComplete ?? null,
  };
}

/** "N stationer afviger fra det normale" and which ones: the stations with data whose status is not Normal. */
export function stationAttention(stationRows: StationRow[]): StationAttention {
  const flagged = stationRows.filter((r) => ATTENTION.has(r.status));
  const names = flagged.map((r) => r.name);
  const sentence =
    flagged.length === 0
      ? "Alle stationer kører normalt"
      : `${flagged.length} ${flagged.length === 1 ? "station afviger" : "stationer afviger"} fra det normale: ${joinDanish(names)}`;
  return { count: flagged.length, stationNos: flagged.map((r) => r.stationNo), names, sentence };
}

function placeholder(station: StationListRaw): StationRaw {
  return {
    stationNo: station.stationNo,
    name: station.name,
    kind: station.kind,
    sortOrder: station.sortOrder,
    configured: true,
    hasFacts: false,
    countThrough: null,
    elementsThrough: null,
    reworkPasses: null,
    missingScanOutCount: null,
    openCount: null,
    timePerPieceSeconds: null,
    timePerPieceWorkingSeconds: null,
    meanPieceSeconds: null,
    availableSeconds: null,
    observedSeconds: null,
    busyInShiftSeconds: null,
    gaps: null,
    longestWaitBeforeSeconds: null,
    longestWaitBeforeWorkingSeconds: null,
    firstScanAt: null,
    lastScanAt: null,
    byElementType: null,
    daysActive: 0,
    normalTimes: station.normalTimes,
  };
}

/**
 * Period rows with a placeholder for every active station that has no data,
 * in display order. `stations` is rpt.stations().
 */
export function withPlaceholders(found: StationRaw[], stations: StationListRaw[]): StationRaw[] {
  const seen = new Set(found.map((r) => r.stationNo));
  const all = [...found, ...stations.filter((s) => s.active && !seen.has(s.stationNo)).map(placeholder)];
  return all.sort((a, b) => a.sortOrder - b.sortOrder || a.stationNo - b.stationNo);
}

export async function stationListOn(db: Db): Promise<StationListRaw[]> {
  return rows<StationListRaw>(db, "select * from rpt.stations()");
}

export async function stationDayOn(db: Db, ctx: ReportContext, day: string): Promise<StationRow[]> {
  const raw = await rows<StationRaw>(db, "select * from rpt.station_day($1::date)", [day]);
  return raw.map((r) => toStationRow(r, ctx));
}

export async function stationPeriodOn(
  db: Db,
  ctx: ReportContext,
  from: string,
  to: string,
  stationNo: number | null
): Promise<StationRow[]> {
  const found = await rows<StationRaw>(
    db,
    "select * from rpt.station_performance($1::date, $2::date, $3::integer, 'all')",
    [from, to, stationNo]
  );
  const stations = stationNo == null ? await stationListOn(db) : [];
  return withPlaceholders(found, stations).map((r) => toStationRow(r, ctx));
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/** Every station of config.stations with its normal times. Any role. */
export async function listStations(claims: Claims): Promise<StationInfo[]> {
  return report(claims, undefined, async (db) =>
    (await stationListOn(db)).map((s) => ({ ...s, kindLabel: STATION_KIND_LABELS[s.kind] ?? s.kind }))
  );
}

export const stationDayParams = z.object({ day: daySchema, clock: clockSchema });

/** The Stationer table for one day, with "N stationer afviger fra det normale". Any role. */
export async function getStationDay(
  claims: Claims,
  params: z.input<typeof stationDayParams>
): Promise<StationDayReport> {
  const p = stationDayParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const stationRows = await stationDayOn(db, ctx, p.day);
    return { clock: ctx.clock, day: p.day, rows: stationRows, attention: stationAttention(stationRows) };
  });
}

export const stationPeriodParams = z
  .object({ from: daySchema, to: daySchema, stationNo: stationNoSchema.optional(), clock: clockSchema })
  .refine((p) => p.from <= p.to, "from must not be after to");

/**
 * Station figures for a period: count, median time per piece, against normal,
 * standstill, status. One station, or all (then with a placeholder row for
 * every active station without data). Any role.
 */
export async function getStationPerformance(
  claims: Claims,
  params: z.input<typeof stationPeriodParams>
): Promise<StationPeriodReport> {
  const p = stationPeriodParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const stationRows = await stationPeriodOn(db, ctx, p.from, p.to, p.stationNo ?? null);
    return {
      clock: ctx.clock,
      period: { from: p.from, to: p.to },
      rows: stationRows,
      attention: stationAttention(stationRows),
    };
  });
}

interface TimelineRaw extends Omit<TimelineInterval, "duration" | "split" | "waitBefore" | "autoStopped"> {
  durationSeconds: number | null;
  durationWorkingSeconds: number | null;
  allocatedSeconds: number | null;
  allocatedWorkingSeconds: number | null;
  waitBeforeSeconds: number | null;
  waitBeforeWorkingSeconds: number | null;
}

interface DistributionRaw {
  elementTypeId: string | null;
  elementTypeName: string | null;
  passes: number;
  minSeconds: number;
  p25Seconds: number;
  medianSeconds: number;
  p75Seconds: number;
  maxSeconds: number;
  meanSeconds: number;
  medianWorkingSeconds: number | null;
  normalSeconds: number | null;
}

export const stationDetailParams = z.object({
  stationNo: stationNoSchema,
  day: daySchema,
  /** Weeks of trend and distribution, ending with the week of `day`. */
  weeks: z.number().int().min(1).max(52).default(12),
  clock: clockSchema,
});

/**
 * The drill-down for one station: its row for the day, the day's passes as a
 * timeline, the spread of pass times per element type, and the weekly trend
 * against normal. Any role.
 */
export async function getStationDetail(
  claims: Claims,
  params: z.input<typeof stationDetailParams>
): Promise<StationDetail> {
  const p = stationDetailParams.parse(params);
  const trendFrom = addDays(startOfWeek(p.day), -7 * (p.weeks - 1));
  const trendTo = addDays(startOfWeek(p.day), 6);

  return report(claims, p.clock, async (db, ctx) => {
    const dayRows = await stationDayOn(db, ctx, p.day);
    let station = dayRows.find((r) => r.stationNo === p.stationNo);
    if (!station) {
      // Not active in config.stations and no facts that day: a placeholder.
      const known = (await stationListOn(db)).find((s) => s.stationNo === p.stationNo);
      station = toStationRow(
        placeholder(
          known ?? {
            stationNo: p.stationNo,
            name: `Station nr. ${p.stationNo}`,
            kind: "assembly",
            sortOrder: 0,
            active: false,
            normalTimes: [],
            maxOpen: 1,
          }
        ),
        ctx
      );
      if (!known) station.configured = false;
    }

    const timelineRaw = await rows<TimelineRaw>(
      db,
      "select * from rpt.station_timeline($1::integer, $2::timestamptz, $3::timestamptz)",
      [p.stationNo, new Date(dayStart(p.day)), new Date(dayEnd(p.day))]
    );
    const timeline: TimelineInterval[] = timelineRaw.map(
      ({
        durationSeconds,
        durationWorkingSeconds,
        allocatedSeconds,
        allocatedWorkingSeconds,
        waitBeforeSeconds,
        waitBeforeWorkingSeconds,
        ...rest
      }) => ({
        ...rest,
        endEvent: rest.endEvent ?? null,
        autoStopped: rest.endEvent === "shift_end",
        duration: duration(durationSeconds, durationWorkingSeconds, ctx.useWorking),
        split: duration(allocatedSeconds, allocatedWorkingSeconds, ctx.useWorking),
        waitBefore: duration(waitBeforeSeconds, waitBeforeWorkingSeconds, ctx.useWorking),
      })
    );

    const distributionRaw = await rows<DistributionRaw>(
      db,
      "select * from rpt.station_type_distribution($1::integer, $2::date, $3::date)",
      [p.stationNo, trendFrom, trendTo]
    );
    const distribution: TypeDistribution[] = distributionRaw.map(({ medianWorkingSeconds, ...d }) => {
      const median = duration(d.medianSeconds, medianWorkingSeconds, ctx.useWorking);
      return {
        ...d,
        elementTypeName: d.elementTypeName ?? (d.elementTypeId == null ? "Uden type" : d.elementTypeId),
        median,
        deviationPercent: percentChange(median.seconds, d.normalSeconds),
      };
    });

    const weekly = await rows<StationRaw>(
      db,
      "select * from rpt.station_performance($1::date, $2::date, $3::integer, 'week')",
      [trendFrom, trendTo, p.stationNo]
    );
    const byWeek = new Map(weekly.map((w) => [w.bucketStart as string, toStationRow(w, ctx)]));
    const trend: StationTrendPoint[] = [];
    for (let i = 0; i < p.weeks; i++) {
      const weekStart = addDays(trendFrom, 7 * i);
      const row = byWeek.get(weekStart);
      trend.push({
        weekStart,
        isoYear: Number(addDays(weekStart, 3).slice(0, 4)),
        isoWeek: isoWeek(weekStart),
        label: weekLabel(weekStart),
        countThrough: row?.countThrough ?? null,
        timePerPiece: row?.timePerPiece ?? NO_DURATION,
        normalSeconds: row?.normalSeconds ?? null,
        deviationPercent: row?.deviationPercent ?? null,
        standstillSeconds: row?.standstillSeconds ?? null,
      });
    }

    return {
      clock: ctx.clock,
      day: p.day,
      station,
      timeline,
      distribution,
      distributionPeriod: { from: trendFrom, to: trendTo },
      trend,
    };
  });
}

