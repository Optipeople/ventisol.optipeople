// Inputs, parameters and output rows of the derive layer.
//
// Output rows are JSON friendly and map 1:1 onto the core.* tables of
// supabase/migrations/20261116110000_core.sql: camelCase here, snake_case
// there (see rows.ts for the mechanical conversion). Timestamps are ISO 8601
// UTC strings, durations whole seconds, unknown is null (never 0).
//
// The definitions behind every field are in docs/read-model.md.

/** ISO 8601 UTC instant, e.g. "2026-10-21T06:00:00.000Z". */
export type Iso = string;
/** Europe/Copenhagen calendar day, yyyy-MM-dd. */
export type LocalDay = string;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One line of the 3E production list, as lib/orderdoc will deliver it. */
export interface ExpectedElement {
  position: number;
  /** 1 (or left out) is the position itself, as on the label. */
  subPosition?: number | null;
  /** Pieces of this position the order holds. */
  quantity: number;
  elementTypeId: string | null;
  system?: string | null;
  widthMm?: number | null;
  heightMm?: number | null;
}

/** What the 3E document says about an order. Null when no document is known. */
export interface OrderInfo {
  orderNo: number;
  customer?: string | null;
  caseName?: string | null;
  deliveryAddress?: string | null;
  /** Lev. uge, ISO week number. */
  deliveryWeek: number | null;
  /** Left out: the year whose week lies nearest the order's first scan. */
  deliveryYear?: number | null;
  expectedElements: ExpectedElement[];
}

/** One shift block in Europe/Copenhagen wall clock, "HH:MM" to "HH:MM", same day. */
export interface ShiftBlock {
  start: string;
  end: string;
}

/**
 * Working time. Maps onto config.calendar_shifts and
 * config.calendar_closed_days. A break is modelled as two blocks.
 */
export interface WorkCalendar {
  /** ISO weekday (1 Monday to 7 Sunday) to its shift blocks. Missing: closed. */
  shifts: Record<number, ShiftBlock[]>;
  /** Closed days (holidays), yyyy-MM-dd. */
  closedDays: string[];
}

/** Typical times for the forecast: the route in floor order. */
export interface TypicalStation {
  stationNo: number;
  kind: StationKind;
  /** Typical seconds per piece here, any type. Null: not known. */
  seconds: number | null;
  /** Typical seconds per piece per element type; wins over `seconds`. */
  secondsByType?: Record<string, number>;
  /** Share of elements that pass this station, 0 to 1. Default 1. */
  share?: number;
}

export interface TypicalTimes {
  stations: TypicalStation[];
  /** Typical wait from the last assembly Out to the first packing In. */
  waitBeforePackingSeconds: number | null;
}

/** Every rule Ventisol may want changed. Defaults in DEFAULT_PARAMS. */
export interface DeriveParams {
  /** An In with no Out is in progress for this long, then a missing scan-out. */
  staleOpenSeconds: number;
  /**
   * Without a 3E document: seconds with no scan on the order before "every
   * element seen is packed" is taken to mean the order is packed.
   */
  packedQuietSeconds: number;
  /** Weeks added to Lev. uge to get the target week (-1: the week before). */
  onTimeWeekOffset: number;
  /** Days after the end of the target week before an order is late. */
  onTimeGraceDays: number;
  /** Assumed Schirmer time per order, shown as "antaget". Null: not shown. */
  schirmerAssumedSeconds: number | null;
  /** In-shift gaps shorter than this are not stored on station_day_facts. */
  gapFloorSeconds: number;
  /** Count the shift time before a station's first scan of the day as idle. */
  standstillCountBeforeFirstScan: boolean;
  /** Count the shift time after a station's last scan of the day as idle. */
  standstillCountAfterLastScan: boolean;
}

export const DEFAULT_PARAMS: DeriveParams = {
  staleOpenSeconds: 36 * 3600,
  packedQuietSeconds: 12 * 3600,
  onTimeWeekOffset: 0,
  onTimeGraceDays: 0,
  schirmerAssumedSeconds: null,
  gapFloorSeconds: 300,
  standstillCountBeforeFirstScan: false,
  standstillCountAfterLastScan: true,
};

export interface DeriveContext {
  /** The moment the facts are computed for, epoch ms. Never read from the clock here. */
  now: number;
  calendar: WorkCalendar;
  params?: Partial<DeriveParams>;
  /** "Max i gang" per station number (config.stations.max_open). A station not listed has 1. */
  maxOpen?: Readonly<Record<number, number>>;
  /**
   * Per station number: the starts (epoch ms) of the Ins still open on orders
   * that are NOT in the scans handed in. A station has at most its "Max i
   * gang" elements in progress, so an open In with that many later open Ins
   * at its station, these included, is a missing scan-out. Not needed when
   * all scans are given.
   */
  otherOpenInsByStation?: Record<number, number[]>;
  /** Typical times for the forecast. Left out: no forecast. */
  typical?: TypicalTimes | null;
}

