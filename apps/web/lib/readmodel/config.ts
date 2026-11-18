// What lib/derive needs besides the scans, read from config.* on every run:
// the calendar, the parameters, the element type rules and the typical times
// for the forecast.

import type { Db } from "@/lib/db";
import {
  DEFAULT_PARAMS,
  type DeriveParams,
  type StationKind,
  type TypicalStation,
  type TypicalTimes,
  type WorkCalendar,
} from "@/lib/derive";
import type { ElementTypeRule } from "@/lib/orderdoc/element-types";
import { addDays, dayKey } from "@/lib/time";
import { rulesFromConfig } from "./orderinfo";

/**
 * config.settings keys that change what is STORED in core.*. After one of
 * them changes, core.* must be rebuilt (onSettingsChanged does it).
 *
 *   late_threshold                      onTimeGraceDays: due_at, on_time, at_risk
 *   schirmer_assumed_minutes_per_batch  schirmerAssumedSeconds: the assumed
 *                                       Schirmer row of core.order_steps
 *   on_time_week_offset                 onTimeWeekOffset (not seeded; default 0)
 *
 * Every other seeded key is applied when a report is read and needs no
 * rebuild: deduct_off_shift (picks x_seconds or x_working_seconds),
 * slow_threshold_percent, long_dwell_threshold_minutes,
 * standstill_threshold_minutes (all three: stationStatus in lib/derive),
 * calculation_deviation_threshold_percent and buffer_capacity.
 */
export const DERIVE_TIME_SETTINGS = [
  "late_threshold",
  "schirmer_assumed_minutes_per_batch",
  "on_time_week_offset",
] as const;

/** Days of history behind the typical times. */
export const TYPICAL_WINDOW_DAYS = 28;

export interface ReadModelConfig {
  calendar: WorkCalendar;
  params: DeriveParams;
  rules: ElementTypeRule[];
  typical: TypicalTimes | null;
  /** "Max i gang" of the stations set above 1 (config.stations.max_open). Every other station has 1. */
  maxOpen: Record<number, number>;
}

function numberSetting(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** config.settings rows to derive parameters. Unknown keys and bad values keep the default. */
export function paramsFromSettings(rows: { key: string; value: unknown }[]): DeriveParams {
  const params: DeriveParams = { ...DEFAULT_PARAMS };
  for (const { key, value } of rows) {
    const n = numberSetting(value);
    if (n == null) continue;
    if (key === "late_threshold" && n >= 0) params.onTimeGraceDays = Math.round(n);
    // 0 or less: no assumed time is shown.
    if (key === "schirmer_assumed_minutes_per_batch") params.schirmerAssumedSeconds = n > 0 ? Math.round(n * 60) : null;
    if (key === "on_time_week_offset") params.onTimeWeekOffset = Math.round(n);
  }
  return params;
}

/** config.calendar_shifts and config.calendar_closed_days as a WorkCalendar. */
export async function loadCalendar(db: Db): Promise<WorkCalendar> {
  const shifts = await db.query<{ weekday: number; start_time: string; end_time: string }>(
    "select weekday, start_time::text as start_time, end_time::text as end_time from config.calendar_shifts order by weekday, start_time"
  );
  const closed = await db.query<{ day: string }>("select day from config.calendar_closed_days order by day");
  const calendar: WorkCalendar = { shifts: {}, closedDays: closed.map((c) => c.day) };
  for (const s of shifts) {
    // "06:00:00" to "06:00"; the end of the day is stored as 24:00:00.
    (calendar.shifts[s.weekday] ??= []).push({ start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) });
  }
  return calendar;
}

/**
 * Typical times for the forecast, in floor order (config.stations sort
 * order, assembly and packing stations that are active).
 *
 *   - Per element type: config.normal_times.
 *   - Any type: the median finished pass at the station over the last
 *     TYPICAL_WINDOW_DAYS whole days before today, from core.station_intervals;
 *     with no history, the median of the station's normal times.
 *   - Share of elements that pass the station: from the same history, else 1.
 *   - Wait before packing: the median shift time an element waited before
 *     its first packing pass, same history.
 *
 * Only days before today count, so the answer is the same all day and a run
 * repeated gives the same forecast. Null when no station is set up.
 */
export async function loadTypical(db: Db, now: number): Promise<TypicalTimes | null> {
  const stations = await db.query<{ station_no: number; kind: string }>(
    `select station_no, kind from config.stations
      where active and kind in ('assembly', 'packing')
      order by sort_order, station_no`
  );
  if (stations.length === 0) return null;

  const today = dayKey(now);
  const from = addDays(today, -TYPICAL_WINDOW_DAYS);
  const normal = await db.query<{ station_no: number; element_type_id: string; seconds: number }>(
    "select station_no, element_type_id, seconds from config.normal_times order by station_no, element_type_id"
  );
  const history = await db.query<{ station_no: number; median: number | null; elements: number }>(
    `select station_no,
            percentile_cont(0.5) within group (order by duration_seconds) as median,
            count(distinct barcode) as elements
       from core.station_intervals
      where status = 'done' and local_day >= $1::date and local_day < $2::date
      group by station_no`,
    [from, today]
  );
  const totals = await db.query<{ elements: number; wait: number | null }>(
    `select count(distinct barcode) as elements,
            percentile_cont(0.5) within group (order by wait_before_working_seconds)
              filter (where station_kind = 'packing' and visit = 1) as wait
       from core.station_intervals
      where status = 'done' and local_day >= $1::date and local_day < $2::date`,
    [from, today]
  );
  const allElements = Number(totals[0]?.elements ?? 0);
  const byStation = new Map(history.map((h) => [h.station_no, h]));

  const route: TypicalStation[] = stations.map((s) => {
    const byType: Record<string, number> = {};
    for (const n of normal) if (n.station_no === s.station_no) byType[n.element_type_id] = n.seconds;
    const normals = Object.values(byType).sort((a, b) => a - b);
    const seen = byStation.get(s.station_no);
    const fromNormals = normals.length > 0 ? normals[Math.floor((normals.length - 1) / 2)] : null;
    const share =
      seen && allElements > 0 ? Math.min(1, Math.max(0.01, Math.round((Number(seen.elements) / allElements) * 100) / 100)) : 1;
    return {
      stationNo: s.station_no,
      kind: s.kind as StationKind,
      seconds: seen?.median != null ? Math.round(Number(seen.median)) : fromNormals,
      ...(normals.length > 0 ? { secondsByType: byType } : {}),
      share,
    };
  });
  const wait = totals[0]?.wait;
  return { stations: route, waitBeforePackingSeconds: wait != null ? Math.round(Number(wait)) : null };
}

/** config.stations.max_open of the stations set above 1. */
export async function loadMaxOpen(db: Db): Promise<Record<number, number>> {
  const rows = await db.query<{ station_no: number; max_open: number }>(
    "select station_no, max_open from config.stations where max_open > 1 order by station_no"
  );
  return Object.fromEntries(rows.map((r) => [r.station_no, Number(r.max_open)]));
}

/** Everything derive needs from config.*, in one go. */
export async function loadConfig(db: Db, now: number): Promise<ReadModelConfig> {
  const calendar = await loadCalendar(db);
  const settings = await db.query<{ key: string; value: unknown }>("select key, value from config.settings");
  const types = await db.query<{ id: string; recognition: unknown; active: boolean }>(
    "select id, recognition, active from config.element_types order by sort_order, id"
  );
  return {
    calendar,
    params: paramsFromSettings(settings),
    rules: rulesFromConfig(types),
    typical: await loadTypical(db, now),
    maxOpen: await loadMaxOpen(db),
  };
}
