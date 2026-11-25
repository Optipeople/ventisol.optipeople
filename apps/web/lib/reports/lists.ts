// The working lists (missing scan outs, packed orders with elements missing,
// the baseline suggestion for normal times) and the two chat questions that
// have no data yet (capacity plan, staffing). SQL: rpt.missing_scan_outs,
// rpt.incomplete_packed_orders, rpt.baseline_suggestion, rpt.capacity_plan,
// rpt.staffing. All four roles may call these: none of them returns a
// calculated time.

import { z } from "zod";
import type { Claims } from "@/lib/db";
import { formatClock, isoWeek, startOfWeek } from "@/lib/time";
import {
  clockSchema,
  daySchema,
  duration,
  nowSchema,
  pageShape,
  paged,
  report,
  requireCapability,
  rows,
  stationNoSchema,
} from "./shared";
import type {
  BaselineSuggestion,
  BaselineSuggestionRow,
  CapacityDay,
  CapacityPlan,
  IncompletePackedOrder,
  MissingScanOut,
  Paged,
  StaffingAnalysis,
  StaffingDay,
} from "./types";

const MISSING_REASON_LABELS: Record<NonNullable<MissingScanOut["missingReason"]>, string> = {
  stale: "Ingen ud-scanning i 36 timer",
  superseded: "Afløst af en senere ind-scanning",
};

/** Why a row is on the list, in Danish: the missing reason, or when the station stopped it. */
export function missingScanOutReason(row: Pick<MissingScanOut, "kind" | "missingReason" | "endAt">): string {
  if (row.kind === "auto_stopped") {
    return row.endAt ? `Stoppet ved vagtskifte ${formatClock(Date.parse(row.endAt))}` : "Stoppet ved vagtskifte";
  }
  return row.missingReason ? (MISSING_REASON_LABELS[row.missingReason] ?? row.missingReason) : "";
}

export const missingScanOutsParams = z
  .object({ from: daySchema.optional(), to: daySchema.optional(), ...pageShape })
  .refine((p) => !p.from || !p.to || p.from <= p.to, "from must not be after to");

type MissingRaw = Omit<MissingScanOut, "reasonLabel"> & { totalCount: number };

/**
 * Passes that were scanned In and never Out, newest first: the missing
 * scan-outs (kind missing, they count in no time), and the passes the station
 * stopped at shift end (kind auto_stopped, with endAt: forgotten scan-outs
 * that were caught; they count in times up to the stop). The period is on the
 * local day of the In scan for a missing one, of the stop for an auto-stop;
 * without it the whole history is listed.
 */
export async function listMissingScanOuts(
  claims: Claims,
  params: z.input<typeof missingScanOutsParams> = {}
): Promise<Paged<MissingScanOut>> {
  requireCapability(claims, "reports.view");
  const p = missingScanOutsParams.parse(params);
  return report(claims, undefined, (db) =>
    paged(
      p.page,
      p.pageSize,
      (limit, offset) =>
        rows<MissingRaw>(
          db,
          "select * from rpt.missing_scan_outs($1::date, $2::date, $3::integer, $4::integer)",
          [p.from ?? null, p.to ?? null, limit, offset]
        ),
      (raw): MissingScanOut => {
        const { totalCount, ...row } = raw;
        void totalCount;
        return { ...row, reasonLabel: missingScanOutReason(row) };
      }
    )
  );
}

export const incompletePackedParams = z.object({
  now: nowSchema,
  /** Hours without a scan before an order counts as left behind. */
  quietHours: z.number().int().min(0).max(24 * 365).default(12),
  ...pageShape,
});

type IncompleteRaw = IncompletePackedOrder & { totalCount: number };

/**
 * Orders where something is packed, a 3E position is still not fully packed,
 * and nothing has been scanned for `quietHours`. Newest last scan first.
 */
export async function listIncompletePackedOrders(
  claims: Claims,
  params: z.input<typeof incompletePackedParams>
): Promise<Paged<IncompletePackedOrder>> {
  requireCapability(claims, "reports.view");
  const p = incompletePackedParams.parse(params);
  return report(claims, undefined, (db) =>
    paged(
      p.page,
      p.pageSize,
      (limit, offset) =>
        rows<IncompleteRaw>(
          db,
          "select * from rpt.incomplete_packed_orders($1::timestamptz, $2::integer, $3::integer, $4::integer)",
          [new Date(p.now), p.quietHours, limit, offset]
        ),
      (raw): IncompletePackedOrder => {
        const { totalCount, ...row } = raw;
        void totalCount;
        return { ...row, missingElements: Array.isArray(row.missingElements) ? row.missingElements : [] };
      }
    )
  );
}

