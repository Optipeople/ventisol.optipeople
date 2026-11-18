// The report layer: the only way pages and the chat read numbers.
// See docs/reports.md for what every function returns and the definition
// behind each number.

import { z } from "zod";
import type { Claims } from "@/lib/db";
import type { Capability } from "@/lib/portal/roles";
import {
  baselineParams,
  capacityParams,
  getBaselineSuggestion,
  getCapacityPlan,
  getStaffingAnalysis,
  incompletePackedParams,
  listIncompletePackedOrders,
  listMissingScanOuts,
  missingScanOutsParams,
  staffingParams,
} from "./lists";
import { calcParams, getCalcVsMeasured, getManagementKpis, getMonthlyLeadTime, monthParams, monthlyParams } from "./management";
import {
  findOrders,
  findParams,
  finishedParams,
  getOrderRoute,
  getOrderStatus,
  inProgressParams,
  listFinishedOrders,
  listInProgressOrders,
  orderParams,
} from "./orders";
import {
  getBottleneck,
  getKpiSummary,
  getLeadTimeSeries,
  getPeriodKpis,
  getTodayStrip,
  seriesParams,
  summaryParams,
  todayParams,
} from "./overview";
import { periodSchema, requireCapability } from "./shared";
import { getStationDay, getStationPerformance, listStations, stationDayParams, stationPeriodParams } from "./stations";

export * from "./types";
export * from "./format";
export { ReportAccessError } from "./shared";
export { getPeriodKpis, getLeadTimeSeries, getBottleneck, getTodayStrip, getKpiSummary } from "./overview";
export { listStations, getStationDay, getStationPerformance, getStationDetail, STATION_KIND_LABELS } from "./stations";
export {
  listFinishedOrders,
  listInProgressOrders,
  listDeliveryWeeks,
  findOrders,
  getOrderDetail,
  getOrderStatus,
  getOrderRoute,
  getOrderDocuments,
  type DeliveryWeekCount,
} from "./orders";
export {
  getCalcVsMeasured,
  getManagementKpis,
  getMonthlyLeadTime,
  getMonthReport,
  listSnapshots,
  getSnapshot,
  freezeMonth,
  getManagementNotes,
  saveManagementNotes,
} from "./management";
export {
  listMissingScanOuts,
  listIncompletePackedOrders,
  getBaselineSuggestion,
  getCapacityPlan,
  getStaffingAnalysis,
} from "./lists";

// ---------------------------------------------------------------------------
// The registry the chat tools run from
// ---------------------------------------------------------------------------

/** One query the chat may run: nothing outside REPORT_QUERIES is reachable from a tool call. */
export interface ReportQuery<S extends z.ZodType = z.ZodType, R = unknown> {
  /** One line for the tool description. English. */
  description: string;
  /** The role needs this capability. Checked before the parameters are read. */
  capability: Capability;
  /** Validates the tool input. */
  schema: S;
  run: (claims: Claims, params: z.input<S>) => Promise<R>;
}

const query = <S extends z.ZodType, R>(q: ReportQuery<S, R>): ReportQuery<S, R> => q;

const noParams = z.object({});

