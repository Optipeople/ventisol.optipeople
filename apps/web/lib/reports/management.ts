// Ledelse: the three KPIs month against month, lead time month by month,
// kalkule mod målt, the monthly report, the management notes and the frozen
// snapshots. SQL: rpt.month_report, rpt.calc_vs_measured, rpt.period_kpis,
// rpt.lead_time_series, and the tables rpt.management_notes and rpt.snapshots.
//
// Access: admin and ledelse, checked here (requireCapability) and again in
// the database (rpt.require_role, row level security). Kalkule mod målt is
// admin, ledelse and planner. A viewer gets ReportAccessError from all of it.

import { z } from "zod";
import { withService, type Claims, type Db } from "@/lib/db";
import { audit } from "@/lib/portal/audit";
import {
  buildBottleneck,
  toLeadTimePoint,
  toPeriodKpis,
  type KpiRaw,
  type SeriesRaw,
  type StepRaw,
} from "./overview";
import {
  addMonths,
  clockSchema,
  contextFor,
  daySchema,
  duration,
  fromDb,
  loadSettings,
  monthEnd,
  monthSchema,
  nowSchema,
  percentChange,
  report,
  requireCapability,
  rows,
  stationNoSchema,
  type ReportContext,
} from "./shared";
import { stationAttention, toStationRow, withPlaceholders, type StationRaw } from "./stations";
import type {
  CalcVsMeasured,
  CalcVsMeasuredRow,
  CalcVsMeasuredType,
  Clock,
  FreezeResult,
  LeadTimePoint,
  ManagementNotes,
  MonthReport,
  MonthReportResult,
  Period,
  PeriodKpis,
  ReportSettings,
  SnapshotInfo,
} from "./types";

type StationListRaw = Parameters<typeof withPlaceholders>[1][number];

// ---------------------------------------------------------------------------
// Kalkule mod målt
// ---------------------------------------------------------------------------

interface CalcRaw {
  stationNo: number;
  stationName: string;
  stationKind: string | null;
  elementTypeId: string;
  elementTypeName: string;
  calculatedSeconds: number | null;
  normalSeconds: number | null;
  passes: number;
  reworkPasses: number;
  medianSeconds: number | null;
  medianWorkingSeconds: number | null;
  meanSeconds: number | null;
}

/** Rows of rpt.calc_vs_measured with the deviation, and the same per element type. */
export function buildCalcVsMeasured(period: Period, raw: CalcRaw[], ctx: ReportContext): CalcVsMeasured {
  const threshold = ctx.settings.calculationDeviationThresholdPercent;
  const flaggedAt = (percent: number | null) => percent != null && Math.abs(percent) > threshold;

  const calcRows: CalcVsMeasuredRow[] = raw.map(({ medianSeconds, medianWorkingSeconds, ...r }) => {
    const measured = duration(medianSeconds, medianWorkingSeconds, ctx.useWorking);
    const deviationPercent = percentChange(measured.seconds, r.calculatedSeconds);
    return { ...r, measured, deviationPercent, flagged: flaggedAt(deviationPercent) };
  });

  const byType = new Map<string, CalcVsMeasuredType>();
  for (const r of calcRows) {
    let t = byType.get(r.elementTypeId);
    if (!t) {
      t = {
        elementTypeId: r.elementTypeId,
        elementTypeName: r.elementTypeName,
        calculatedSeconds: null,
        measuredSeconds: null,
        deviationPercent: null,
        flagged: false,
        stationsCompared: 0,
        stationsIncomplete: 0,
        passes: 0,
      };
      byType.set(r.elementTypeId, t);
    }
    t.passes += r.passes;
    if (r.calculatedSeconds != null && r.measured.seconds != null) {
      t.calculatedSeconds = (t.calculatedSeconds ?? 0) + r.calculatedSeconds;
      t.measuredSeconds = (t.measuredSeconds ?? 0) + r.measured.seconds;
      t.stationsCompared += 1;
    } else {
      t.stationsIncomplete += 1;
    }
  }
  const byElementType = [...byType.values()].map((t) => {
    const deviationPercent = percentChange(t.measuredSeconds, t.calculatedSeconds);
    return { ...t, deviationPercent, flagged: flaggedAt(deviationPercent) };
  });

  return { clock: ctx.clock, period, thresholdPercent: threshold, rows: calcRows, byElementType };
}

