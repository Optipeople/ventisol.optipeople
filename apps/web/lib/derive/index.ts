// The derive layer of the read model: raw scans in, core.* rows out. Pure.
// Definitions: docs/read-model.md.

export * from "./types";
export {
  ALWAYS_OPEN,
  DEFAULT_CALENDAR,
  addWorkingSeconds,
  isoWeekMonday,
  isoWeekday,
  localInstant,
  parseClock,
  shiftBlocksOn,
  workingMsBetween,
  workingSecondsBetween,
} from "./calendar";
export { endOrNow, kindOf, pairHistory, type PairOptions, type PairedInterval } from "./pairing";
export {
  DEFAULT_PARALLEL_SPLIT,
  PARALLEL_SPLITS,
  splitStationTime,
  type ParallelSplit,
  type SplitPass,
  type SplitShare,
} from "./allocate";
export { deriveOrder, deriveOrders, dueAtFor, resolveParams, roundParts } from "./order";
export {
  DEFAULT_THRESHOLDS,
  STATION_STATUS_LABELS,
  deriveStationDay,
  median,
  normalForMix,
  stationStatus,
  type StationStatus,
  type StationStatusKey,
  type StationThresholds,
} from "./station";
export {
  currentLabel,
  forecastOrder,
  forecastRemainingSeconds,
  type Forecast,
  type ForecastElement,
  type ForecastInput,
} from "./forecast";
export {
  affectedBy,
  mergeStationDays,
  needsClockRefresh,
  stationDaysTouched,
  type Affected,
  type StationDay,
} from "./plan";
export { CORE_TABLES, JSONB_FIELDS, insertSql, toDbRow, toSnake, type CoreTable } from "./rows";
