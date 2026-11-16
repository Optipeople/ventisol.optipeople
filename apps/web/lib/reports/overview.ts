// Overblik: the period KPIs against the period before, lead time per week or
// month, where the time goes (the seven steps and the bottleneck), and the
// today strip. SQL: rpt.period_kpis, rpt.lead_time_series, rpt.step_times,
// rpt.today, rpt.station_performance.

import { z } from "zod";
import type { Claims, Db } from "@/lib/db";
import { STEP_LABELS, type StepKey, type StepKind, type StepSource } from "@/lib/derive";
import { formatDuration, monthLabel, weekLabel } from "./format";
import { inProgressOn } from "./orders";
import {
  daySchema,
  clockSchema,
  dayOf,
  duration,
  NO_DURATION,
  nowSchema,
  percentChange,
  periodSchema,
  previousPeriod,
  report,
  rows,
  type ReportContext,
} from "./shared";
import { stationAttention, stationDayOn, type StationRaw } from "./stations";
import type {
  Bottleneck,
  BottleneckStation,
  Duration,
  KpiChange,
  KpiSet,
  KpiSummary,
  LeadTimePoint,
  Period,
  PeriodKpis,
  StepTime,
  TodayStrip,
} from "./types";

// ---------------------------------------------------------------------------
// Raw rows and the pure steps from them (shared with the monthly report)
// ---------------------------------------------------------------------------

export interface KpiRaw {
  ordersPacked: number;
  elementsPacked: number;
  leadSeconds: number | null;
  leadWorkingSeconds: number | null;
  workSeconds: number | null;
  workWorkingSeconds: number | null;
  waitSeconds: number | null;
  waitWorkingSeconds: number | null;
  onTimeOrders: number;
  onTimeKnown: number;
  onTimePercent: number | null;
  reworkOrders: number;
}

export function toKpiSet(raw: KpiRaw, ctx: ReportContext): KpiSet {
  return {
    ordersPacked: raw.ordersPacked,
    elementsPacked: raw.elementsPacked,
    lead: duration(raw.leadSeconds, raw.leadWorkingSeconds, ctx.useWorking),
    wait: duration(raw.waitSeconds, raw.waitWorkingSeconds, ctx.useWorking),
    work: duration(raw.workSeconds, raw.workWorkingSeconds, ctx.useWorking),
    onTimePercent: raw.onTimePercent == null ? null : Number(raw.onTimePercent),
    onTimeOrders: raw.onTimeOrders,
    onTimeKnown: raw.onTimeKnown,
    reworkOrders: raw.reworkOrders,
  };
}

export function kpiChange(current: KpiSet, previous: KpiSet): KpiChange {
  return {
    leadPercent: percentChange(current.lead.seconds, previous.lead.seconds),
    waitPercent: percentChange(current.wait.seconds, previous.wait.seconds),
    onTimePoints:
      current.onTimePercent == null || previous.onTimePercent == null
        ? null
        : Math.round(current.onTimePercent - previous.onTimePercent),
    ordersPercent: percentChange(current.ordersPacked, previous.ordersPacked),
  };
}

export function toPeriodKpis(
  period: Period,
  previous: Period,
  currentRaw: KpiRaw,
  previousRaw: KpiRaw,
  ctx: ReportContext
): PeriodKpis {
  const current = toKpiSet(currentRaw, ctx);
  const before = toKpiSet(previousRaw, ctx);
  return {
    clock: ctx.clock,
    period,
    previousPeriod: previous,
    current,
    previous: before,
    change: kpiChange(current, before),
  };
}

export interface SeriesRaw {
  bucketStart: string;
  bucketEnd: string;
  isoYear: number;
  isoWeek: number;
  ordersPacked: number;
  leadSeconds: number | null;
  leadWorkingSeconds: number | null;
  workSeconds: number | null;
  workWorkingSeconds: number | null;
  waitSeconds: number | null;
  waitWorkingSeconds: number | null;
}