export const calcParams = z
  .object({
    from: daySchema,
    to: daySchema,
    elementTypeId: z.string().min(1).max(100).optional(),
    stationNo: stationNoSchema.optional(),
    clock: clockSchema,
  })
  .refine((p) => p.from <= p.to, "from must not be after to");

/**
 * Kalkule mod målt: the calculated time against the measured median, per
 * station and element type and per element type, for the passes that ended in
 * [from, to]. Roles admin, ledelse and planner. A viewer is refused.
 */
export async function getCalcVsMeasured(
  claims: Claims,
  params: z.input<typeof calcParams>
): Promise<CalcVsMeasured> {
  requireCapability(claims, "costs.view");
  const p = calcParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const raw = await rows<CalcRaw>(
      db,
      "select * from rpt.calc_vs_measured($1::date, $2::date, $3::text, $4::integer)",
      [p.from, p.to, p.elementTypeId ?? null, p.stationNo ?? null]
    );
    return buildCalcVsMeasured({ from: p.from, to: p.to }, raw, ctx);
  });
}

// ---------------------------------------------------------------------------
// The three KPIs and lead time month by month
// ---------------------------------------------------------------------------

const LEDELSE_CHECK = "select rpt.require_role('admin', 'ledelse')";

export const monthParams = z.object({ month: monthSchema, clock: clockSchema });

/**
 * The Ledelse KPIs (lead time, delivered on time, waiting) for one calendar
 * month against the calendar month before. Roles admin and ledelse.
 */
export async function getManagementKpis(claims: Claims, params: z.input<typeof monthParams>): Promise<PeriodKpis> {
  requireCapability(claims, "ledelse.view");
  const p = monthParams.parse(params);
  const previous = addMonths(p.month, -1);
  return report(claims, p.clock, async (db, ctx) => {
    await db.query(LEDELSE_CHECK);
    const sql = "select * from rpt.period_kpis($1::date, $2::date)";
    const [current] = await rows<KpiRaw>(db, sql, [p.month, monthEnd(p.month)]);
    const [before] = await rows<KpiRaw>(db, sql, [previous, monthEnd(previous)]);
    return toPeriodKpis(
      { from: p.month, to: monthEnd(p.month) },
      { from: previous, to: monthEnd(previous) },
      current,
      before,
      ctx
    );
  });
}

export const monthlyParams = z.object({
  /** The last month of the series. */
  month: monthSchema,
  months: z.number().int().min(1).max(36).default(12),
  clock: clockSchema,
});

/** Lead time month by month, ending with `month`, empty months included. Roles admin and ledelse. */
export async function getMonthlyLeadTime(
  claims: Claims,
  params: z.input<typeof monthlyParams>
): Promise<LeadTimePoint[]> {
  requireCapability(claims, "ledelse.view");
  const p = monthlyParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    await db.query(LEDELSE_CHECK);
    const raw = await rows<SeriesRaw>(
      db,
      "select * from rpt.lead_time_series($1::date, $2::date, 'month')",
      [addMonths(p.month, -(p.months - 1)), monthEnd(p.month)]
    );
    return raw.map((r) => toLeadTimePoint(r, "month", ctx));
  });
}

// ---------------------------------------------------------------------------
// The monthly report
// ---------------------------------------------------------------------------

