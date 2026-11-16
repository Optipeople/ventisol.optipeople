// What every report query exports: a Danish title and file name, the rows to
// take from its result, and the columns with their Danish headers and kind.
// The kind decides the cell format in Excel and the text in the PDF
// (lib/export/cells.ts). Values stay raw here: seconds, percents as numbers,
// days as yyyy-MM-dd, instants as ISO, unknown as null.

import type { REPORT_QUERIES, ReportQueryName } from "@/lib/reports";
import type {
  BaselineSuggestionRow,
  CalcVsMeasuredRow,
  CapacityDay,
  FinishedOrderRow,
  FoundOrder,
  InProgressOrderRow,
  IncompletePackedOrder,
  KpiSet,
  LeadTimePoint,
  MissingScanOut,
  OrderStep,
  OrderStatusSummary,
  PeriodKpis,
  StaffingDay,
  StationInfo,
  StationRow,
  StepTime,
  TodayStrip,
} from "@/lib/reports/types";

/**
 * text: as is. int: whole number. decimal: one decimal. percent: a percent
 * number (94 is 94 %). duration: whole seconds, shown as hours:minutes. day:
 * yyyy-MM-dd. datetime: an ISO instant, shown in Copenhagen time. bool: Ja or Nej.
 */
export type ColumnKind = "text" | "int" | "decimal" | "percent" | "duration" | "day" | "datetime" | "bool";

export type CellValue = string | number | boolean | null;

export interface ExportColumn<R = unknown> {
  /** Danish header. */
  header: string;
  kind: ColumnKind;
  value: (row: R) => CellValue | undefined;
  /** Width in characters. Defaults by kind. */
  width?: number;
}

/** The result type of a registered query. */
export type ResultOf<N extends ReportQueryName> = Awaited<ReturnType<(typeof REPORT_QUERIES)[N]["run"]>>;

export interface ExportDefinition<T = unknown, R = unknown> {
  /** Danish, the PDF heading. */
  title: string;
  /** Excel sheet name, at most 31 characters. */
  sheet: string;
  /** File name before the date: "afsluttede-ordrer" becomes afsluttede-ordrer-2026-11-16.xlsx. */
  file: string;
  /** True: the query pages (page, pageSize, and a total), and the export loops all pages. */
  paged?: boolean;
  rows: (result: T) => R[];
  columns: ExportColumn<R>[];
}

/** One definition with its types erased, as the export runner holds them. */
export type AnyExportDefinition = ExportDefinition<unknown, unknown>;

const define = <N extends ReportQueryName, R>(d: ExportDefinition<ResultOf<N>, R>): AnyExportDefinition =>
  d as unknown as AnyExportDefinition;

const col = <R>(header: string, kind: ColumnKind, value: (row: R) => CellValue | undefined, width?: number): ExportColumn<R> => ({
  header,
  kind,
  value,
  width,
});

// ---------------------------------------------------------------------------
// Small Danish labels
// ---------------------------------------------------------------------------

function deliveryWeek(year: number | null, week: number | null): string | null {
  if (week == null) return null;
  return year == null ? `Uge ${week}` : `Uge ${week}, ${year}`;
}

const ORDER_STATE: Record<"in_progress" | "packed", string> = { in_progress: "I gang", packed: "Pakket" };

const SOURCE_LABEL: Record<string, string> = { scans: "Målt", machine: "Målt", assumed: "Antaget", none: "Ingen data endnu" };

const WEEKDAYS = ["", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];

const one = <T>(value: T | null | undefined): T[] => (value == null ? [] : [value]);

// ---------------------------------------------------------------------------
// Shared column sets
// ---------------------------------------------------------------------------

const finishedColumns: ExportColumn<FinishedOrderRow>[] = [
  col("Ordre", "int", (r) => r.orderNo, 10),
  col("Kunde", "text", (r) => r.customer, 24),
  col("Sag", "text", (r) => r.caseName, 24),
  col("Lev. uge", "text", (r) => deliveryWeek(r.deliveryYear, r.deliveryWeek), 13),
  col("Elementer", "int", (r) => r.elements),
  col("Elementer pakket", "int", (r) => r.elementsPacked),
  col("Start", "datetime", (r) => r.startAt),
  col("Pakket", "datetime", (r) => r.packedAt),
  col("Gennemløbstid", "duration", (r) => r.lead.seconds),
  col("Heraf ventetid", "duration", (r) => r.wait.seconds),
  col("Arbejde", "duration", (r) => r.work.seconds),
  col("Omarbejde", "int", (r) => r.reworkCount),
  col("Mangler ud-scanning", "int", (r) => r.missingScanOutCount),
  col("Status", "text", (r) => r.statusLabel, 16),
];