export function toLeadTimePoint(raw: SeriesRaw, bucket: "week" | "month", ctx: ReportContext): LeadTimePoint {
  return {
    bucket,
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    isoYear: raw.isoYear,
    isoWeek: raw.isoWeek,
    label: bucket === "week" ? weekLabel(raw.bucketStart) : monthLabel(raw.bucketStart),
    ordersPacked: raw.ordersPacked,
    lead: duration(raw.leadSeconds, raw.leadWorkingSeconds, ctx.useWorking),
    work: duration(raw.workSeconds, raw.workWorkingSeconds, ctx.useWorking),
    wait: duration(raw.waitSeconds, raw.waitWorkingSeconds, ctx.useWorking),
  };
}

export interface StepRaw {
  step: StepKey;
  seq: number;
  kind: StepKind;
  source: StepSource;
  orders: number;
  ordersWithData: number;
  durationSeconds: number | null;
  durationWorkingSeconds: number | null;
  workSeconds: number | null;
  workWorkingSeconds: number | null;
  waitSeconds: number | null;
  waitWorkingSeconds: number | null;
  assumedOrders: number;
  assumedSeconds: number | null;
}

/**
 * Sums to whole-second averages per order that still add up: the total is
 * rounded once, each part is rounded down, and the seconds left over go to
 * the parts that were cut the most (largest remainder, as roundParts() in
 * lib/derive does for one order). Null sums stay null.
 */