interface NotesRaw {
  month: string;
  highlights: unknown;
  decisions: unknown;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface MonthRaw {
  month: string;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  generatedAt: string;
  settings: ReportSettings;
  kpis: KpiRaw;
  previousKpis: KpiRaw;
  monthly: SeriesRaw[];
  weekly: SeriesRaw[];
  steps: StepRaw[];
  stations: StationRaw[];
  stationList: StationListRaw[];
  calcVsMeasured: CalcRaw[];
  notes: NotesRaw | null;
  missingScanOuts: number;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function toNotes(month: string, raw: NotesRaw | null | undefined): ManagementNotes {
  return {
    month,
    highlights: strings(raw?.highlights),
    decisions: strings(raw?.decisions),
    updatedAt: raw?.updatedAt ?? null,
    updatedBy: raw?.updatedBy ?? null,
  };
}

/** The payload of rpt.month_report as the report the page shows and a snapshot stores. */
async function computeMonthReport(db: Db, month: string, now: number, clock: Clock | undefined): Promise<MonthReport> {
  const [row] = await db.query<{ report: unknown }>(
    "select rpt.month_report($1::date, $2::timestamptz) as report",
    [month, new Date(now)]
  );
  const raw = fromDb<MonthRaw>(row.report);
  const ctx = contextFor(raw.settings, clock);
  const period = { from: raw.from, to: raw.to };
  const stations = withPlaceholders(raw.stations, raw.stationList).map((s) => toStationRow(s, ctx));
  return {
    version: 1,
    month: raw.month,
    period,
    generatedAt: raw.generatedAt,
    clock: ctx.clock,
    settings: raw.settings,
    kpis: toPeriodKpis(period, { from: raw.previousFrom, to: raw.previousTo }, raw.kpis, raw.previousKpis, ctx),
    leadTimeMonthly: raw.monthly.map((r) => toLeadTimePoint(r, "month", ctx)),
    leadTimeWeekly: raw.weekly.map((r) => toLeadTimePoint(r, "week", ctx)),
    bottleneck: buildBottleneck(period, raw.steps, raw.stations, ctx),
    stations,
    stationAttention: stationAttention(stations),
    calcVsMeasured: buildCalcVsMeasured(period, raw.calcVsMeasured, ctx),
    notes: toNotes(raw.month, raw.notes),
    missingScanOuts: raw.missingScanOuts,
  };
}

interface SnapshotRaw {
  month: string;
  frozenAt: string;
  pdfPath: string | null;
}

async function snapshotOn(db: Db, month: string): Promise<MonthReportResult | null> {
  // `numbers` is a stored MonthReport, camelCase already: it is not converted.
  const [row] = await db.query<{ month: string; frozen_at: Date; numbers: MonthReport; pdf_path: string | null }>(
    "select month, frozen_at, numbers, pdf_path from rpt.snapshots where month = $1::date",
    [month]
  );
  if (!row) return null;
  return { report: row.numbers, frozen: true, frozenAt: new Date(row.frozen_at).toISOString(), pdfPath: row.pdf_path };
}

export const monthReportParams = z.object({
  month: monthSchema,
  now: nowSchema,
  /** True: compute from the current facts even when the month is frozen. */
  live: z.boolean().default(false),
  clock: clockSchema,
});

/**
 * The monthly report: the frozen snapshot when the month has one (unless
 * `live`), else computed now. Roles admin and ledelse.
 */
export async function getMonthReport(
  claims: Claims,
  params: z.input<typeof monthReportParams>
): Promise<MonthReportResult> {
  requireCapability(claims, "ledelse.view");
  const p = monthReportParams.parse(params);
  return report(claims, p.clock, async (db) => {
    await db.query(LEDELSE_CHECK);
    if (!p.live) {
      const frozen = await snapshotOn(db, p.month);
      if (frozen) return frozen;
    }
    return { report: await computeMonthReport(db, p.month, p.now, p.clock), frozen: false, frozenAt: null, pdfPath: null };
  });
}

/** The frozen months, newest first. Roles admin and ledelse. */
export async function listSnapshots(claims: Claims): Promise<SnapshotInfo[]> {
  requireCapability(claims, "ledelse.view");
  return report(claims, undefined, async (db) => {
    await db.query(LEDELSE_CHECK);
    return rows<SnapshotRaw>(db, "select month, frozen_at, pdf_path from rpt.snapshots order by month desc");
  });
}

export const snapshotParams = z.object({ month: monthSchema });

/** One frozen month, or null when it is not frozen. Roles admin and ledelse. */
export async function getSnapshot(
  claims: Claims,
  params: z.input<typeof snapshotParams>
): Promise<MonthReportResult | null> {
  requireCapability(claims, "ledelse.view");
  const p = snapshotParams.parse(params);
  return report(claims, undefined, async (db) => {
    await db.query(LEDELSE_CHECK);
    return snapshotOn(db, p.month);
  });
}

const freezeOptions = z.object({ force: z.boolean().default(false) });

/**
 * Freezes the report of `month` into rpt.snapshots. Service code (the monthly
 * cron): there are no claims, so call it only from a route that has checked
 * its own caller. Idempotent: a month that is frozen already is left alone
 * unless `force`.
 */
export async function freezeMonth(
  month: string,
  now: number,
  options: z.input<typeof freezeOptions> = {}
): Promise<FreezeResult> {
  const m = monthSchema.parse(month);
  const at = nowSchema.parse(now);
  const { force } = freezeOptions.parse(options);
  return withService(async (db) => {
    const [existing] = await db.query<{ frozen_at: Date }>(
      "select frozen_at from rpt.snapshots where month = $1::date",
      [m]
    );
    if (existing && !force) {
      return { month: m, written: false, frozenAt: new Date(existing.frozen_at).toISOString() };
    }
    const settings = await loadSettings(db);
    const numbers = await computeMonthReport(db, m, at, contextFor(settings).clock);
    await db.query(
      `insert into rpt.snapshots (month, frozen_at, numbers)
       values ($1::date, $2::timestamptz, $3::jsonb)
       on conflict (month) do update set frozen_at = excluded.frozen_at, numbers = excluded.numbers`,
      [m, new Date(at), JSON.stringify(numbers)]
    );
    return { month: m, written: true, frozenAt: new Date(at).toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Management notes
// ---------------------------------------------------------------------------

/** The notes of one month ("Det vigtigste", "Til beslutning"). Empty lists when none are written. Roles admin and ledelse. */
export async function getManagementNotes(
  claims: Claims,
  params: z.input<typeof snapshotParams>
): Promise<ManagementNotes> {
  requireCapability(claims, "ledelse.view");
  const p = snapshotParams.parse(params);
  return report(claims, undefined, async (db) => {
    await db.query(LEDELSE_CHECK);
    const [raw] = await rows<NotesRaw>(
      db,
      "select month, highlights, decisions, updated_at, updated_by from rpt.management_notes where month = $1::date",
      [p.month]
    );
    return toNotes(p.month, raw);
  });
}

const noteLines = z.array(z.string().trim().min(1).max(1000)).max(20);
export const saveNotesParams = z.object({ month: monthSchema, highlights: noteLines, decisions: noteLines, now: nowSchema });

/**
 * Writes the notes of one month and leaves an audit row
 * ("management_notes.saved") in the same transaction. Roles admin and ledelse.
 */
export async function saveManagementNotes(
  claims: Claims,
  params: z.input<typeof saveNotesParams>
): Promise<ManagementNotes> {
  requireCapability(claims, "ledelse.view");
  const p = saveNotesParams.parse(params);
  return report(claims, undefined, async (db) => {
    await db.query(LEDELSE_CHECK);
    const [raw] = await rows<NotesRaw>(
      db,
      `insert into rpt.management_notes (month, highlights, decisions, updated_at, updated_by)
       values ($1::date, $2::jsonb, $3::jsonb, $4::timestamptz, app.current_user_id())
       on conflict (month) do update
         set highlights = excluded.highlights, decisions = excluded.decisions,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by
       returning month, highlights, decisions, updated_at, updated_by`,
      [p.month, JSON.stringify(p.highlights), JSON.stringify(p.decisions), new Date(p.now)]
    );
    await audit(db, "management_notes.saved", p.month, {
      highlights: p.highlights.length,
      decisions: p.decisions.length,
    });
    return toNotes(p.month, raw);
  });
}
