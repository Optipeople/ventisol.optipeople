// The result types of the report layer: what pages and chat tools receive.
// JSON friendly throughout: timestamps are ISO 8601 UTC strings, days are
// Europe/Copenhagen "yyyy-MM-dd", durations whole seconds, unknown is null
// (show it as "Ingen data endnu", never as 0).
//
// Definitions behind the numbers: docs/reports.md and docs/read-model.md.

import type {
  ElementRow,
  ElementTypeCount,
  OrderRow,
  OrderStepRow,
  StationGap,
  StationIntervalRow,
  StationStatusKey,
  StepKey,
  StepKind,
  StepSource,
} from "@/lib/derive";
import type { OrderDocumentHeader, OrderPosition } from "@/lib/orderdoc/types";

/** ISO 8601 UTC instant. */
export type Iso = string;
/** Europe/Copenhagen calendar day, yyyy-MM-dd. */
export type Day = string;

/** working: only time inside the shifts counts. wall: every second counts. */
export type Clock = "working" | "wall";

/**
 * A duration on both clocks. `seconds` is the headline: the working-time
 * value when the clock is "working" (setting deduct_off_shift, or the `clock`
 * parameter), else the wall-clock value.
 */
export interface Duration {
  seconds: number | null;
  wallSeconds: number | null;
  workingSeconds: number | null;
}

/** The read-time settings (config.settings) the reports were computed with. */
export interface ReportSettings {
  useWorkingTime: boolean;
  slowThresholdPercent: number;
  standstillThresholdMinutes: number;
  longDwellThresholdMinutes: number;
  calculationDeviationThresholdPercent: number;
  lateThresholdDays: number;
  bufferCapacity: number | null;
  schirmerAssumedMinutesPerBatch: number | null;
}

export interface Period {
  from: Day;
  to: Day;
}