const inProgressColumns: ExportColumn<InProgressOrderRow>[] = [
  col("Ordre", "int", (r) => r.orderNo, 10),
  col("Kunde", "text", (r) => r.customer, 24),
  col("Sag", "text", (r) => r.caseName, 24),
  col("Lev. uge", "text", (r) => deliveryWeek(r.deliveryYear, r.deliveryWeek), 13),
  col("Elementer", "int", (r) => r.elements),
  col("Monteret", "int", (r) => r.elementsAssembled),
  col("Pakket", "int", (r) => r.elementsPacked),
  col("Er nu ved", "text", (r) => r.currentLabel, 22),
  col("Start", "datetime", (r) => r.startAt),
  col("Seneste scanning", "datetime", (r) => r.lastScanAt),
  col("Tid indtil nu", "duration", (r) => r.elapsed.seconds),
  col("Heraf ventetid", "duration", (r) => r.wait.seconds),
  col("Forventet klar", "datetime", (r) => r.forecastReadyAt),
  col("Status", "text", (r) => r.statusLabel, 20),
];

const stationColumns: ExportColumn<StationRow>[] = [
  col("Nr.", "int", (r) => r.stationNo, 6),
  col("Station", "text", (r) => r.name, 20),
  col("Type", "text", (r) => r.kindLabel, 10),
  col("Gennem", "int", (r) => r.countThrough),
  col("Elementer", "int", (r) => r.elementsThrough),
  col("Tid pr. stk.", "duration", (r) => r.timePerPiece.seconds),
  col("Normalt", "duration", (r) => r.normalSeconds),
  col("Mod normalt", "percent", (r) => r.deviationPercent),
  col("Stod stille", "duration", (r) => r.standstillSeconds),
  col("Længste ventetid før", "duration", (r) => r.longestWaitBeforeSeconds),
  col("Udnyttelse", "percent", (r) => r.utilisationPercent),
  col("Omarbejde", "int", (r) => r.reworkPasses),
  col("Mangler ud-scanning", "int", (r) => r.missingScanOutCount),
  col("Status", "text", (r) => r.statusLabel, 16),
];

interface KpiRow {
  label: string;
  from: string;
  to: string;
  set: KpiSet;
}

const kpiRows = (k: PeriodKpis): KpiRow[] => [
  { label: "Denne periode", ...k.period, set: k.current },
  { label: "Forrige periode", ...k.previousPeriod, set: k.previous },
];

const kpiColumns: ExportColumn<KpiRow>[] = [
  col("Periode", "text", (r) => r.label, 16),
  col("Fra", "day", (r) => r.from),
  col("Til", "day", (r) => r.to),
  col("Ordrer pakket", "int", (r) => r.set.ordersPacked),
  col("Elementer pakket", "int", (r) => r.set.elementsPacked),
  col("Gennemløbstid pr. ordre", "duration", (r) => r.set.lead.seconds),
  col("Ventetid pr. ordre", "duration", (r) => r.set.wait.seconds),
  col("Arbejde pr. ordre", "duration", (r) => r.set.work.seconds),
  col("Leveret til tiden", "percent", (r) => r.set.onTimePercent),
  col("Ordrer til tiden", "int", (r) => r.set.onTimeOrders),
  col("Ordrer med leveringsuge", "int", (r) => r.set.onTimeKnown),
  col("Ordrer med omarbejde", "int", (r) => r.set.reworkOrders),
];

const leadTimeColumns: ExportColumn<LeadTimePoint>[] = [
  col("Periode", "text", (r) => (r.bucket === "week" ? `Uge ${r.isoWeek}` : r.label), 12),
  col("Fra", "day", (r) => r.bucketStart),
  col("Til", "day", (r) => r.bucketEnd),
  col("Ordrer pakket", "int", (r) => r.ordersPacked),
  col("Gennemløbstid", "duration", (r) => r.lead.seconds),
  col("Arbejde", "duration", (r) => r.work.seconds),
  col("Ventetid", "duration", (r) => r.wait.seconds),
];

// ---------------------------------------------------------------------------
// The definitions, one per registered query
// ---------------------------------------------------------------------------

