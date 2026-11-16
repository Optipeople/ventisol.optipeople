// Ordrer: the finished and in-progress lists, the order search, and one order
// in full with its deviation notes and 3E documents. SQL: rpt.orders_finished,
// rpt.orders_in_progress, rpt.find_orders, rpt.order_detail,
// rpt.order_documents, rpt.stations.

import { z } from "zod";
import type { Claims, Db } from "@/lib/db";
import {
  STEP_LABELS,
  currentLabel,
  type ElementRow,
  type OrderRow,
  type OrderStepRow,
  type StationIntervalRow,
  type StepKey,
} from "@/lib/derive";
import { formatDuration, formatForecast, formatMinutes } from "./format";
import {
  clockSchema,
  daySchema,
  duration,
  NO_DURATION,
  nowSchema,
  orderNoSchema,
  pageShape,
  paged,
  percentChange,
  report,
  rows,
  fromDb,
  type ReportContext,
} from "./shared";
import type {
  DeliveryStatusKey,
  DeviationNote,
  FinishedOrderRow,
  FoundOrder,
  InProgressOrderRow,
  OrderDetail,
  OrderDocumentInfo,
  OrderElement,
  OrderHeader,
  OrderInterval,
  OrderRoute,
  OrderStatusSummary,
  OrderStep,
  Paged,
} from "./types";

// ---------------------------------------------------------------------------
// Delivery status: one rule for the lists, the order page and the chat
// ---------------------------------------------------------------------------

const FINISHED_LABELS: Record<DeliveryStatusKey, string> = {
  on_time: "Til tiden",
  late: "Forsinket",
  at_risk: "Risiko for forsinkelse",
  unknown: "Ingen leveringsuge",
};

const IN_PROGRESS_LABELS: Record<DeliveryStatusKey, string> = {
  on_time: "Til tiden",
  late: "Forsinket",
  at_risk: "Risiko for forsinkelse",
  unknown: "Ukendt",
};

/**
 * Packed: on time when packed before the deadline, late when not, unknown
 * without a delivery week. In progress at `now`: late when the deadline has
 * passed, at risk when the forecast lands after it, on time when it does not,
 * unknown when there is no deadline or no forecast.
 * rpt.orders_in_progress filters by the same rule.
 */
export function orderDeliveryStatus(
  order: { status: "in_progress" | "packed"; onTime: boolean | null; dueAt: string | null; atRisk: boolean | null },
  now: number
): { status: DeliveryStatusKey; label: string } {
  if (order.status === "packed") {
    const status: DeliveryStatusKey = order.onTime == null ? "unknown" : order.onTime ? "on_time" : "late";
    return { status, label: FINISHED_LABELS[status] };
  }
  const status: DeliveryStatusKey =
    order.dueAt != null && Date.parse(order.dueAt) <= now
      ? "late"
      : order.atRisk === true
        ? "at_risk"
        : order.atRisk === false
          ? "on_time"
          : "unknown";
  return { status, label: IN_PROGRESS_LABELS[status] };
}

async function stationNamesOn(db: Db): Promise<Record<number, string>> {
  const list = await rows<{ stationNo: number; name: string }>(db, "select station_no, name from rpt.stations()");
  return Object.fromEntries(list.map((s) => [s.stationNo, s.name]));
}

// ---------------------------------------------------------------------------
// Afsluttede
// ---------------------------------------------------------------------------

interface FinishedRaw {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  dueAt: string | null;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsPacked: number;
  startAt: string;
  packedAt: string;
  packedLocalDay: string;
  leadSeconds: number | null;
  leadWorkingSeconds: number | null;
  workSeconds: number | null;
  workWorkingSeconds: number | null;
  waitSeconds: number | null;
  waitWorkingSeconds: number | null;
  touchSeconds: number;
  reworkCount: number;
  missingScanOutCount: number;
  onTime: boolean | null;
  packedSource: "document" | "scans" | null;
  expectedSource: "document" | "scans";
  totalCount: number;
}