// ---------------------------------------------------------------------------
// Shared vocab
// ---------------------------------------------------------------------------

export type StationKind = "assembly" | "packing";

export type IntervalStatus = "done" | "open" | "missing_out";
/** stale: older than staleOpenSeconds. superseded: a later In took the station (or the element). */
export type MissingReason = "stale" | "superseded";

export const STEP_KEYS = [
  "schirmer",
  "wait_kmw",
  "kmw",
  "buffer",
  "assembly",
  "wait_packing",
  "packing",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export type StepKind = "work" | "wait";
/** scans: measured from scans. machine: from a connector. assumed: a setting. none: no data yet. */
export type StepSource = "scans" | "machine" | "assumed" | "none";

export const STEP_KIND: Record<StepKey, StepKind> = {
  schirmer: "work",
  wait_kmw: "wait",
  kmw: "work",
  buffer: "wait",
  assembly: "work",
  wait_packing: "wait",
  packing: "work",
};

/** Danish labels as the deck shows them. */
export const STEP_LABELS: Record<StepKey, string> = {
  schirmer: "Schirmer",
  wait_kmw: "Venter før KMW",
  kmw: "KMW-anlægget",
  buffer: "Buffer",
  assembly: "Montage",
  wait_packing: "Venter før pakning",
  packing: "Pakning",
};

export type OrderStatus = "in_progress" | "packed";

// ---------------------------------------------------------------------------
// Rows (core.*)
// ---------------------------------------------------------------------------

export interface MissingElement {
  position: number;
  subPosition: number;
  expected: number;
  seen: number;
  packed: number;
}

/** core.orders: one row per order, identity and facts together. */
export interface OrderRow {
  orderNo: number;
  customer: string | null;
  caseName: string | null;
  deliveryAddress: string | null;
  deliveryYear: number | null;
  deliveryWeek: number | null;
  /** The first instant that is too late. Null without a delivery week. */
  dueAt: Iso | null;
  status: OrderStatus;
  /** How "packed" was decided: the 3E element list, or the scans alone. Null while not packed. */
  packedSource: "document" | "scans" | null;
  /** Where the expected element count comes from. scans: no document, so only what was seen. */
  expectedSource: "document" | "scans";
  /** From the document. Null without one. */
  elementsExpected: number | null;
  elementsSeen: number;
  elementsAssembled: number;
  elementsPacked: number;
  /** Document positions not fully packed yet. Null without a document. */
  missingElements: MissingElement[] | null;
  firstScanAt: Iso;
  lastScanAt: Iso;
  /** Where lead time starts. Today the first scan (or a start put back from DurationSec). */
  startAt: Iso;
  startSource: "first_scan" | "machine";
  packedAt: Iso | null;
  startLocalDay: LocalDay;
  packedLocalDay: LocalDay | null;
  /** Start to packed. Null until packed. */
  leadSeconds: number | null;
  leadWorkingSeconds: number | null;
  /** Start to packed, or to computedAt while in progress. */
  elapsedSeconds: number;
  elapsedWorkingSeconds: number;
  /** Time when at least one element was at a station. workSeconds + waitSeconds = elapsedSeconds. */
  workSeconds: number;
  workWorkingSeconds: number;
  waitSeconds: number;
  waitWorkingSeconds: number;
  /** Sum of every pass (two elements at once count twice): the "time per order" of the station screen. */
  touchSeconds: number;
  reworkCount: number;
  missingScanOutCount: number;
  openCount: number;
  /** Packed before dueAt. Null until packed or without a delivery week. */
  onTime: boolean | null;
  /** In progress only: the step the order is in at computedAt. */
  currentStep: StepKey | null;
  /** In progress only: stations with an element of the order on them now. */
  currentStationNos: number[];
  /** Estimate. Null when packed or without typical times. */
  forecastReadyAt: Iso | null;
  forecastRemainingSeconds: number | null;
  forecastBasis: "document" | "seen_elements" | null;
  /** In progress with a due time: already late, or the forecast lands after it. */
  atRisk: boolean | null;
  computedAt: Iso;
}

/** core.elements: one row per barcode seen in a scan. */
export interface ElementRow {
  barcode: string;
  orderNo: number;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  elementTypeId: string | null;
  /** Its position is on the 3E list. Null without a document. */
  inDocument: boolean | null;
  system: string | null;
  widthMm: number | null;
  heightMm: number | null;
  firstScanAt: Iso;
  lastScanAt: Iso;
  /** Station numbers in the order visited, one entry per pass. */
  stationPath: number[];
  /** First start to last end of its passes (to computedAt while one is open). */
  totalSeconds: number | null;
  totalWorkingSeconds: number | null;
  /** Sum of its passes. */
  touchSeconds: number;
  reworkCount: number;
  missingScanOutCount: number;
  inProgress: boolean;
  currentStationNo: number | null;
  assembledAt: Iso | null;
  packedAt: Iso | null;
}

/** core.station_intervals: one element at one station, In to Out. */
export interface StationIntervalRow {
  /** The In scan's id, or the Out scan's when the In is missing. */
  intervalId: string;
  orderNo: number;
  barcode: string;
  /** 0 when the scan carried no station number. */
  stationNo: number;
  /** Station name at scan time. */
  station: string;
  stationKind: StationKind;
  /** 1 for the first pass, 2+ for rework. Null on a missing scan-out. */
  visit: number | null;
  isRework: boolean;
  status: IntervalStatus;
  missingReason: MissingReason | null;
  startAt: Iso;
  /** Null while open and on a missing scan-out. */
  endAt: Iso | null;
  /** The In is missing: the start was put back from the Out's DurationSec. */
  startEstimated: boolean;
  durationSeconds: number | null;
  durationWorkingSeconds: number | null;
  /**
   * Split time (docs/read-model.md §2): the pass's share of its station's time
   * when several elements were on it at once; the whole time when alone. Up to
   * now while open, null on a missing scan-out. Set by the station-day rebuild
   * (it needs the other orders' passes): null when an order is derived.
   */
  allocatedSeconds: number | null;
  allocatedWorkingSeconds: number | null;
  /** Time since the element's previous Out, at any station. Null on its first pass. */
  waitBeforeSeconds: number | null;
  waitBeforeWorkingSeconds: number | null;
  elementTypeId: string | null;
  /** The day the pass counts on: the day it ended, or the day it started while it has no end. */
  localDay: LocalDay;
  inScanId: string | null;
  outScanId: string | null;
}

/** core.order_steps: always seven rows per order. */
export interface OrderStepRow {
  orderNo: number;
  step: StepKey;
  seq: number;
  kind: StepKind;
  source: StepSource;
  /** First and last instant counted to the step. */
  startAt: Iso | null;
  endAt: Iso | null;
  /** Time counted to the step. Can be less than endAt - startAt when steps interleave. */
  durationSeconds: number | null;
  durationWorkingSeconds: number | null;
  workSeconds: number | null;
  workWorkingSeconds: number | null;
  waitSeconds: number | null;
  waitWorkingSeconds: number | null;
  /** Sum of the passes at this step's stations. */
  touchSeconds: number | null;
  /** The order is in this step at computedAt. */
  isOpen: boolean;
  /** False for assumed and missing steps: they are not part of the measured lead time. */
  countsInLead: boolean;
}

export interface StationGap {
  startAt: Iso;
  endAt: Iso;
  seconds: number;
}

export interface ElementTypeCount {
  elementTypeId: string | null;
  count: number;
  medianSeconds: number;
  meanSeconds: number;
}

/** core.station_day_facts: one row per station per Copenhagen day with activity. */
export interface StationDayFactsRow {
  stationNo: number;
  localDay: LocalDay;
  station: string;
  stationKind: StationKind;
  /** Finished passes that ended this day ("Gennem i dag"). */
  countThrough: number;
  /** Distinct elements among them. */
  elementsThrough: number;
  reworkPasses: number;
  missingScanOutCount: number;
  openCount: number;
  /** Median of the finished passes ("Tid pr. stk."). Null with none. */
  timePerPieceSeconds: number | null;
  timePerPieceWorkingSeconds: number | null;
  meanPieceSeconds: number | null;
  passSecondsTotal: number;
  /** Shift seconds of the whole day. 0 on a closed day. */
  availableSeconds: number;
  /** Shift seconds up to computedAt (equals availableSeconds once the day is over). */
  observedSeconds: number;
  /** Seconds with an element at the station, inside the day. */
  busySeconds: number;
  busyInShiftSeconds: number;
  /** Shift seconds with no element at the station, inside the standstill window. */
  idleSeconds: number;
  longestGapSeconds: number;
  /** The in-shift gaps of at least gapFloorSeconds. "Stod stille" is summed from these at read time. */
  gaps: StationGap[];
  /** Longest wait of an element before its pass here (passes ended or open this day). */
  longestWaitBeforeSeconds: number | null;
  longestWaitBeforeWorkingSeconds: number | null;
  firstScanAt: Iso | null;
  lastScanAt: Iso | null;
  byElementType: ElementTypeCount[];
  /** The day was over at computedAt. */
  isComplete: boolean;
  computedAt: Iso;
}

/** Everything derived for one order: replace the order's rows with these. */
export interface DerivedOrder {
  order: OrderRow;
  elements: ElementRow[];
  intervals: StationIntervalRow[];
  steps: OrderStepRow[];
}