export const REPORT_QUERIES = {
  find_order: query({
    description: "Find orders by order number, customer or case name.",
    capability: "reports.view",
    schema: findParams,
    run: findOrders,
  }),
  order_status: query({
    description: "Where one order is now, its delivery status and what deviates.",
    capability: "reports.view",
    schema: orderParams,
    run: getOrderStatus,
  }),
  order_route: query({
    description: "The route of one order: the seven steps and every pass at a station.",
    capability: "reports.view",
    schema: orderParams,
    run: getOrderRoute,
  }),
  finished_orders: query({
    description: "Packed orders in a period, with search, sorting and paging.",
    capability: "reports.view",
    schema: finishedParams,
    run: listFinishedOrders,
  }),
  orders_in_progress: query({
    description: "Orders in progress now, with forecast and delivery status.",
    capability: "reports.view",
    schema: inProgressParams,
    run: listInProgressOrders,
  }),
  bottleneck: query({
    description: "The step where orders waited the longest in a period, with all seven steps.",
    capability: "reports.view",
    schema: periodSchema,
    run: getBottleneck,
  }),
  period_kpis: query({
    description: "Lead time, delivered on time and waiting for a period against the period before.",
    capability: "reports.view",
    schema: periodSchema,
    run: getPeriodKpis,
  }),
  lead_time_series: query({
    description: "Lead time per week or month over a period.",
    capability: "reports.view",
    schema: seriesParams,
    run: getLeadTimeSeries,
  }),
  kpi_summary: query({
    description: "The overview in one answer: KPIs, bottleneck, today and stations that need attention.",
    capability: "reports.view",
    schema: summaryParams,
    run: getKpiSummary,
  }),
  today: query({
    description: "Today's numbers: orders in progress, at risk, packed today, stations running.",
    capability: "reports.view",
    schema: todayParams,
    run: getTodayStrip,
  }),
  stations: query({
    description: "The stations with their normal times.",
    capability: "reports.view",
    schema: noParams,
    run: (claims: Claims) => listStations(claims),
  }),
  station_day: query({
    description: "Every station on one day: count, time per piece, status.",
    capability: "reports.view",
    schema: stationDayParams,
    run: getStationDay,
  }),
  station_performance: query({
    description: "Station performance over a period, all stations or one.",
    capability: "reports.view",
    schema: stationPeriodParams,
    run: getStationPerformance,
  }),
  calc_vs_measured: query({
    description: "Calculated time against measured time per station and element type.",
    capability: "costs.view",
    schema: calcParams,
    run: getCalcVsMeasured,
  }),
  management_kpis: query({
    description: "The management KPIs of a calendar month against the month before.",
    capability: "ledelse.view",
    schema: monthParams,
    run: getManagementKpis,
  }),
  monthly_lead_time: query({
    description: "Lead time month by month.",
    capability: "ledelse.view",
    schema: monthlyParams,
    run: getMonthlyLeadTime,
  }),
  missing_scan_outs: query({
    description: "Passes scanned In and never Out.",
    capability: "reports.view",
    schema: missingScanOutsParams,
    run: listMissingScanOuts,
  }),
  incomplete_packed_orders: query({
    description: "Orders with something packed and elements still missing.",
    capability: "reports.view",
    schema: incompletePackedParams,
    run: listIncompletePackedOrders,
  }),
  baseline_suggestion: query({
    description: "Suggested normal times from the measured median per station and element type.",
    capability: "reports.view",
    schema: baselineParams,
    run: getBaselineSuggestion,
  }),
  capacity_plan: query({
    description: "The capacity plan of a week. No planned orders yet: answers available false with the calendar.",
    capability: "reports.view",
    schema: capacityParams,
    run: getCapacityPlan,
  }),
  staffing_analysis: query({
    description: "Staffing against output. No staffing data yet: answers available false with output per station.",
    capability: "reports.view",
    schema: staffingParams,
    run: getStaffingAnalysis,
  }),
} as const;

export type ReportQueryName = keyof typeof REPORT_QUERIES;

export const REPORT_QUERY_NAMES = Object.keys(REPORT_QUERIES) as ReportQueryName[];

export function isReportQueryName(name: string): name is ReportQueryName {
  return Object.prototype.hasOwnProperty.call(REPORT_QUERIES, name);
}

/** The queries a role may run: what the chat offers as tools. */
export function reportQueriesFor(claims: Claims): ReportQueryName[] {
  return REPORT_QUERY_NAMES.filter((name) => {
    try {
      requireCapability(claims, REPORT_QUERIES[name].capability);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Runs one registered query with untrusted input. Unknown name: throws.
 * Missing capability: ReportAccessError. Bad parameters: ZodError.
 */
export async function runReportQuery(claims: Claims, name: string, input: unknown): Promise<unknown> {
  if (!isReportQueryName(name)) throw new Error(`Unknown report query: ${name}`);
  const q = REPORT_QUERIES[name] as ReportQuery;
  requireCapability(claims, q.capability);
  return q.run(claims, q.schema.parse(input ?? {}));
}