export const finishedParams = z.object({
  /** The start of an order number, or part of the customer or case name. */
  search: z.string().max(200).optional(),
  /** Packed day range, either end may be left out. */
  from: daySchema.optional(),
  to: daySchema.optional(),
  status: z.enum(["on_time", "late", "unknown"]).optional(),
  sort: z.enum(["order", "customer", "elements", "start", "packed", "lead", "wait", "status"]).default("packed"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  ...pageShape,
  clock: clockSchema,
});

/** Afsluttede: packed orders with search, sort and paging. Any role. */
export async function listFinishedOrders(
  claims: Claims,
  params: z.input<typeof finishedParams> = {}
): Promise<Paged<FinishedOrderRow>> {
  const p = finishedParams.parse(params);
  return report(claims, p.clock, (db, ctx) =>
    paged<FinishedRaw, FinishedOrderRow>(
      p.page,
      p.pageSize,
      (limit, offset) =>
        rows<FinishedRaw>(
          db,
          `select * from rpt.orders_finished($1::text, $2::date, $3::date, $4::text, $5::text, $6::text,
                                             $7::integer, $8::integer, $9::boolean)`,
          [p.search ?? null, p.from ?? null, p.to ?? null, p.status ?? null, p.sort, p.dir, limit, offset, ctx.useWorking]
        ),
      ({ totalCount, leadSeconds, leadWorkingSeconds, workSeconds, workWorkingSeconds, waitSeconds, waitWorkingSeconds, ...r }) => {
        void totalCount;
        const delivery = orderDeliveryStatus({ status: "packed", onTime: r.onTime, dueAt: r.dueAt, atRisk: null }, 0);
        return {
          ...r,
          elements: r.elementsExpected ?? r.elementsSeen,
          lead: duration(leadSeconds, leadWorkingSeconds, ctx.useWorking),
          wait: duration(waitSeconds, waitWorkingSeconds, ctx.useWorking),
          work: duration(workSeconds, workWorkingSeconds, ctx.useWorking),
          status: delivery.status,
          statusLabel: delivery.label,
        };
      }
    )
  );
}

// ---------------------------------------------------------------------------
// I gang nu
// ---------------------------------------------------------------------------

interface InProgressRaw {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  dueAt: string | null;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsAssembled: number;
  elementsPacked: number;
  startAt: string;
  lastScanAt: string;
  elapsedSeconds: number;
  elapsedWorkingSeconds: number;
  workSeconds: number;
  workWorkingSeconds: number;
  waitSeconds: number;
  waitWorkingSeconds: number;
  currentStep: StepKey | null;
  currentStationNos: number[] | null;
  forecastReadyAt: string | null;
  forecastRemainingSeconds: number | null;
  forecastBasis: "document" | "seen_elements" | null;
  atRisk: boolean | null;
  reworkCount: number;
  missingScanOutCount: number;
  openCount: number;
  expectedSource: "document" | "scans";
  computedAt: string;
  totalCount: number;
}

const inProgressShape = {
  now: nowSchema,
  search: z.string().max(200).optional(),
  status: z.enum(["late", "at_risk", "on_time", "unknown"]).optional(),
  sort: z
    .enum(["order", "customer", "elements", "start", "elapsed", "forecast", "due", "last_scan"])
    .default("start"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  /** Only orders scanned within this many days before now. Left out: all. */
  activeDays: z.number().int().min(1).max(3650).optional(),
  ...pageShape,
};
const inProgressOnParams = z.object(inProgressShape);
export const inProgressParams = z.object({ ...inProgressShape, clock: clockSchema });

export async function inProgressOn(
  db: Db,
  ctx: ReportContext,
  params: z.input<typeof inProgressOnParams>
): Promise<Paged<InProgressOrderRow>> {
  const p = inProgressOnParams.parse(params);
  const names = await stationNamesOn(db);
  const since = p.activeDays == null ? null : new Date(p.now - p.activeDays * 86_400_000);
  return paged<InProgressRaw, InProgressOrderRow>(
    p.page,
    p.pageSize,
    (limit, offset) =>
      rows<InProgressRaw>(
        db,
        `select * from rpt.orders_in_progress($1::timestamptz, $2::text, $3::text, $4::text, $5::text,
                                              $6::integer, $7::integer, $8::boolean, $9::timestamptz)`,
        [new Date(p.now), p.search ?? null, p.status ?? null, p.sort, p.dir, limit, offset, ctx.useWorking, since]
      ),
    ({ totalCount, elapsedSeconds, elapsedWorkingSeconds, workSeconds, workWorkingSeconds, waitSeconds, waitWorkingSeconds, ...r }) => {
      void totalCount;
      const currentStationNos = r.currentStationNos ?? [];
      const delivery = orderDeliveryStatus({ status: "in_progress", onTime: null, dueAt: r.dueAt, atRisk: r.atRisk }, p.now);
      return {
        ...r,
        currentStationNos,
        elements: r.elementsExpected ?? r.elementsSeen,
        currentLabel: currentLabel({ status: "in_progress", currentStep: r.currentStep, currentStationNos }, names),
        elapsed: duration(elapsedSeconds, elapsedWorkingSeconds, ctx.useWorking),
        work: duration(workSeconds, workWorkingSeconds, ctx.useWorking),
        wait: duration(waitSeconds, waitWorkingSeconds, ctx.useWorking),
        status: delivery.status,
        statusLabel: delivery.label,
      };
    }
  );
}

/** I gang nu: orders not packed, with search, status filter, sort and paging. Any role. */
export async function listInProgressOrders(
  claims: Claims,
  params: z.input<typeof inProgressParams>
): Promise<Paged<InProgressOrderRow>> {
  const { clock, ...p } = inProgressParams.parse(params);
  return report(claims, clock, (db, ctx) => inProgressOn(db, ctx, p));
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

export const findParams = z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(100).default(10) });

/**
 * Find orders by number (exact, or the start of it), customer or case name,
 * in progress or packed. Best match first. An empty query finds nothing. Any role.
 */
export async function findOrders(claims: Claims, params: z.input<typeof findParams>): Promise<FoundOrder[]> {
  const p = findParams.parse(params);
  return report(claims, undefined, (db) =>
    rows<FoundOrder>(db, "select * from rpt.find_orders($1::text, $2::integer)", [p.query, p.limit])
  );
}

// ---------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------

interface DetailRaw {
  order: OrderRow;
  steps: OrderStepRow[];
  elements: (ElementRow & { elementTypeName: string | null })[];
  intervals: (StationIntervalRow & { stationName: string; normalSeconds: number | null })[];
}

function elementLabel(e: Pick<ElementRow, "barcode" | "position" | "subPosition" | "piece"> | undefined, barcode: string): string {
  if (!e || e.position == null) return `element ${barcode}`;
  const sub = e.subPosition != null && e.subPosition > 1 ? `.${e.subPosition}` : "";
  return `pos. ${e.position}${sub}${e.piece != null ? `, stk. ${e.piece}` : ""}`;
}

const stepOfKind = (kind: string): StepKey => (kind === "packing" ? "packing" : "assembly");

/**
 * The deviation notes of one order: what went wrong (problem) and what to
 * keep an eye on (watch). Problems first, then in time order. Rules in
 * docs/reports.md, section "Afvigelsesnoter".
 */
export function deviationNotes(
  order: OrderRow,
  elements: Pick<ElementRow, "barcode" | "position" | "subPosition" | "piece">[],
  intervals: OrderInterval[],
  ctx: ReportContext,
  now: number
): DeviationNote[] {
  const notes: DeviationNote[] = [];
  const byBarcode = new Map(elements.map((e) => [e.barcode, e]));
  const add = (note: Partial<DeviationNote> & Pick<DeviationNote, "severity" | "code" | "text">) =>
    notes.push({ step: null, stationNo: null, barcode: null, seconds: null, ...note });

  if (order.status === "packed" && order.onTime === false) {
    add({ severity: "problem", code: "packed_late", step: "packing", text: "Ordren blev pakket efter leveringsfristen." });
  }
  if (order.status === "in_progress" && order.dueAt != null) {
    if (Date.parse(order.dueAt) <= now) {
      add({ severity: "problem", code: "deadline_passed", text: "Leveringsfristen er overskredet, og ordren er ikke pakket." });
    } else if (order.atRisk) {
      add({
        severity: "watch",
        code: "forecast_late",
        text: `Forventet klar ${formatForecast(order.forecastReadyAt)}, og det er efter leveringsfristen.`,
      });
    }
  }

  const longDwell = ctx.thresholds.longDwellSeconds;
  for (const i of intervals) {
    const label = elementLabel(byBarcode.get(i.barcode), i.barcode);
    const at = { stationNo: i.stationNo, barcode: i.barcode };
    if (i.status === "missing_out") {
      add({
        severity: "problem",
        code: "missing_scan_out",
        step: stepOfKind(i.stationKind),
        text: `${i.stationName}: ${label} blev scannet ind, men aldrig ud.`,
        ...at,
      });
      continue;
    }
    if (i.isRework) {
      add({
        severity: "problem",
        code: "rework",
        step: stepOfKind(i.stationKind),
        text: `${i.stationName}: ${label} kom tilbage til stationen (omarbejde).`,
        seconds: i.duration.seconds,
        ...at,
      });
    }
    const wait = i.waitBefore.seconds;
    if (wait != null && wait > longDwell) {
      add({
        severity: "problem",
        code: "long_wait",
        step: i.stationKind === "packing" ? "wait_packing" : "assembly",
        text: `${label} ventede ${formatDuration(wait)} før ${i.stationName}.`,
        seconds: wait,
        ...at,
      });
    }
    if (i.status === "done" && i.deviationPercent != null && i.deviationPercent > ctx.settings.slowThresholdPercent) {
      add({
        severity: "watch",
        code: "slow_pass",
        step: stepOfKind(i.stationKind),
        text: `${i.stationName}: ${label} tog ${formatMinutes(i.duration.seconds)} mod normalt ${formatMinutes(i.normalSeconds)}.`,
        seconds: i.duration.seconds,
        ...at,
      });
    }
  }

  const missing = order.missingElements ?? [];
  if (order.elementsPacked > 0 && missing.length > 0) {
    const pieces = missing.reduce((a, m) => a + Math.max(0, m.expected - m.packed), 0);
    add({
      severity: "watch",
      code: "missing_elements",
      step: "packing",
      text:
        pieces === 1
          ? "1 element fra produktionslisten er ikke pakket endnu."
          : `${pieces} elementer fra produktionslisten er ikke pakket endnu.`,
    });
  }

  return [...notes.filter((n) => n.severity === "problem"), ...notes.filter((n) => n.severity === "watch")];
}

export function notesHeadline(notes: DeviationNote[]): string {
  if (notes.some((n) => n.severity === "problem")) return "Her gik det galt";
  return notes.length > 0 ? "Hold øje med" : "Ingen afvigelser";
}

interface DocumentRaw extends Omit<OrderDocumentInfo, "positions" | "problems"> {
  positions: OrderDocumentInfo["positions"] | null;
  problems: unknown;
}

async function documentsOn(db: Db, orderNo: number): Promise<OrderDocumentInfo[]> {
  // The parsed 3E document is camelCase already: only the columns are converted.
  const raw = await db.query<Record<string, unknown>>("select * from rpt.order_documents($1::integer)", [orderNo]);
  return raw.map((r) => {
    const { header, positions, problems, ...columns } = r;
    const d = fromDb<DocumentRaw>(columns);
    return {
      ...d,
      header: (header as OrderDocumentInfo["header"]) ?? null,
      positions: Array.isArray(positions) ? (positions as OrderDocumentInfo["positions"]) : [],
      problems: Array.isArray(problems) ? problems.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [],
    };
  });
}

interface OrderParts {
  order: OrderHeader;
  steps: OrderStep[];
  elements: OrderElement[];
  intervals: OrderInterval[];
  notes: DeviationNote[];
}

async function orderPartsOn(db: Db, ctx: ReportContext, orderNo: number, now: number): Promise<OrderParts | null> {
  const [row] = await db.query<{ detail: unknown }>("select rpt.order_detail($1::integer) as detail", [orderNo]);
  if (!row?.detail) return null;
  const raw = fromDb<DetailRaw>(row.detail);
  const names = await stationNamesOn(db);
  const o: OrderRow = { ...raw.order, currentStationNos: raw.order.currentStationNos ?? [] };

  const intervals: OrderInterval[] = raw.intervals.map((i) => {
    const d = duration(i.durationSeconds, i.durationWorkingSeconds, ctx.useWorking);
    return {
      ...i,
      duration: d,
      waitBefore: duration(i.waitBeforeSeconds, i.waitBeforeWorkingSeconds, ctx.useWorking),
      // A pass that lies wholly outside the shifts has 0 working seconds: no comparison then.
      deviationPercent:
        i.status === "done" && !(d.seconds === 0 && (d.wallSeconds ?? 0) > 0)
          ? percentChange(d.seconds, i.normalSeconds)
          : null,
    };
  });
  const notes = deviationNotes(o, raw.elements, intervals, ctx, now);
  const flagged = new Set(notes.map((n) => n.step));

  const steps: OrderStep[] = raw.steps.map((s) => ({
    ...s,
    label: STEP_LABELS[s.step],
    duration: duration(s.durationSeconds, s.durationWorkingSeconds, ctx.useWorking),
    work: duration(s.workSeconds, s.workWorkingSeconds, ctx.useWorking),
    wait: duration(s.waitSeconds, s.waitWorkingSeconds, ctx.useWorking),
    deviation: flagged.has(s.step),
  }));

  const elements: OrderElement[] = raw.elements.map((e) => ({
    ...e,
    stationPath: e.stationPath ?? [],
    pathLabels: (e.stationPath ?? []).map((no) => names[no] ?? `Station nr. ${no}`),
    total: duration(e.totalSeconds, e.totalWorkingSeconds, ctx.useWorking),
  }));

  const delivery = orderDeliveryStatus(o, now);
  const order: OrderHeader = {
    ...o,
    elements: o.elementsExpected ?? o.elementsSeen,
    lead: o.status === "packed" ? duration(o.leadSeconds, o.leadWorkingSeconds, ctx.useWorking) : NO_DURATION,
    elapsed: duration(o.elapsedSeconds, o.elapsedWorkingSeconds, ctx.useWorking),
    work: duration(o.workSeconds, o.workWorkingSeconds, ctx.useWorking),
    wait: duration(o.waitSeconds, o.waitWorkingSeconds, ctx.useWorking),
    deliveryStatus: delivery.status,
    deliveryStatusLabel: delivery.label,
    currentLabel: currentLabel(o, names),
  };
  return { order, steps, elements, intervals, notes };
}

export const orderParams = z.object({ orderNo: orderNoSchema, now: nowSchema, clock: clockSchema });

/**
 * One order in full: header, the seven steps, elements, every pass, the
 * deviation notes and the 3E documents. Null when the order is not known.
 * Any role.
 */
export async function getOrderDetail(claims: Claims, params: z.input<typeof orderParams>): Promise<OrderDetail | null> {
  const p = orderParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const parts = await orderPartsOn(db, ctx, p.orderNo, p.now);
    if (!parts) return null;
    return {
      clock: ctx.clock,
      ...parts,
      notesHeadline: notesHeadline(parts.notes),
      documents: await documentsOn(db, p.orderNo),
    };
  });
}