export interface Paged<T> {
  rows: T[];
  /** Matches before paging. */
  total: number;
  /** 1-based. */
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Overblik
// ---------------------------------------------------------------------------

/** The KPIs of the orders packed in one period. */
export interface KpiSet {
  ordersPacked: number;
  elementsPacked: number;
  /** Gennemløbstid pr. ordre: mean of start to packed. Null with no orders. */
  lead: Duration;
  /** Ventetid pr. ordre: mean of the time with no element at a station. */
  wait: Duration;
  /** Arbejde pr. ordre: lead minus wait. */
  work: Duration;
  /** Leveret til tiden, percent of the orders that have a delivery week. Null when none has. */
  onTimePercent: number | null;
  onTimeOrders: number;
  /** Packed orders with a delivery week (the base of onTimePercent). */
  onTimeKnown: number;
  reworkOrders: number;
}

export interface KpiChange {
  /** Percent change of the headline lead time. Negative is faster. Null when either side is missing. */
  leadPercent: number | null;
  waitPercent: number | null;
  /** Percentage points. */
  onTimePoints: number | null;
  ordersPercent: number | null;
}

export interface PeriodKpis {
  clock: Clock;
  period: Period;
  previousPeriod: Period;
  current: KpiSet;
  previous: KpiSet;
  change: KpiChange;
}

/** One week or month of "Gennemløbstid pr. ordre". Empty buckets have null durations. */
export interface LeadTimePoint {
  bucket: "week" | "month";
  bucketStart: Day;
  bucketEnd: Day;
  isoYear: number;
  /** ISO week of bucketStart (only meaningful for week buckets). */
  isoWeek: number;
  /** "43" for a week, "okt." for a month. */
  label: string;
  ordersPacked: number;
  lead: Duration;
  work: Duration;
  wait: Duration;
}

/** One of the seven steps, averaged per order over a period. */
export interface StepTime {
  step: StepKey;
  seq: number;
  kind: StepKind;
  label: string;
  /** scans or machine: measured. assumed: a setting, show as "antaget". none: "Ingen data endnu". */
  source: StepSource;
  /** True when the step is part of the measured lead time. */
  countsInLead: boolean;
  /** Packed orders in the period. */
  orders: number;
  ordersWithData: number;
  /** Average time per order in the step. The measured steps add up to the average lead time. */
  duration: Duration;
  /** The part of it with an element at a station. */
  work: Duration;
  /** The part of it with nothing being worked on. For a waiting step: all of it. */
  wait: Duration;
}

export interface BottleneckStation {
  stationNo: number;
  name: string;
  kind: string;
  passes: number;
  /** Average wait of an element before its pass here (since its previous Out). */
  avgWaitBefore: Duration;
  longestWaitBefore: Duration;
}

export interface Bottleneck {
  clock: Clock;
  period: Period;
  ordersPacked: number;
  /** Average lead time of the same orders: the sum of the measured steps. */
  lead: Duration;
  steps: StepTime[];
  /** The step with the largest average waiting time. Null when nothing waits or there are no orders. */
  bottleneck: { step: StepKey; label: string; waitSeconds: number } | null;
  /** Danish, ready to show: "Bufferen er flaskehalsen. Her venter en ordre i snit 2 t 10 min." */
  sentence: string;
  /** Steps with no data yet (source none), by label: say so beside the sentence. */
  missingSteps: string[];
  /** Waiting in front of each station, largest first. */
  stations: BottleneckStation[];
}

export interface TodayStrip {
  day: Day;
  /** Every order not packed. */
  ordersInProgress: number;
  /** Of them, scanned within the last 14 days. */
  ordersActive: number;
  /** In progress and late or at risk. */
  ordersAtRisk: number;
  ordersPackedToday: number;
  /** Finished passes that ended today, all stations. */
  passesToday: number;
  /** Distinct elements among them. */
  elementsThrough: number;
  /** Distinct elements through packing today. */
  elementsPacked: number;
  /** Stations with an element on them now. */
  stationsRunning: number;
  /** Active assembly and packing stations. */
  stationsTotal: number;
}

export interface KpiSummary {
  clock: Clock;
  kpis: PeriodKpis;
  bottleneck: Bottleneck;
  today: TodayStrip;
  stationsToday: StationAttention;
  /** In-progress orders that are late or at risk, most urgent first (at most 10). */
  ordersToWatch: InProgressOrderRow[];
  ordersToWatchTotal: number;
}

// ---------------------------------------------------------------------------
// Stationer
// ---------------------------------------------------------------------------

export type StationKindKey = "assembly" | "packing" | "machine" | "buffer";

export interface StationInfo {
  stationNo: number;
  name: string;
  kind: StationKindKey;
  /** "Montage", "Pakning", "Maskine", "Liggetid". */
  kindLabel: string;
  sortOrder: number;
  active: boolean;
  normalTimes: { elementTypeId: string; seconds: number }[];
}

/** One station for a day or a period. Every number is null while hasData is false. */
export interface StationRow {
  stationNo: number;
  name: string;
  kind: StationKindKey;
  kindLabel: string;
  /** In config.stations. False: seen in scans only. */
  configured: boolean;
  /** False: no facts for the day or period (a machine with no connector, or an idle station). */
  hasData: boolean;
  /** Gennem: finished passes that ended in the day or period. */
  countThrough: number | null;
  elementsThrough: number | null;
  reworkPasses: number | null;
  openCount: number | null;
  missingScanOutCount: number | null;
  /** Tid pr. stk.: the median pass time. */
  timePerPiece: Duration;
  meanPieceSeconds: number | null;
  /** Normalt: the normal times weighted by the element types that went through. Null without normal times. */
  normalSeconds: number | null;
  /** Mod normalt, percent. Null without both figures. */
  deviationPercent: number | null;
  /** Stod stille: the gaps of at least the threshold, summed. 0 shows as "Ingen". Null without data. */
  standstillSeconds: number | null;
  /** Longest wait of an element before this station, on the headline clock. */
  longestWaitBeforeSeconds: number | null;
  /** Average wait before this station (period rows only, null on a day row). */
  avgWaitBefore: Duration;
  status: StationStatusKey;
  /** "Normal", "Lang liggetid", "Langsommere", "Stod stille" or "Ingen data endnu". */
  statusLabel: string;
  /** Busy shift time over observed shift time, percent. */
  utilisationPercent: number | null;
  availableSeconds: number | null;
  observedSeconds: number | null;
  busyInShiftSeconds: number | null;
  /** The in-shift gaps of at least 5 minutes. */
  gaps: StationGap[];
  byElementType: ElementTypeCount[];
  firstScanAt: Iso | null;
  lastScanAt: Iso | null;
  /** Days with activity (1 for a day row). */
  daysActive: number;
  /** The day was over when the facts were computed (day rows; null for a period). */
  isComplete: boolean | null;
}

export interface StationAttention {
  /** Stations whose status is not Normal (and that have data). */
  count: number;
  stationNos: number[];
  names: string[];
  /** "3 stationer afviger fra det normale: Buffer, Station 30 og Montagebord 2" or "Alle stationer kører normalt". */
  sentence: string;
}

export interface StationDayReport {
  clock: Clock;
  day: Day;
  rows: StationRow[];
  attention: StationAttention;
}

export interface StationPeriodReport {
  clock: Clock;
  period: Period;
  rows: StationRow[];
  attention: StationAttention;
}

export interface TimelineInterval {
  intervalId: string;
  orderNo: number;
  barcode: string;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  elementTypeId: string | null;
  elementTypeName: string | null;
  status: "done" | "open" | "missing_out";
  missingReason: "stale" | "superseded" | null;
  visit: number | null;
  isRework: boolean;
  startAt: Iso;
  /** Null while open and on a missing scan-out. */
  endAt: Iso | null;
  startEstimated: boolean;
  duration: Duration;
  waitBefore: Duration;
}

export interface TypeDistribution {
  elementTypeId: string | null;
  /** The type's name, or "Uden type" for passes with no element type. */
  elementTypeName: string;
  passes: number;
  /** Wall clock. */
  minSeconds: number;
  p25Seconds: number;
  medianSeconds: number;
  p75Seconds: number;
  maxSeconds: number;
  meanSeconds: number;
  median: Duration;
  normalSeconds: number | null;
  /** Headline median against normal, percent. */
  deviationPercent: number | null;
}

export interface StationTrendPoint {
  weekStart: Day;
  isoYear: number;
  isoWeek: number;
  label: string;
  countThrough: number | null;
  timePerPiece: Duration;
  normalSeconds: number | null;
  deviationPercent: number | null;
  standstillSeconds: number | null;
}

export interface StationDetail {
  clock: Clock;
  day: Day;
  /** The station's row for the day. */
  station: StationRow;
  /** The day's passes, oldest first. The day's gaps are in station.gaps. */
  timeline: TimelineInterval[];
  /** Per element type over the trend range. */
  distribution: TypeDistribution[];
  distributionPeriod: Period;
  /** One point per ISO week, oldest first, empty weeks included. */
  trend: StationTrendPoint[];
}

// ---------------------------------------------------------------------------
// Ordrer
// ---------------------------------------------------------------------------

/** on_time: Til tiden. late: Forsinket. at_risk: Risiko for forsinkelse. unknown: no delivery week or no forecast. */
export type DeliveryStatusKey = "on_time" | "late" | "at_risk" | "unknown";

export interface FinishedOrderRow {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  dueAt: Iso | null;
  /** Elementer: the 3E count, or the elements seen when there is no document. */
  elements: number;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsPacked: number;
  startAt: Iso;
  packedAt: Iso;
  packedLocalDay: Day;
  /** Gennemløbstid. */
  lead: Duration;
  /** Heraf ventetid. */
  wait: Duration;
  work: Duration;
  touchSeconds: number;
  reworkCount: number;
  missingScanOutCount: number;
  onTime: boolean | null;
  status: DeliveryStatusKey;
  /** "Til tiden", "Forsinket" or "Ingen leveringsuge". */
  statusLabel: string;
  packedSource: "document" | "scans" | null;
  /** scans: no 3E document, say "uden produktionsliste". */
  expectedSource: "document" | "scans";
}

export interface InProgressOrderRow {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  dueAt: Iso | null;
  elements: number;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsAssembled: number;
  elementsPacked: number;
  startAt: Iso;
  lastScanAt: Iso;
  currentStep: StepKey | null;
  currentStationNos: number[];
  /** Er nu ved: station names, else "Montage, venter" or "Venter før pakning". */
  currentLabel: string;
  /** Tid indtil nu, as of computedAt. */
  elapsed: Duration;
  work: Duration;
  wait: Duration;
  /** Forventet klar: an estimate. Null without typical times. */
  forecastReadyAt: Iso | null;
  forecastRemainingSeconds: number | null;
  /** seen_elements: no document, the forecast only speaks for the elements seen. */
  forecastBasis: "document" | "seen_elements" | null;
  atRisk: boolean | null;
  status: DeliveryStatusKey;
  /** "Til tiden", "Risiko for forsinkelse", "Forsinket" or "Ukendt". */
  statusLabel: string;
  reworkCount: number;
  missingScanOutCount: number;
  openCount: number;
  expectedSource: "document" | "scans";
  computedAt: Iso;
}

export interface FoundOrder {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  status: "in_progress" | "packed";
  deliveryYear: number | null;
  deliveryWeek: number | null;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsPacked: number;
  startAt: Iso;
  packedAt: Iso | null;
  lastScanAt: Iso;
  /** What matched the query. */
  match: "order_no" | "order_no_prefix" | "customer" | "case_name";
}

export interface OrderHeader extends OrderRow {
  /** The 3E count, or the elements seen when there is no document. */
  elements: number;
  /** Gennemløbstid. Null durations until packed. */
  lead: Duration;
  /** Tid indtil nu (equals lead once packed). */
  elapsed: Duration;
  work: Duration;
  wait: Duration;
  deliveryStatus: DeliveryStatusKey;
  deliveryStatusLabel: string;
  /** "Pakket", or where the order is now. */
  currentLabel: string;
}

export interface OrderStep extends OrderStepRow {
  label: string;
  /** Time counted to the step. Draw startAt to endAt, print this. */
  duration: Duration;
  work: Duration;
  wait: Duration;
  /** A deviation note points at this step: draw it as "Afvigelse". */
  deviation: boolean;
}

export interface OrderElement extends ElementRow {
  elementTypeName: string | null;
  /** stationPath as station names, one per pass. */
  pathLabels: string[];
  total: Duration;
}

export interface OrderInterval extends StationIntervalRow {
  /** The station's name today (config.stations), else its name at scan time. */
  stationName: string;
  /** The normal time for this element type at this station. */
  normalSeconds: number | null;
  duration: Duration;
  waitBefore: Duration;
  /** Headline duration against normal, percent. */
  deviationPercent: number | null;
}

export type DeviationCode =
  | "packed_late"
  | "deadline_passed"
  | "forecast_late"
  | "rework"
  | "long_wait"
  | "slow_pass"
  | "missing_scan_out"
  | "missing_elements";

export interface DeviationNote {
  /** problem: it went wrong ("Her gik det galt"). watch: keep an eye on it ("Hold øje med"). */
  severity: "problem" | "watch";
  code: DeviationCode;
  /** Danish, ready to show. */
  text: string;
  step: StepKey | null;
  stationNo: number | null;
  barcode: string | null;
  seconds: number | null;
}

export interface OrderDocumentInfo {
  fileName: string;
  orderNo: number | null;
  prefix: string | null;
  printDate: Day | null;
  /** Hand to MasterDataBlob/GetTempUrl for the PDF viewer. */
  blobReference: string | null;
  blobName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  syncedAt: Iso;
  /** Null: not parsed yet. */
  parsedAt: Iso | null;
  parserVersion: string | null;
  pageCount: number | null;
  header: OrderDocumentHeader | null;
  positions: OrderPosition[];
  /** What the parser could not read. */
  problems: string[];
}

export interface OrderDetail {
  clock: Clock;
  order: OrderHeader;
  /** Always seven, in route order. */
  steps: OrderStep[];
  elements: OrderElement[];
  /** Every pass, oldest first, missing scan-outs included. */
  intervals: OrderInterval[];
  notes: DeviationNote[];
  /** "Her gik det galt", "Hold øje med" or "Ingen afvigelser". */
  notesHeadline: string;
  documents: OrderDocumentInfo[];
}

export interface OrderStatusSummary {
  clock: Clock;
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  status: "in_progress" | "packed";
  currentLabel: string;
  currentStep: StepKey | null;
  currentStationNos: number[];
  elements: number;
  elementsSeen: number;
  elementsAssembled: number;
  elementsPacked: number;
  startAt: Iso;
  packedAt: Iso | null;
  elapsed: Duration;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  dueAt: Iso | null;
  forecastReadyAt: Iso | null;
  forecastBasis: "document" | "seen_elements" | null;
  deliveryStatus: DeliveryStatusKey;
  deliveryStatusLabel: string;
  /** Steps that are finished, by label. */
  stepsDone: string[];
  computedAt: Iso;
}

export interface OrderRoute {
  clock: Clock;
  orderNo: number;
  status: "in_progress" | "packed";
  lead: Duration;
  elapsed: Duration;
  work: Duration;
  wait: Duration;
  steps: OrderStep[];
  notes: DeviationNote[];
  notesHeadline: string;
}

// ---------------------------------------------------------------------------
// Ledelse
// ---------------------------------------------------------------------------

export interface CalcVsMeasuredRow {
  stationNo: number;
  stationName: string;
  stationKind: string | null;
  elementTypeId: string;
  elementTypeName: string;
  /** Kalkule: config.calculated_times. Null when none is entered. */
  calculatedSeconds: number | null;
  normalSeconds: number | null;
  passes: number;
  reworkPasses: number;
  /** Målt: the median pass time. Null durations with no passes. */
  measured: Duration;
  meanSeconds: number | null;
  /** (measured - calculated) / calculated, percent. Null without both. */
  deviationPercent: number | null;
  /** The deviation is larger than calculation_deviation_threshold_percent, either way. */
  flagged: boolean;
}

/** One element type across the stations where both a calculated and a measured time exist. */
export interface CalcVsMeasuredType {
  elementTypeId: string;
  elementTypeName: string;
  /** Sums over the stations with both figures. Null when no station has both. */
  calculatedSeconds: number | null;
  measuredSeconds: number | null;
  deviationPercent: number | null;
  flagged: boolean;
  /** Stations compared, and stations left out because one figure is missing. */
  stationsCompared: number;
  stationsIncomplete: number;
  passes: number;
}

export interface CalcVsMeasured {
  clock: Clock;
  period: Period;
  thresholdPercent: number;
  rows: CalcVsMeasuredRow[];
  byElementType: CalcVsMeasuredType[];
}

export interface ManagementNotes {
  /** First day of the month. */
  month: Day;
  /** Det vigtigste. */
  highlights: string[];
  /** Til beslutning. */
  decisions: string[];
  updatedAt: Iso | null;
  updatedBy: string | null;
}

/** Everything the monthly report shows. This object is what a snapshot stores. */
export interface MonthReport {
  version: 1;
  month: Day;
  period: Period;
  generatedAt: Iso;
  clock: Clock;
  settings: ReportSettings;
  /** The month against the month before. The three Ledelse KPIs are lead, onTimePercent and wait. */
  kpis: PeriodKpis;
  /** Twelve months ending with this one. */
  leadTimeMonthly: LeadTimePoint[];
  /** The weeks of the month. */
  leadTimeWeekly: LeadTimePoint[];
  bottleneck: Bottleneck;
  stations: StationRow[];
  stationAttention: StationAttention;
  calcVsMeasured: CalcVsMeasured;
  notes: ManagementNotes;
  missingScanOuts: number;
}

export interface MonthReportResult {
  report: MonthReport;
  /** True: read from rpt.snapshots. False: computed now. */
  frozen: boolean;
  frozenAt: Iso | null;
  pdfPath: string | null;
}

export interface SnapshotInfo {
  month: Day;
  frozenAt: Iso;
  pdfPath: string | null;
}

export interface FreezeResult {
  month: Day;
  /** False: the month was frozen already and was left alone. */
  written: boolean;
  frozenAt: Iso;
}

// ---------------------------------------------------------------------------
// Lists, and the two chat questions without data
// ---------------------------------------------------------------------------

export interface MissingScanOut {
  intervalId: string;
  orderNo: number;
  customer: string | null;
  barcode: string;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  elementTypeId: string | null;
  stationNo: number;
  stationName: string;
  stationKind: string;
  /** When it was scanned In. */
  startAt: Iso;
  localDay: Day;
  /** stale: no Out within 36 hours. superseded: a later In took its place. */
  missingReason: "stale" | "superseded";
  /** "Ingen ud-scanning i 36 timer" or "Afløst af en senere ind-scanning". */
  reasonLabel: string;
  orderStatus: "in_progress" | "packed";
}

export interface IncompletePackedOrder {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  status: "in_progress" | "packed";
  deliveryYear: number | null;
  deliveryWeek: number | null;
  elementsExpected: number | null;
  elementsSeen: number;
  elementsPacked: number;
  /** The 3E positions not fully packed. */
  missingElements: { position: number; subPosition: number; expected: number; seen: number; packed: number }[];
  lastScanAt: Iso;
}

export interface BaselineSuggestionRow {
  stationNo: number;
  stationName: string;
  stationKind: string | null;
  /** Null: passes with no element type (cannot become a normal time). */
  elementTypeId: string | null;
  elementTypeName: string | null;
  samples: number;
  /** The suggestion: the median pass time on the headline clock. */
  suggestedSeconds: number;
  median: Duration;
  meanSeconds: number;
  p25Seconds: number;
  p75Seconds: number;
  /** The normal time in force, and where it came from. */
  currentSeconds: number | null;
  currentSource: "manual" | "baseline" | null;
}

export interface BaselineSuggestion {
  clock: Clock;
  period: Period;
  weeks: number;
  rows: BaselineSuggestionRow[];
}

export interface CapacityDay {
  day: Day;
  /** ISO weekday, 1 Monday. */
  weekday: number;
  closed: boolean;
  closedName: string | null;
  /** Shift time of the day from the calendar. */
  shiftSeconds: number;
  plannedOrders: number | null;
  plannedLoadSeconds: number | null;
}

export interface CapacityPlan {
  /** False until planned orders are delivered from 3E. */
  available: false;
  reason: "no_planned_orders";
  /** Danish, ready to show. */
  message: string;
  weekStart: Day;
  isoWeek: number;
  /** What is known: the calendar. */
  days: CapacityDay[];
  assemblyStations: number;
  /** Orders in progress with this delivery week. */
  openOrdersDue: number;
}

export interface StaffingDay {
  stationNo: number;
  stationName: string;
  stationKind: string | null;
  localDay: Day;
  countThrough: number;
  timePerPiece: Duration;
  busyInShiftSeconds: number;
  observedSeconds: number;
  people: number | null;
}

export interface StaffingAnalysis {
  /** False until the number of people per station is recorded somewhere. */
  available: false;
  reason: "no_staffing_data";
  message: string;
  clock: Clock;
  period: Period;
  /** What is known: output per station per day. */
  days: StaffingDay[];
}