export function averageParts(sums: (number | null)[], orders: number): (number | null)[] {
  if (orders <= 0) return sums.map(() => null);
  const exact = sums.map((s) => (s == null ? null : s / orders));
  const out = exact.map((v) => (v == null ? null : Math.floor(v)));
  const total = Math.round(sums.reduce<number>((a, s) => a + (s ?? 0), 0) / orders);
  let left = total - out.reduce<number>((a, v) => a + (v ?? 0), 0);
  const byRemainder = exact
    .map((v, i) => ({ i, r: v == null ? -1 : v - Math.floor(v) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && byRemainder.length > 0; k++, left--) {
    const i = byRemainder[k % byRemainder.length].i;
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

/** Work and wait of one step so that they add up to its duration. */
function split(total: number | null, workSum: number | null, waitSum: number | null, orders: number) {
  if (total == null || orders <= 0) return { work: null, wait: null };
  if (workSum == null && waitSum == null) return { work: null, wait: null };
  const work = Math.min(total, Math.round((workSum ?? 0) / orders));
  return { work, wait: total - work };
}

/** The seven steps as averages per order. The measured ones add up to the average lead time. */
export function toStepTimes(raw: StepRaw[], ctx: ReportContext): StepTime[] {
  const sorted = [...raw].sort((a, b) => a.seq - b.seq);
  const orders = sorted[0]?.orders ?? 0;
  const wall = averageParts(sorted.map((s) => s.durationSeconds), orders);
  const working = averageParts(sorted.map((s) => s.durationWorkingSeconds), orders);
  return sorted.map((s, i) => {
    const measured = s.source === "scans" || s.source === "machine";
    if (!measured) {
      const assumed =
        s.source === "assumed" && s.assumedSeconds != null && s.assumedOrders > 0
          ? Math.round(s.assumedSeconds / s.assumedOrders)
          : null;
      // An assumed time is a setting, the same on both clocks.
      const d: Duration = assumed == null ? NO_DURATION : { seconds: assumed, wallSeconds: assumed, workingSeconds: assumed };
      return {
        step: s.step,
        seq: s.seq,
        kind: s.kind,
        label: STEP_LABELS[s.step],
        source: s.source,
        countsInLead: false,
        orders,
        ordersWithData: s.ordersWithData,
        duration: d,
        work: s.kind === "work" ? d : NO_DURATION,
        wait: s.kind === "wait" ? d : NO_DURATION,
      };
    }
    const w = split(wall[i], s.workSeconds, s.waitSeconds, orders);
    const k = split(working[i], s.workWorkingSeconds, s.waitWorkingSeconds, orders);
    return {
      step: s.step,
      seq: s.seq,
      kind: s.kind,
      label: STEP_LABELS[s.step],
      source: s.source,
      countsInLead: true,
      orders,
      ordersWithData: s.ordersWithData,
      duration: duration(wall[i], working[i], ctx.useWorking),
      work: duration(w.work, k.work, ctx.useWorking),
      wait: duration(w.wait, k.wait, ctx.useWorking),
    };
  });
}

/** "Bufferen", "Montagen": the step as the subject of the bottleneck sentence. */
const STEP_SUBJECT: Record<StepKey, string> = {
  schirmer: "Schirmer",
  wait_kmw: "Ventetiden før KMW",
  kmw: "KMW-anlægget",
  buffer: "Bufferen",
  assembly: "Montagen",
  wait_packing: "Ventetiden før pakning",
  packing: "Pakningen",
};

/**
 * The bottleneck: the measured step with the largest average waiting time on
 * the headline clock. A tie goes to the earlier step. Steps with no data are
 * skipped and named in missingSteps. None when no order was packed or nothing
 * waits.
 */
export function buildBottleneck(
  period: Period,
  stepRaw: StepRaw[],
  stationRaw: StationRaw[],
  ctx: ReportContext
): Bottleneck {
  const steps = toStepTimes(stepRaw, ctx);
  const ordersPacked = steps[0]?.orders ?? 0;
  const counted = steps.filter((s) => s.countsInLead);
  const sumOf = (pick: (d: Duration) => number | null): number | null =>
    ordersPacked > 0 && counted.some((s) => pick(s.duration) != null)
      ? counted.reduce((a, s) => a + (pick(s.duration) ?? 0), 0)
      : null;
  const lead = duration(sumOf((d) => d.wallSeconds), sumOf((d) => d.workingSeconds), ctx.useWorking);

  let worst: StepTime | null = null;
  for (const s of counted) {
    const wait = s.wait.seconds;
    if (wait == null || wait <= 0) continue;
    if (!worst || wait > (worst.wait.seconds ?? 0)) worst = s;
  }
  const bottleneck = worst
    ? { step: worst.step, label: worst.label, waitSeconds: worst.wait.seconds ?? 0 }
    : null;

  const sentence =
    ordersPacked === 0
      ? "Ingen ordrer er pakket i perioden, så der er ingen flaskehals at pege på."
      : bottleneck
        ? `${STEP_SUBJECT[bottleneck.step]} er flaskehalsen. Her venter en ordre i snit ${formatDuration(bottleneck.waitSeconds)}.`
        : "Ingen flaskehals: ordrerne ventede ikke målbart i perioden.";

  const stations: BottleneckStation[] = stationRaw
    .filter((s) => s.hasFacts && (s.countThrough ?? 0) > 0)
    .map((s) => ({
      stationNo: s.stationNo,
      name: s.name,
      kind: s.kind,
      passes: s.countThrough ?? 0,
      avgWaitBefore: duration(s.avgWaitBeforeSeconds, s.avgWaitBeforeWorkingSeconds, ctx.useWorking),
      longestWaitBefore: duration(
        s.longestWaitBeforeSeconds,
        s.longestWaitBeforeWorkingSeconds,
        ctx.useWorking
      ),
    }))
    .sort((a, b) => (b.avgWaitBefore.seconds ?? -1) - (a.avgWaitBefore.seconds ?? -1) || a.stationNo - b.stationNo);

  return {
    clock: ctx.clock,
    period,
    ordersPacked,
    lead,
    steps,
    bottleneck,
    sentence,
    missingSteps: steps.filter((s) => s.source === "none").map((s) => s.label),
    stations,
  };
}

// ---------------------------------------------------------------------------
// Queries on an open transaction
// ---------------------------------------------------------------------------

export async function periodKpisOn(db: Db, ctx: ReportContext, from: string, to: string): Promise<PeriodKpis> {
  const previous = previousPeriod(from, to);
  const sql = "select * from rpt.period_kpis($1::date, $2::date)";
  const [current] = await rows<KpiRaw>(db, sql, [from, to]);
  const [before] = await rows<KpiRaw>(db, sql, [previous.from, previous.to]);
  return toPeriodKpis({ from, to }, previous, current, before, ctx);
}

export async function bottleneckOn(db: Db, ctx: ReportContext, from: string, to: string): Promise<Bottleneck> {
  const steps = await rows<StepRaw>(db, "select * from rpt.step_times($1::date, $2::date)", [from, to]);
  const stations = await rows<StationRaw>(
    db,
    "select * from rpt.station_performance($1::date, $2::date, null, 'all')",
    [from, to]
  );
  return buildBottleneck({ from, to }, steps, stations, ctx);
}

export async function todayOn(db: Db, now: number): Promise<TodayStrip> {
  const day = dayOf(now);
  const [row] = await rows<Omit<TodayStrip, "day">>(
    db,
    "select * from rpt.today($1::date, $2::timestamptz)",
    [day, new Date(now)]
  );
  return { day, ...row };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * The KPIs of the orders packed in [from, to] and of the period of equal
 * length right before it, with the change. Any role.
 */
export async function getPeriodKpis(claims: Claims, params: z.input<typeof periodSchema>): Promise<PeriodKpis> {
  const p = periodSchema.parse(params);
  return report(claims, p.clock, (db, ctx) => periodKpisOn(db, ctx, p.from, p.to));
}

export const seriesParams = z
  .object({ from: daySchema, to: daySchema, bucket: z.enum(["week", "month"]).default("week"), clock: clockSchema })
  .refine((p) => p.from <= p.to, "from must not be after to");

/**
 * Lead time per ISO week or calendar month, split in work and waiting. One
 * point per bucket that touches [from, to], the empty ones too. Any role.
 */
export async function getLeadTimeSeries(
  claims: Claims,
  params: z.input<typeof seriesParams>
): Promise<LeadTimePoint[]> {
  const p = seriesParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const raw = await rows<SeriesRaw>(
      db,
      "select * from rpt.lead_time_series($1::date, $2::date, $3::text)",
      [p.from, p.to, p.bucket]
    );
    return raw.map((r) => toLeadTimePoint(r, p.bucket, ctx));
  });
}

/**
 * Where the time of an order goes: the seven steps as averages per order,
 * the bottleneck with its Danish sentence, and the waiting in front of each
 * station. Any role.
 */
export async function getBottleneck(claims: Claims, params: z.input<typeof periodSchema>): Promise<Bottleneck> {
  const p = periodSchema.parse(params);
  return report(claims, p.clock, (db, ctx) => bottleneckOn(db, ctx, p.from, p.to));
}

export const todayParams = z.object({ now: nowSchema });

/** The today strip: orders in progress, passes and elements today, stations running. Any role. */
export async function getTodayStrip(claims: Claims, params: z.input<typeof todayParams>): Promise<TodayStrip> {
  const p = todayParams.parse(params);
  return report(claims, undefined, (db) => todayOn(db, p.now));
}

export const summaryParams = z
  .object({ from: daySchema, to: daySchema, now: nowSchema, clock: clockSchema })
  .refine((p) => p.from <= p.to, "from must not be after to");

/**
 * Everything "hvordan går det?" needs in one call: the period KPIs, the
 * bottleneck, the today strip, the stations to look at today and the orders
 * that are late or at risk. Any role.
 */
export async function getKpiSummary(claims: Claims, params: z.input<typeof summaryParams>): Promise<KpiSummary> {
  const p = summaryParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const kpis = await periodKpisOn(db, ctx, p.from, p.to);
    const bottleneck = await bottleneckOn(db, ctx, p.from, p.to);
    const today = await todayOn(db, p.now);
    const stationRows = await stationDayOn(db, ctx, today.day);
    const late = await inProgressOn(db, ctx, { now: p.now, status: "late", sort: "due", dir: "asc", pageSize: 10 });
    const atRisk = await inProgressOn(db, ctx, { now: p.now, status: "at_risk", sort: "due", dir: "asc", pageSize: 10 });
    return {
      clock: ctx.clock,
      kpis,
      bottleneck,
      today,
      stationsToday: stationAttention(stationRows),
      ordersToWatch: [...late.rows, ...atRisk.rows].slice(0, 10),
      ordersToWatchTotal: late.total + atRisk.total,
    };
  });
}