export const REPORT_EXPORTS: Record<ReportQueryName, AnyExportDefinition> = {
  find_order: define<"find_order", FoundOrder>({
    title: "Søgning i ordrer",
    sheet: "Ordrer",
    file: "ordresoegning",
    rows: (r) => r,
    columns: [
      col("Ordre", "int", (r) => r.orderNo, 10),
      col("Kunde", "text", (r) => r.customer, 24),
      col("Sag", "text", (r) => r.caseName, 24),
      col("Status", "text", (r) => ORDER_STATE[r.status]),
      col("Lev. uge", "text", (r) => deliveryWeek(r.deliveryYear, r.deliveryWeek), 13),
      col("Elementer forventet", "int", (r) => r.elementsExpected),
      col("Elementer set", "int", (r) => r.elementsSeen),
      col("Elementer pakket", "int", (r) => r.elementsPacked),
      col("Start", "datetime", (r) => r.startAt),
      col("Pakket", "datetime", (r) => r.packedAt),
      col("Seneste scanning", "datetime", (r) => r.lastScanAt),
    ],
  }),

  order_status: define<"order_status", OrderStatusSummary>({
    title: "Ordrestatus",
    sheet: "Ordrestatus",
    file: "ordrestatus",
    rows: one,
    columns: [
      col("Ordre", "int", (r) => r.orderNo, 10),
      col("Kunde", "text", (r) => r.customer, 24),
      col("Sag", "text", (r) => r.caseName, 24),
      col("Status", "text", (r) => ORDER_STATE[r.status]),
      col("Er nu ved", "text", (r) => r.currentLabel, 22),
      col("Elementer", "int", (r) => r.elements),
      col("Monteret", "int", (r) => r.elementsAssembled),
      col("Pakket", "int", (r) => r.elementsPacked),
      col("Start", "datetime", (r) => r.startAt),
      col("Pakket den", "datetime", (r) => r.packedAt),
      col("Tid indtil nu", "duration", (r) => r.elapsed.seconds),
      col("Lev. uge", "text", (r) => deliveryWeek(r.deliveryYear, r.deliveryWeek), 13),
      col("Forventet klar", "datetime", (r) => r.forecastReadyAt),
      col("Leveringsstatus", "text", (r) => r.deliveryStatusLabel, 20),
    ],
  }),

  order_route: define<"order_route", OrderStep>({
    title: "Ordrens rute",
    sheet: "Rute",
    file: "ordrerute",
    rows: (r) => r?.steps ?? [],
    columns: [
      col("Trin", "text", (r) => r.label, 20),
      col("Kilde", "text", (r) => SOURCE_LABEL[r.source] ?? r.source),
      col("Start", "datetime", (r) => r.startAt),
      col("Slut", "datetime", (r) => r.endAt),
      col("Tid", "duration", (r) => r.duration.seconds),
      col("Arbejde", "duration", (r) => r.work.seconds),
      col("Ventetid", "duration", (r) => r.wait.seconds),
      col("I gang", "bool", (r) => r.isOpen),
      col("Afvigelse", "bool", (r) => r.deviation),
    ],
  }),

  finished_orders: define<"finished_orders", FinishedOrderRow>({
    title: "Afsluttede ordrer",
    sheet: "Afsluttede ordrer",
    file: "afsluttede-ordrer",
    paged: true,
    rows: (r) => r.rows,
    columns: finishedColumns,
  }),

  orders_in_progress: define<"orders_in_progress", InProgressOrderRow>({
    title: "Ordrer i gang",
    sheet: "Ordrer i gang",
    file: "ordrer-i-gang",
    paged: true,
    rows: (r) => r.rows,
    columns: inProgressColumns,
  }),

  bottleneck: define<"bottleneck", StepTime>({
    title: "Flaskehals",
    sheet: "Flaskehals",
    file: "flaskehals",
    rows: (r) => r.steps,
    columns: [
      col("Trin", "text", (r) => r.label, 20),
      col("Kilde", "text", (r) => SOURCE_LABEL[r.source] ?? r.source),
      col("Med i gennemløbstid", "bool", (r) => r.countsInLead),
      col("Ordrer", "int", (r) => r.orders),
      col("Ordrer med data", "int", (r) => r.ordersWithData),
      col("Tid pr. ordre", "duration", (r) => r.duration.seconds),
      col("Arbejde", "duration", (r) => r.work.seconds),
      col("Ventetid", "duration", (r) => r.wait.seconds),
    ],
  }),

  period_kpis: define<"period_kpis", KpiRow>({
    title: "Nøgletal for perioden",
    sheet: "Nøgletal",
    file: "noegletal",
    rows: kpiRows,
    columns: kpiColumns,
  }),

  lead_time_series: define<"lead_time_series", LeadTimePoint>({
    title: "Gennemløbstid over tid",
    sheet: "Gennemløbstid",
    file: "gennemloebstid",
    rows: (r) => r,
    columns: leadTimeColumns,
  }),

  kpi_summary: define<"kpi_summary", InProgressOrderRow>({
    title: "Ordrer at holde øje med",
    sheet: "Hold øje med",
    file: "ordrer-at-holde-oeje-med",
    rows: (r) => r.ordersToWatch,
    columns: inProgressColumns,
  }),

  today: define<"today", TodayStrip>({
    title: "I dag",
    sheet: "I dag",
    file: "i-dag",
    rows: one,
    columns: [
      col("Dag", "day", (r) => r.day),
      col("Ordrer i gang", "int", (r) => r.ordersInProgress),
      col("Aktive ordrer", "int", (r) => r.ordersActive),
      col("Ordrer i risiko", "int", (r) => r.ordersAtRisk),
      col("Ordrer pakket i dag", "int", (r) => r.ordersPackedToday),
      col("Gennemløb i dag", "int", (r) => r.passesToday),
      col("Elementer igennem", "int", (r) => r.elementsThrough),
      col("Elementer pakket", "int", (r) => r.elementsPacked),
      col("Stationer i gang", "int", (r) => r.stationsRunning),
      col("Stationer i alt", "int", (r) => r.stationsTotal),
    ],
  }),

  stations: define<"stations", StationInfo>({
    title: "Stationer",
    sheet: "Stationer",
    file: "stationer",
    rows: (r) => r,
    columns: [
      col("Nr.", "int", (r) => r.stationNo, 6),
      col("Station", "text", (r) => r.name, 20),
      col("Type", "text", (r) => r.kindLabel, 10),
      col("Rækkefølge", "int", (r) => r.sortOrder),
      col("Aktiv", "bool", (r) => r.active),
      col("Normaltider", "int", (r) => r.normalTimes.length),
    ],
  }),

  station_day: define<"station_day", StationRow>({
    title: "Stationer på dagen",
    sheet: "Stationer",
    file: "stationer-dag",
    rows: (r) => r.rows,
    columns: stationColumns,
  }),

  station_performance: define<"station_performance", StationRow>({
    title: "Stationer over perioden",
    sheet: "Stationer",
    file: "stationer-periode",
    rows: (r) => r.rows,
    columns: stationColumns,
  }),

  calc_vs_measured: define<"calc_vs_measured", CalcVsMeasuredRow>({
    title: "Kalkule mod målt",
    sheet: "Kalkule mod målt",
    file: "kalkule-mod-maalt",
    rows: (r) => r.rows,
    columns: [
      col("Nr.", "int", (r) => r.stationNo, 6),
      col("Station", "text", (r) => r.stationName, 20),
      col("Elementtype", "text", (r) => r.elementTypeName, 20),
      col("Kalkule", "duration", (r) => r.calculatedSeconds),
      col("Normalt", "duration", (r) => r.normalSeconds),
      col("Målt (median)", "duration", (r) => r.measured.seconds),
      col("Målt (gennemsnit)", "duration", (r) => r.meanSeconds),
      col("Afvigelse", "percent", (r) => r.deviationPercent),
      col("Over grænsen", "bool", (r) => r.flagged),
      col("Gennemløb", "int", (r) => r.passes),
      col("Omarbejde", "int", (r) => r.reworkPasses),
    ],
  }),

  management_kpis: define<"management_kpis", KpiRow>({
    title: "Ledelsens nøgletal",
    sheet: "Nøgletal",
    file: "ledelse-noegletal",
    rows: (r) => kpiRows(r).map((row, i) => ({ ...row, label: i === 0 ? "Denne måned" : "Måneden før" })),
    columns: kpiColumns,
  }),

  monthly_lead_time: define<"monthly_lead_time", LeadTimePoint>({
    title: "Gennemløbstid pr. måned",
    sheet: "Gennemløbstid",
    file: "gennemloebstid-maaned",
    rows: (r) => r,
    columns: leadTimeColumns,
  }),

  missing_scan_outs: define<"missing_scan_outs", MissingScanOut>({
    title: "Manglende ud-scanninger",
    sheet: "Manglende ud-scanninger",
    file: "manglende-ud-scanninger",
    paged: true,
    rows: (r) => r.rows,
    columns: [
      col("Ordre", "int", (r) => r.orderNo, 10),
      col("Kunde", "text", (r) => r.customer, 24),
      col("Stregkode", "text", (r) => r.barcode, 18),
      col("Position", "text", (r) => (r.position == null ? null : `${r.position}.${r.subPosition ?? 0}`), 9),
      col("Stk.", "int", (r) => r.piece, 6),
      col("Station", "text", (r) => r.stationName, 18),
      col("Scannet ind", "datetime", (r) => r.startAt),
      col("Årsag", "text", (r) => r.reasonLabel, 30),
      col("Ordrestatus", "text", (r) => ORDER_STATE[r.orderStatus]),
    ],
  }),

  incomplete_packed_orders: define<"incomplete_packed_orders", IncompletePackedOrder>({
    title: "Ordrer med manglende elementer",
    sheet: "Manglende elementer",
    file: "ordrer-med-manglende-elementer",
    paged: true,
    rows: (r) => r.rows,
    columns: [
      col("Ordre", "int", (r) => r.orderNo, 10),
      col("Kunde", "text", (r) => r.customer, 24),
      col("Sag", "text", (r) => r.caseName, 24),
      col("Status", "text", (r) => ORDER_STATE[r.status]),
      col("Lev. uge", "text", (r) => deliveryWeek(r.deliveryYear, r.deliveryWeek), 13),
      col("Forventet", "int", (r) => r.elementsExpected),
      col("Set", "int", (r) => r.elementsSeen),
      col("Pakket", "int", (r) => r.elementsPacked),
      col(
        "Mangler",
        "text",
        (r) => r.missingElements.map((m) => `Pos. ${m.position}.${m.subPosition}: ${m.packed} af ${m.expected} pakket`).join("; "),
        40
      ),
      col("Seneste scanning", "datetime", (r) => r.lastScanAt),
    ],
  }),

  baseline_suggestion: define<"baseline_suggestion", BaselineSuggestionRow>({
    title: "Forslag til normaltider",
    sheet: "Forslag til normaltider",
    file: "forslag-normaltider",
    rows: (r) => r.rows,
    columns: [
      col("Nr.", "int", (r) => r.stationNo, 6),
      col("Station", "text", (r) => r.stationName, 20),
      col("Elementtype", "text", (r) => r.elementTypeName ?? "Uden type", 20),
      col("Gennemløb", "int", (r) => r.samples),
      col("Forslag", "duration", (r) => r.suggestedSeconds),
      col("Gennemsnit", "duration", (r) => r.meanSeconds),
      col("25 %", "duration", (r) => r.p25Seconds),
      col("75 %", "duration", (r) => r.p75Seconds),
      col("Nuværende", "duration", (r) => r.currentSeconds),
      col(
        "Kilde",
        "text",
        (r) => (r.currentSource === "manual" ? "Indtastet" : r.currentSource === "baseline" ? "Forslag" : null)
      ),
    ],
  }),

  capacity_plan: define<"capacity_plan", CapacityDay>({
    title: "Kapacitetsplan",
    sheet: "Kapacitet",
    file: "kapacitetsplan",
    rows: (r) => r.days,
    columns: [
      col("Dag", "day", (r) => r.day),
      col("Ugedag", "text", (r) => WEEKDAYS[r.weekday] ?? null),
      col("Lukket", "bool", (r) => r.closed),
      col("Fridag", "text", (r) => r.closedName, 18),
      col("Skifttid", "duration", (r) => r.shiftSeconds),
      col("Planlagte ordrer", "int", (r) => r.plannedOrders),
      col("Planlagt belastning", "duration", (r) => r.plannedLoadSeconds),
    ],
  }),

  staffing_analysis: define<"staffing_analysis", StaffingDay>({
    title: "Bemanding mod output",
    sheet: "Bemanding",
    file: "bemanding",
    rows: (r) => r.days,
    columns: [
      col("Nr.", "int", (r) => r.stationNo, 6),
      col("Station", "text", (r) => r.stationName, 20),
      col("Dag", "day", (r) => r.localDay),
      col("Gennem", "int", (r) => r.countThrough),
      col("Tid pr. stk.", "duration", (r) => r.timePerPiece.seconds),
      col("Optaget i skift", "duration", (r) => r.busyInShiftSeconds),
      col("Observeret", "duration", (r) => r.observedSeconds),
      col("Personer", "int", (r) => r.people),
    ],
  }),
};
