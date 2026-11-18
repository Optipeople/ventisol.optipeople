// Reading raw.* and writing core.*. Every function here takes the `db` of a
// withService transaction; index.ts decides how the work is cut into
// transactions.
//
// Rows go in with one statement per table and chunk:
// `insert ... select ... from jsonb_populate_recordset(null::core.x, $1::jsonb)`.
// The table's own column types turn the JSON into rows (timestamps from ISO
// text, integer[] from a JSON array, jsonb as it is), so there is one
// parameter however many rows there are, and no per-row round trip.

import type { Db } from "@/lib/db";
import {
  CORE_TABLES,
  deriveOrders,
  deriveStationDay,
  mergeStationDays,
  splitStationTime,
  stationDaysTouched,
  type SplitPass,
  toSnake,
  type CoreTable,
  type DerivedOrder,
  type OrderInfo,
  type StationDay,
  type StationDayFactsRow,
  type StationIntervalRow,
} from "@/lib/derive";
import type { Scan } from "@/lib/scans";
import { addDays, dayEnd, dayStart } from "@/lib/time";
import type { ReadModelConfig } from "./config";
import { orderInfoFromDocument, type SeenElement } from "./orderinfo";

/**
 * One writer at a time. Every transaction that reads raw.* or core.* in order
 * to write core.* takes this transaction-level advisory lock first, so a
 * rebuild and the minute sync never write an order from an older read over a
 * newer one. It is released at commit, and it works through the transaction
 * pooler (no session state).
 */
const WRITER_LOCK = 7_260_116;