/** Where one order is now, how far it is, and whether it will be on time. Null when not known. Any role. */
export async function getOrderStatus(
  claims: Claims,
  params: z.input<typeof orderParams>
): Promise<OrderStatusSummary | null> {
  const p = orderParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const parts = await orderPartsOn(db, ctx, p.orderNo, p.now);
    if (!parts) return null;
    const o = parts.order;
    return {
      clock: ctx.clock,
      orderNo: o.orderNo,
      customer: o.customer,
      caseName: o.caseName,
      status: o.status,
      currentLabel: o.currentLabel,
      currentStep: o.currentStep,
      currentStationNos: o.currentStationNos,
      elements: o.elements,
      elementsSeen: o.elementsSeen,
      elementsAssembled: o.elementsAssembled,
      elementsPacked: o.elementsPacked,
      startAt: o.startAt,
      packedAt: o.packedAt,
      elapsed: o.elapsed,
      deliveryYear: o.deliveryYear,
      deliveryWeek: o.deliveryWeek,
      dueAt: o.dueAt,
      forecastReadyAt: o.forecastReadyAt,
      forecastBasis: o.forecastBasis,
      deliveryStatus: o.deliveryStatus,
      deliveryStatusLabel: o.deliveryStatusLabel,
      stepsDone: parts.steps
        .filter((s) => s.countsInLead && s.durationSeconds != null && !s.isOpen && (o.status === "packed" || s.endAt != null))
        .map((s) => s.label),
      computedAt: o.computedAt,
    };
  });
}

/** The route of one order: the seven steps with their times, and the deviation notes. Null when not known. Any role. */
export async function getOrderRoute(claims: Claims, params: z.input<typeof orderParams>): Promise<OrderRoute | null> {
  const p = orderParams.parse(params);
  return report(claims, p.clock, async (db, ctx) => {
    const parts = await orderPartsOn(db, ctx, p.orderNo, p.now);
    if (!parts) return null;
    const o = parts.order;
    return {
      clock: ctx.clock,
      orderNo: o.orderNo,
      status: o.status,
      lead: o.lead,
      elapsed: o.elapsed,
      work: o.work,
      wait: o.wait,
      steps: parts.steps,
      notes: parts.notes,
      notesHeadline: notesHeadline(parts.notes),
    };
  });
}

export const documentsParams = z.object({ orderNo: orderNoSchema });

/** The 3E documents of one order: the file, its blob reference and what the parser read. Any role. */
export async function getOrderDocuments(
  claims: Claims,
  params: z.input<typeof documentsParams>
): Promise<OrderDocumentInfo[]> {
  const p = documentsParams.parse(params);
  return report(claims, undefined, (db) => documentsOn(db, p.orderNo));
}