export const baselineParams = z
  .object({
    from: daySchema,
    to: daySchema,
    /** Station and element type pairs with fewer finished passes are left out. */
    minSamples: z.number().int().min(1).max(100_000).default(5),
    clock: clockSchema,
  })
  .refine((p) => p.from <= p.to, "from must not be after to");

interface BaselineRaw extends Omit<BaselineSuggestionRow, "suggestedSeconds" | "median"> {
  medianSeconds: number;
  medianWorkingSeconds: number | null;
}

/**
 * The suggestion for normal times: the median time of the finished first
 * passes that ended in [from, to], per station and element type, next to the
 * normal time in force. Nothing is written: saving is the settings pages' job.
 */
export async function getBaselineSuggestion(
  claims: Claims,
  params: z.input<typeof baselineParams>
): Promise<BaselineSuggestion> {
  requireCapability(claims, "reports.view");
  const p = baselineParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const raw = await rows<BaselineRaw>(
      db,
      "select * from rpt.baseline_suggestion($1::date, $2::date, $3::integer)",
      [p.from, p.to, p.minSamples]
    );
    const days = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
    return {
      clock: ctx.clock,
      period: { from: p.from, to: p.to },
      weeks: Math.round((days / 7) * 10) / 10,
      rows: raw.map(({ medianSeconds, medianWorkingSeconds, ...r }): BaselineSuggestionRow => {
        const median = duration(medianSeconds, medianWorkingSeconds, ctx.useWorking);
        return { ...r, suggestedSeconds: median.seconds ?? medianSeconds, median };
      }),
    };
  });
}

export const capacityParams = z.object({
  /** Any day of the week asked about. */
  day: daySchema,
});

type CapacityRaw = CapacityDay & { assemblyStations: number; openOrdersDue: number };

/**
 * The capacity plan of a week. Planned orders are not delivered from 3E yet,
 * so `available` is false and only the calendar side is filled in.
 */
export async function getCapacityPlan(claims: Claims, params: z.input<typeof capacityParams>): Promise<CapacityPlan> {
  requireCapability(claims, "reports.view");
  const p = capacityParams.parse(params);
  const weekStart = startOfWeek(p.day);
  return report(claims, undefined, async (db) => {
    const raw = await rows<CapacityRaw>(db, "select * from rpt.capacity_plan($1::date)", [weekStart]);
    return {
      available: false,
      reason: "no_planned_orders",
      message:
        "Ingen data endnu: kapacitetsplanen kræver planlagte ordrer fra 3E, og dem får portalen ikke endnu. Kalenderen for ugen er vist.",
      weekStart,
      isoWeek: isoWeek(weekStart),
      days: raw.map(
        ({ day, weekday, closed, closedName, shiftSeconds, plannedOrders, plannedLoadSeconds }): CapacityDay => ({
          day,
          weekday,
          closed,
          closedName,
          shiftSeconds,
          plannedOrders,
          plannedLoadSeconds,
        })
      ),
      assemblyStations: raw[0]?.assemblyStations ?? 0,
      openOrdersDue: raw[0]?.openOrdersDue ?? 0,
    };
  });
}

export const staffingParams = z
  .object({ from: daySchema, to: daySchema, stationNo: stationNoSchema.optional(), clock: clockSchema })
  .refine((p) => p.from <= p.to, "from must not be after to");

interface StaffingRaw extends Omit<StaffingDay, "timePerPiece"> {
  timePerPieceSeconds: number | null;
  timePerPieceWorkingSeconds: number | null;
}

/**
 * The staffing analysis. The number of people per station is not recorded
 * anywhere yet, so `available` is false and only the output side is filled in.
 */
export async function getStaffingAnalysis(
  claims: Claims,
  params: z.input<typeof staffingParams>
): Promise<StaffingAnalysis> {
  requireCapability(claims, "reports.view");
  const p = staffingParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const raw = await rows<StaffingRaw>(db, "select * from rpt.staffing($1::date, $2::date, $3::integer)", [
      p.from,
      p.to,
      p.stationNo ?? null,
    ]);
    return {
      available: false,
      reason: "no_staffing_data",
      message:
        "Ingen data endnu: bemandingen pr. station bliver ikke registreret, så den kan ikke holdes op mod produktionen. Antal og tid pr. styk er vist.",
      clock: ctx.clock,
      period: { from: p.from, to: p.to },
      days: raw.map(({ timePerPieceSeconds, timePerPieceWorkingSeconds, ...r }): StaffingDay => ({
        ...r,
        timePerPiece: duration(timePerPieceSeconds, timePerPieceWorkingSeconds, ctx.useWorking),
      })),
    };
  });
}