export async function lockWriter(db: Db): Promise<void> {
  await db.query("select pg_advisory_xact_lock($1::bigint)", [WRITER_LOCK]);
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = (value: Date | string | null) => (value == null ? null : iso(value));

// ---------------------------------------------------------------------------
// config.stations
// ---------------------------------------------------------------------------

/**
 * A station number seen in a scan and not yet in config.stations gets a row:
 * name and kind from its newest scan, active, sorted by its number. A row
 * that exists is never touched (an admin may have renamed it), which is what
 * `on conflict do nothing` guarantees. `stationNos` null looks at every scan.
 */
export async function ensureStations(db: Db, stationNos: number[] | null): Promise<number> {
  if (stationNos != null && stationNos.length === 0) return 0;
  const inserted = await db.query(
    `insert into config.stations (station_no, name, kind, sort_order, active)
     select distinct on (s.station_no)
            s.station_no,
            coalesce(nullif(btrim(s.station), ''), 'Station nr. ' || s.station_no),
            case when lower(s.station_kind) = 'packing' then 'packing' else 'assembly' end,
            s.station_no,
            true
       from raw.scans s
      where s.station_no is not null
        and ($1::int[] is null or s.station_no = any($1::int[]))
      order by s.station_no, s.scan_time desc nulls last, s.scan_id desc
     on conflict (station_no) do nothing
     returning station_no`,
    [stationNos]
  );
  return inserted.length;
}

// ---------------------------------------------------------------------------
// raw.* in
// ---------------------------------------------------------------------------

interface RawScanRow {
  scan_id: string;
  barcode: string;
  order_no: number;
  position: number | null;
  sub_position: number | null;
  piece: number | null;
  station: string | null;
  station_no: number | null;
  station_kind: string | null;
  direction: "In" | "Out";
  scan_time: Date;
  duration_sec: number | null;
  device: string | null;
}

/** The whole scan history of these orders. Rows that are no scan (no barcode, direction or time) are left out. */
export async function loadScans(db: Db, orderNos: number[]): Promise<Scan[]> {
  if (orderNos.length === 0) return [];
  const rows = await db.query<RawScanRow>(
    `select scan_id, barcode, order_no, position, sub_position, piece, station, station_no,
            station_kind, direction, scan_time, duration_sec, device
       from raw.scans
      where order_no = any($1::int[])
        and barcode is not null and direction is not null and scan_time is not null
      order by scan_time, scan_id`,
    [orderNos]
  );
  return rows.map((r) => ({
    id: r.scan_id,
    barcode: r.barcode,
    orderNo: r.order_no,
    position: r.position,
    subPosition: r.sub_position,
    piece: r.piece,
    // derive keys a scan without a station number on its name.
    station: r.station?.trim() || (r.station_no != null ? `Station nr. ${r.station_no}` : "Ukendt station"),
    stationNo: r.station_no,
    stationKind: r.station_kind?.trim() || "Assembly",
    direction: r.direction,
    time: r.scan_time.getTime(),
    durationSec: r.duration_sec != null && r.duration_sec >= 0 ? r.duration_sec : null,
    device: r.device,
  }));
}

/**
 * OrderInfo per order from its newest parsed document: newest print date,
 * then newest synced_at. Rows with no parsed object are ignored. Only the
 * header and, per position, what the mapping reads are fetched: a parsed
 * list with its cutting and hardware tables is far too heavy to pull for
 * every order in progress every minute.
 */
export async function loadOrderInfos(
  db: Db,
  orderNos: number[],
  scans: Scan[],
  rules: ReadModelConfig["rules"]
): Promise<OrderInfo[]> {
  if (orderNos.length === 0) return [];
  const rows = await db.query<{ order_no: number; header: unknown; positions: unknown }>(
    `select distinct on (d.order_no)
            d.order_no,
            d.parsed -> 'header' as header,
            (select jsonb_agg(jsonb_build_object(
                      'number', p.value -> 'number',
                      'subNumber', p.value -> 'subNumber',
                      'quantity', p.value -> 'quantity',
                      'system', p.value -> 'system',
                      'sizeWithoutCoupling', p.value -> 'sizeWithoutCoupling',
                      'fields', (select jsonb_agg(jsonb_build_object('opening', f.value -> 'opening') order by f.ordinality)
                                   from jsonb_array_elements(
                                          case when jsonb_typeof(p.value -> 'fields') = 'array'
                                               then p.value -> 'fields' else '[]'::jsonb end
                                        ) with ordinality as f)
                    ) order by p.ordinality)
               from jsonb_array_elements(
                      case when jsonb_typeof(d.parsed -> 'positions') = 'array'
                           then d.parsed -> 'positions' else '[]'::jsonb end
                    ) with ordinality as p) as positions
       from raw.order_documents d
      where d.order_no = any($1::int[]) and jsonb_typeof(d.parsed) = 'object'
      order by d.order_no, d.print_date desc nulls last, d.synced_at desc, d.file_name desc`,
    [orderNos]
  );
  const seen = new Map<number, Map<string, SeenElement>>();
  for (const s of scans) {
    let byBarcode = seen.get(s.orderNo);
    if (!byBarcode) seen.set(s.orderNo, (byBarcode = new Map()));
    if (!byBarcode.has(s.barcode)) {
      byBarcode.set(s.barcode, { barcode: s.barcode, position: s.position, subPosition: s.subPosition });
    }
  }
  const infos: OrderInfo[] = [];
  for (const row of rows) {
    const parsed = { header: row.header ?? {}, positions: row.positions ?? [] };
    const info = orderInfoFromDocument(row.order_no, parsed, [...(seen.get(row.order_no)?.values() ?? [])], rules);
    if (info) infos.push(info);
  }
  return infos;
}

// ---------------------------------------------------------------------------
// core.* out
// ---------------------------------------------------------------------------

/** One multi-row insert. Column names come from the row type's field names, never from data. */
async function insertRows(db: Db, table: CoreTable, rows: object[], onConflict = ""): Promise<void> {
  if (rows.length === 0) return;
  const fields = Object.keys(rows[0]);
  const columns = fields.map(toSnake);
  const payload = rows.map((row) => {
    const out: Record<string, unknown> = {};
    const values = row as Record<string, unknown>;
    fields.forEach((field, i) => (out[columns[i]] = values[field]));
    return out;
  });
  const list = columns.join(", ");
  await db.query(
    `insert into ${CORE_TABLES[table]} (${list})
     select ${list} from jsonb_populate_recordset(null::${CORE_TABLES[table]}, $1::jsonb)${onConflict}`,
    [JSON.stringify(payload)]
  );
}

type DayRow = Pick<StationIntervalRow, "stationNo" | "startAt" | "endAt" | "status">;

export interface ReplaceResult {
  /** Orders handed in: rebuilt, or removed because raw.scans no longer holds them. */
  orders: number;
  /** Station days the old and the new passes of those orders lie on. */
  days: StationDay[];
}

/**
 * Derives these orders from their whole scan history and replaces their rows.
 * The caller holds the writer lock. An order with no scan left is removed.
 *
 * Orders that can have an open In (scanned within staleOpenSeconds) must be
 * handed in TOGETHER: only then does "at most Max i gang per station" see
 * every open In. Open passes of orders outside the set are read from core.*
 * instead.
 */
export async function replaceOrders(
  db: Db,
  orderNos: number[],
  config: ReadModelConfig,
  now: number
): Promise<ReplaceResult> {
  if (orderNos.length === 0) return { orders: 0, days: [] };

  const oldRows = await db.query<{
    interval_id: string;
    station_no: number;
    start_at: Date;
    end_at: Date | null;
    status: DayRow["status"];
    allocated_seconds: number | null;
    allocated_working_seconds: number | null;
  }>(
    `select interval_id, station_no, start_at, end_at, status, allocated_seconds, allocated_working_seconds
       from core.station_intervals where order_no = any($1::int[])`,
    [orderNos]
  );
  const old: DayRow[] = oldRows.map((r) => ({
    stationNo: r.station_no,
    startAt: iso(r.start_at),
    endAt: isoOrNull(r.end_at),
    status: r.status,
  }));

  const scans = await loadScans(db, orderNos);
  const infos = await loadOrderInfos(db, orderNos, scans, config.rules);
  // Every open In of the orders outside the set: at most "Max i gang" per station.
  const others = await db.query<{ station_no: number; start_at: Date }>(
    `select station_no, start_at
       from core.station_intervals
      where status = 'open' and not (order_no = any($1::int[]))`,
    [orderNos]
  );
  const otherOpenInsByStation: Record<number, number[]> = {};
  for (const o of others) (otherOpenInsByStation[o.station_no] ??= []).push(o.start_at.getTime());

  const derived: DerivedOrder[] = deriveOrders(scans, infos, {
    now,
    calendar: config.calendar,
    params: config.params,
    typical: config.typical,
    maxOpen: config.maxOpen,
    otherOpenInsByStation,
  });

  // Elements, intervals and steps go with their order (on delete cascade).
  await db.query("delete from core.orders where order_no = any($1::int[])", [orderNos]);
  await insertRows(db, "orders", derived.map((d) => d.order));
  await insertRows(db, "elements", derived.flatMap((d) => d.elements));
  await insertRows(db, "stationIntervals", derived.flatMap((d) => d.intervals));
  await insertRows(db, "orderSteps", derived.flatMap((d) => d.steps));

  // Split time is made by the station-day rebuild, which follows. Until then
  // a pass that is the same as before keeps its share, so a rebuild that
  // stops half way (a time budget) leaves no hole in it.
  const kept = oldRows.filter((r) => r.allocated_seconds != null);
  if (kept.length > 0) {
    await db.query(
      `update core.station_intervals n
          set allocated_seconds = o.allocated_seconds, allocated_working_seconds = o.allocated_working_seconds
         from jsonb_to_recordset($1::jsonb) as o(interval_id text, start_at timestamptz, end_at timestamptz,
                                                 status text, allocated_seconds integer, allocated_working_seconds integer)
        where n.interval_id = o.interval_id and n.start_at = o.start_at
          and n.end_at is not distinct from o.end_at and n.status = o.status and n.status <> 'missing_out'`,
      [
        JSON.stringify(
          kept.map((r) => ({
            interval_id: r.interval_id,
            start_at: iso(r.start_at),
            end_at: isoOrNull(r.end_at),
            status: r.status,
            allocated_seconds: r.allocated_seconds,
            allocated_working_seconds: r.allocated_working_seconds,
          }))
        ),
      ]
    );
  }
  await refreshTouch(db, orderNos, now);

  const fresh = derived.flatMap((d) => d.intervals);
  return {
    orders: orderNos.length,
    days: mergeStationDays(
      stationDaysTouched(old as StationIntervalRow[], now),
      stationDaysTouched(fresh, now)
    ),
  };
}

/**
 * Order touch time in split time: core.elements, the assembly and packing
 * rows of core.order_steps and core.orders get the sum of their passes'
 * allocated_seconds. A pass not split yet counts its wall-clock time (an
 * open one up to `now`), the time deriveOrders put there. Only rows whose
 * figure changes are written.
 */
export async function refreshTouch(db: Db, orderNos: number[], now: number): Promise<void> {
  if (orderNos.length === 0) return;
  const pass = `with p as (
      select i.order_no, i.barcode, i.station_kind,
             coalesce(i.allocated_seconds, i.duration_seconds,
                      greatest(0, round(extract(epoch from ($2::timestamptz - i.start_at))))::integer) as seconds
        from core.station_intervals i
       where i.order_no = any($1::int[]) and i.status <> 'missing_out'
    )`;
  const params = [orderNos, new Date(now).toISOString()];
  await db.query(
    `${pass}
     update core.elements e set touch_seconds = t.seconds
       from (select barcode, sum(seconds)::integer as seconds from p group by barcode) t
      where e.barcode = t.barcode and e.order_no = any($1::int[]) and e.touch_seconds is distinct from t.seconds`,
    params
  );
  await db.query(
    `${pass}
     update core.order_steps s set touch_seconds = t.seconds
       from (select order_no, station_kind, sum(seconds)::integer as seconds from p group by order_no, station_kind) t
      where s.order_no = t.order_no and s.step = t.station_kind and s.touch_seconds is not null
        and s.touch_seconds is distinct from t.seconds`,
    params
  );
  await db.query(
    `${pass}
     update core.orders o set touch_seconds = t.seconds
       from (select order_no, sum(seconds)::integer as seconds from p group by order_no) t
      where o.order_no = t.order_no and o.touch_seconds is distinct from t.seconds`,
    params
  );
}

// ---------------------------------------------------------------------------
// core.station_day_facts
// ---------------------------------------------------------------------------

/** Longest stretch of days read in one go. */
export const DAY_WINDOW = 31;

interface IntervalDbRow {
  interval_id: string;
  order_no: number;
  barcode: string;
  station_no: number;
  station: string;
  station_kind: StationIntervalRow["stationKind"];
  visit: number | null;
  is_rework: boolean;
  status: StationIntervalRow["status"];
  missing_reason: StationIntervalRow["missingReason"];
  start_at: Date;
  end_at: Date | null;
  start_estimated: boolean;
  duration_seconds: number | null;
  duration_working_seconds: number | null;
  allocated_seconds: number | null;
  allocated_working_seconds: number | null;
  wait_before_seconds: number | null;
  wait_before_working_seconds: number | null;
  element_type_id: string | null;
  local_day: string;
  in_scan_id: string | null;
  out_scan_id: string | null;
}

function toIntervalRow(r: IntervalDbRow): StationIntervalRow {
  return {
    intervalId: r.interval_id,
    orderNo: r.order_no,
    barcode: r.barcode,
    stationNo: r.station_no,
    station: r.station,
    stationKind: r.station_kind,
    visit: r.visit,
    isRework: r.is_rework,
    status: r.status,
    missingReason: r.missing_reason,
    startAt: iso(r.start_at),
    endAt: isoOrNull(r.end_at),
    startEstimated: r.start_estimated,
    durationSeconds: r.duration_seconds,
    durationWorkingSeconds: r.duration_working_seconds,
    allocatedSeconds: r.allocated_seconds,
    allocatedWorkingSeconds: r.allocated_working_seconds,
    waitBeforeSeconds: r.wait_before_seconds,
    waitBeforeWorkingSeconds: r.wait_before_working_seconds,
    elementTypeId: r.element_type_id,
    localDay: r.local_day,
    inScanId: r.in_scan_id,
    outScanId: r.out_scan_id,
  };
}

/**
 * Cuts a list of station days into stretches of at most DAY_WINDOW days, so
 * each can be read with one query. Sorted by day.
 */
export function dayWindows(days: StationDay[]): StationDay[][] {
  const sorted = [...days].sort((a, b) => a.localDay.localeCompare(b.localDay) || a.stationNo - b.stationNo);
  const windows: StationDay[][] = [];
  let limit = "";
  for (const day of sorted) {
    if (windows.length === 0 || day.localDay > limit) {
      windows.push([]);
      limit = addDays(day.localDay, DAY_WINDOW - 1);
    }
    windows[windows.length - 1].push(day);
  }
  return windows;
}

/**
 * Recomputes the given station days, which must lie within one window. One
 * read of the passes that touch the stretch, then per station day the rows
 * that touch that day go to deriveStationDay: a row is upserted, or deleted
 * when nothing touches the day any more. The caller holds the writer lock.
 */
export async function replaceStationDays(
  db: Db,
  days: StationDay[],
  config: ReadModelConfig,
  now: number
): Promise<number> {
  if (days.length === 0) return 0;
  const first = days.reduce((min, d) => (d.localDay < min ? d.localDay : min), days[0].localDay);
  const last = days.reduce((max, d) => (d.localDay > max ? d.localDay : max), days[0].localDay);
  const stations = [...new Set(days.map((d) => d.stationNo))];

  // A pass with no end touches a day only while it is open (to now), or on
  // the day it started (a missing scan-out).
  const rows = await db.query<IntervalDbRow>(
    `select interval_id, order_no, barcode, station_no, station, station_kind, visit, is_rework,
            status, missing_reason, start_at, end_at, start_estimated, duration_seconds,
            duration_working_seconds, allocated_seconds, allocated_working_seconds,
            wait_before_seconds, wait_before_working_seconds,
            element_type_id, local_day, in_scan_id, out_scan_id
       from core.station_intervals
      where station_no = any($1::int[])
        and start_at < $3::timestamptz
        and (end_at >= $2::timestamptz or (end_at is null and (status = 'open' or start_at >= $2::timestamptz)))
      order by start_at, interval_id`,
    [stations, new Date(dayStart(first)).toISOString(), new Date(dayEnd(last)).toISOString()]
  );
  const byStation = new Map<number, { row: StationIntervalRow; start: number; end: number | null }[]>();
  for (const r of rows) {
    const entry = { row: toIntervalRow(r), start: r.start_at.getTime(), end: r.end_at?.getTime() ?? null };
    const list = byStation.get(r.station_no);
    if (list) list.push(entry);
    else byStation.set(r.station_no, [entry]);
  }
  const moved = await splitPasses(db, [...byStation.values()].flat(), config, now);

  const facts: StationDayFactsRow[] = [];
  const gone: { station_no: number; local_day: string }[] = [];
  for (const day of days) {
    const from = dayStart(day.localDay);
    const to = dayEnd(day.localDay);
    const touching = (byStation.get(day.stationNo) ?? [])
      .filter((e) => e.start < to && (e.end != null ? e.end >= from : e.row.status === "open" || e.start >= from))
      .map((e) => e.row);
    const row = deriveStationDay(day.stationNo, day.localDay, touching, {
      now,
      calendar: config.calendar,
      params: config.params,
    });
    if (row) facts.push(row);
    else gone.push({ station_no: day.stationNo, local_day: day.localDay });
  }

  if (facts.length > 0) {
    const columns = Object.keys(facts[0]).map(toSnake);
    const updates = columns
      .filter((c) => c !== "station_no" && c !== "local_day")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    await insertRows(db, "stationDayFacts", facts, ` on conflict (station_no, local_day) do update set ${updates}`);
  }
  if (gone.length > 0) {
    await db.query(
      `delete from core.station_day_facts f
        using jsonb_to_recordset($1::jsonb) as g(station_no integer, local_day date)
        where f.station_no = g.station_no and f.local_day = g.local_day`,
      [JSON.stringify(gone)]
    );
  }

  // A pass's share can change on a day outside these (it ends there, and a
  // pass beside it on these days was added or changed): rebuild that day too,
  // or its time per piece keeps the old share. A second round changes no
  // share, so this ends.
  const asked = new Set(days.map((d) => `${d.stationNo}|${d.localDay}`));
  const extra = moved.filter((d) => !asked.has(`${d.stationNo}|${d.localDay}`));
  let count = days.length;
  for (const window of dayWindows(extra)) count += await replaceStationDays(db, window, config, now);
  return count;
}

/**
 * Split time for these passes (docs/read-model.md §2, Split time): reads every
 * done and open pass at their stations that overlaps them (a pass's share
 * depends on the passes beside it, which may lie outside the days rebuilt),
 * shares each station's time, writes allocated_* where it changed and sets
 * it on the rows handed in, then brings the touch times of the orders
 * concerned in line (refreshTouch). A missing scan-out gets null. Returns the
 * station days (where they count) of the passes whose share changed.
 */
async function splitPasses(
  db: Db,
  entries: { row: StationIntervalRow; start: number; end: number | null }[],
  config: ReadModelConfig,
  now: number
): Promise<StationDay[]> {
  const counted = entries.filter((e) => e.row.status !== "missing_out");
  const shares = new Map<string, { seconds: number; workingSeconds: number }>();
  if (counted.length > 0) {
    const until = (e: { start: number; end: number | null }) => e.end ?? Math.max(e.start, now);
    const from = Math.min(...counted.map((e) => e.start));
    const to = Math.max(...counted.map(until));
    const stations = [...new Set(counted.map((e) => e.row.stationNo))];
    const around = await db.query<{
      interval_id: string;
      station_no: number;
      element_type_id: string | null;
      start_at: Date;
      end_at: Date | null;
    }>(
      `select interval_id, station_no, element_type_id, start_at, end_at
         from core.station_intervals
        where station_no = any($1::int[])
          and status <> 'missing_out'
          and start_at <= $3::timestamptz
          and (end_at >= $2::timestamptz or (end_at is null and status = 'open'))`,
      [stations, new Date(from).toISOString(), new Date(to).toISOString()]
    );
    const perStation = new Map<number, SplitPass[]>();
    for (const r of around) {
      const start = r.start_at.getTime();
      const weight =
        r.element_type_id != null ? (config.split.calculated[r.station_no]?.[r.element_type_id] ?? null) : null;
      const pass: SplitPass = { id: r.interval_id, start, end: r.end_at?.getTime() ?? Math.max(start, now), weight };
      const list = perStation.get(r.station_no);
      if (list) list.push(pass);
      else perStation.set(r.station_no, [pass]);
    }
    for (const list of perStation.values()) {
      for (const [id, share] of splitStationTime(list, config.split.mode, config.calendar)) shares.set(id, share);
    }
  }

  const changes: { interval_id: string; seconds: number | null; working: number | null }[] = [];
  const moved = new Map<string, StationDay>();
  for (const { row } of entries) {
    const share = row.status !== "missing_out" ? shares.get(row.intervalId) : undefined;
    const seconds = share?.seconds ?? null;
    const working = share?.workingSeconds ?? null;
    if (row.allocatedSeconds === seconds && row.allocatedWorkingSeconds === working) continue;
    row.allocatedSeconds = seconds;
    row.allocatedWorkingSeconds = working;
    changes.push({ interval_id: row.intervalId, seconds, working });
    moved.set(`${row.stationNo}|${row.localDay}`, { stationNo: row.stationNo, localDay: row.localDay });
  }
  if (changes.length === 0) return [];
  const changed = await db.query<{ order_no: number }>(
    `update core.station_intervals s
        set allocated_seconds = c.seconds, allocated_working_seconds = c.working
       from jsonb_to_recordset($1::jsonb) as c(interval_id text, seconds integer, working integer)
      where s.interval_id = c.interval_id
      returning s.order_no`,
    [JSON.stringify(changes)]
  );
  await refreshTouch(db, [...new Set(changed.map((r) => r.order_no))], now);
  return [...moved.values()];
}

/**
 * Station days that move with the clock: today for every station with a pass
 * touching it or a row for it, and earlier days whose row was last computed
 * before the day was over.
 */
export async function clockStationDays(db: Db, today: string): Promise<StationDay[]> {
  const rows = await db.query<{ station_no: number; local_day: string }>(
    `select distinct station_no, $1::date as local_day
       from core.station_intervals
      where start_at < $3::timestamptz
        and (end_at >= $2::timestamptz or (end_at is null and (status = 'open' or start_at >= $2::timestamptz)))
     union
     select station_no, local_day from core.station_day_facts
      where local_day = $1::date or (local_day < $1::date and not is_complete)`,
    [today, new Date(dayStart(today)).toISOString(), new Date(dayEnd(today)).toISOString()]
  );
  return rows.map((r) => ({ stationNo: r.station_no, localDay: r.local_day }));
}

// ---------------------------------------------------------------------------
// app.sync_state
// ---------------------------------------------------------------------------

export interface StateRow {
  lastSuccessAt?: number | null;
  lastError: string | null;
  rowsTotal?: number | null;
  detail: Record<string, unknown>;
}

/** Upserts one of the writer's own rows in app.sync_state. Rows of lib/sync are never touched. */
export async function saveState(db: Db, name: string, now: number, row: StateRow): Promise<void> {
  await db.query(
    `insert into app.sync_state as s (name, last_run_at, last_success_at, last_error, rows_total, detail)
     values ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6::jsonb)
     on conflict (name) do update set
       last_run_at = excluded.last_run_at,
       last_success_at = coalesce(excluded.last_success_at, s.last_success_at),
       last_error = excluded.last_error,
       rows_total = coalesce(excluded.rows_total, s.rows_total),
       detail = excluded.detail`,
    [
      name,
      new Date(now).toISOString(),
      row.lastSuccessAt != null ? new Date(row.lastSuccessAt).toISOString() : null,
      row.lastError,
      row.rowsTotal ?? null,
      JSON.stringify(row.detail),
    ]
  );
}

export async function readStateDetail(db: Db, name: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query<{ detail: Record<string, unknown> | null }>(
    "select detail from app.sync_state where name = $1",
    [name]
  );
  return rows[0]?.detail ?? null;
}
