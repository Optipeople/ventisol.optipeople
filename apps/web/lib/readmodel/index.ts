// The read model writer: keeps core.* in step with raw.*.
//
// lib/sync calls these after its own transaction has committed. Each function
// opens its own service transactions (withService cannot be nested), so never
// call them from inside withUser or withService.
//
// The recipe is docs/read-model.md §9. How it is cut into transactions:
//
//   - Orders are replaced a chunk at a time: one transaction reads the chunk's
//     whole scan history and its documents, derives, deletes the chunk's rows
//     from core.orders (cascades) and inserts the new ones. Readers see the
//     old rows or the new ones, never a gap, and core.* is never emptied.
//   - Orders that can hold an open In (scanned within staleOpenSeconds, 36
//     hours) are always derived together in one transaction, so "one element
//     per station" sees every open In. All other orders are independent of
//     each other and go in chunks of ORDER_CHUNK.
//   - Station days are recomputed after the orders, a stretch of at most 31
//     days per transaction.
//   - Every writing transaction takes one advisory lock (lockWriter), so a
//     rebuild and the minute sync can run at the same time.
//
// Progress and the last error are in app.sync_state under "readmodel" (the
// incremental runs) and "readmodel_rebuild" (rebuildAll).

import { withService, type Db } from "@/lib/db";
import {
  affectedBy,
  mergeStationDays,
  needsClockRefresh,
  type StationDay,
  type TypicalTimes,
} from "@/lib/derive";
import type { Scan } from "@/lib/scans";
import { addDays, dayKey, MS_PER_DAY } from "@/lib/time";
import { DERIVE_TIME_SETTINGS, loadConfig, loadTypical, type ReadModelConfig } from "./config";
import {
  clockStationDays,
  dayWindows,
  ensureStations,
  lockWriter,
  readStateDetail,
  replaceOrders,
  replaceStationDays,
  saveState,
} from "./write";

export { DERIVE_TIME_SETTINGS, TYPICAL_WINDOW_DAYS } from "./config";
export { orderInfoFromDocument, rulesFromConfig, type SeenElement } from "./orderinfo";

/** One scan that was inserted or changed in raw.scans by a sync run. */
export interface ChangedScan {
  scanId: string;
  orderNo: number;
  stationNo: number | null;
  barcode: string;
  /** Scan time, epoch milliseconds (UTC). */
  scanTime: number;
}

export interface ApplyResult {
  /** Orders whose derived rows were recomputed. */
  orders: number;
  /** (station, day) pairs whose facts were recomputed. */
  stationDays: number;
}

export interface RebuildResult extends ApplyResult {
  /** False when the time budget ran out: call rebuildAll (or continueRebuild) again to go on. */
  complete: boolean;
}

export interface RebuildOptions {
  /** Start from the beginning even when an earlier rebuild was left unfinished. */
  restart?: boolean;
  /** Orders per transaction. Default ORDER_CHUNK. */
  chunkSize?: number;
  /** Stop after this many milliseconds and leave the rest for the next call. Default: no limit. */
  budgetMs?: number;
  /** Called between two transactions, with what is done so far. For progress, and for tests. */
  onChunk?: (progress: { phase: "orders" | "days"; orders: number; stationDays: number }) => void | Promise<void>;
}

/**
 * Orders per transaction. Measured on PGlite with the fixture history (363
 * orders, 29 300 scans, 80 scans an order): rebuildAll takes about 3 seconds,
 * about 8 ms an order, so a chunk of 150 is a little over a second. A chunk
 * is eleven statements whatever its size (four reads, one delete, four
 * multi-row inserts, the lock, the progress row), so on the hosted database
 * (5 to 20 ms a round trip) the round trips add 0.1 to 0.3 seconds a chunk.
 * One incremental run with a handful of scans: 60 to 100 ms on PGlite, about
 * 35 statements in six transactions.
 */
export const ORDER_CHUNK = 150;

/** The writer's rows in app.sync_state. */
export const READMODEL_STATE = "readmodel";
export const REBUILD_STATE = "readmodel_rebuild";

/** An unfinished rebuild older than this is not resumed: it starts over. */
const RESUME_MAX_AGE_MS = 24 * 3_600_000;

const uniqueSorted = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}

/** Orders with a scan inside the stale window: the only ones that can hold an open In. */
async function liveOrders(db: Db, now: number, staleOpenSeconds: number): Promise<number[]> {
  const rows = await db.query<{ order_no: number }>(
    "select distinct order_no from raw.scans where scan_time > $1::timestamptz and order_no is not null",
    [new Date(now - staleOpenSeconds * 1000).toISOString()]
  );
  return rows.map((r) => r.order_no);
}

/**
 * Orders whose rows move with the clock: the ones in progress
 * (needsClockRefresh in lib/derive), and any order, packed or not, with a
 * pass that has gone stale since the order was last computed. An open In
 * turns into a missing scan-out after staleOpenSeconds, and one that was
 * superseded by another station's In is then called stale (pairHistory).
 */
async function clockOrders(db: Db, now: number, staleOpenSeconds: number): Promise<number[]> {
  const rows = await db.query<{ order_no: number; last_scan_at: Date }>(
    `select order_no, last_scan_at from core.orders
      where status = 'in_progress' and last_scan_at >= $1::timestamptz`,
    [new Date(now - 15 * MS_PER_DAY).toISOString()]
  );
  const stale = await db.query<{ order_no: number }>(
    `select distinct i.order_no
       from core.station_intervals i
       join core.orders o on o.order_no = i.order_no
      where i.status <> 'done'
        and i.start_at < $1::timestamptz
        and (i.status = 'open'
             or (i.missing_reason = 'superseded' and o.computed_at <= i.start_at + make_interval(secs => $2::int)))`,
    [new Date(now - staleOpenSeconds * 1000).toISOString(), staleOpenSeconds]
  );
  return uniqueSorted([
    ...rows
      .filter((r) => needsClockRefresh({ status: "in_progress", lastScanAt: r.last_scan_at.toISOString() }, now))
      .map((r) => r.order_no),
    ...stale.map((r) => r.order_no),
  ]);
}

interface Tally {
  orders: number;
  days: StationDay[];
}

/**
 * Replaces these orders. A set that fits one chunk goes in one transaction.
 * A larger one: the orders outside the stale window in chunks, then the ones
 * inside it together.
 */
async function rebuildOrders(
  orderNos: number[],
  config: ReadModelConfig,
  now: number,
  chunkSize: number,
  between?: (orders: number) => void | Promise<void>
): Promise<Tally> {
  const tally: Tally = { orders: 0, days: [] };
  const run = async (list: number[]) => {
    if (list.length === 0) return;
    const result = await withService(async (db) => {
      await lockWriter(db);
      return replaceOrders(db, list, config, now);
    });
    tally.orders += result.orders;
    tally.days = mergeStationDays(tally.days, result.days);
    await between?.(tally.orders);
  };

  if (orderNos.length <= chunkSize) {
    await run(orderNos);
    return tally;
  }
  const live = new Set(await withService((db) => liveOrders(db, now, config.params.staleOpenSeconds)));
  for (const chunk of chunks(orderNos.filter((no) => !live.has(no)), chunkSize)) await run(chunk);
  await run(orderNos.filter((no) => live.has(no)));
  return tally;
}

/** Recomputes station days, a stretch of at most 31 days per transaction. */
async function rebuildStationDays(
  days: StationDay[],
  config: ReadModelConfig,
  now: number,
  between?: (window: StationDay[]) => void | Promise<void | boolean>
): Promise<number> {
  let count = 0;
  for (const window of dayWindows(days)) {
    count += await withService(async (db) => {
      await lockWriter(db);
      return replaceStationDays(db, window, config, now);
    });
    if ((await between?.(window)) === false) break;
  }
  return count;
}

const sameTypical = (a: TypicalTimes | null, b: TypicalTimes | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The typical times come from core.station_intervals, which this run may
 * just have changed (a late scan on an earlier day, a rebuild). When they
 * moved, the orders in progress are derived once more so their forecast
 * rests on the final figures. That makes a run repeatable: the same raw data
 * gives the same core.* whatever was there before.
 */
async function settleForecasts(
  config: ReadModelConfig,
  now: number,
  chunkSize: number,
  every: boolean
): Promise<Tally> {
  const next = await withService(async (db) => {
    const typical = await loadTypical(db, now);
    if (sameTypical(typical, config.typical)) return null;
    const orders = every
      ? (await db.query<{ order_no: number }>("select order_no from core.orders where status = 'in_progress'")).map(
          (r) => r.order_no
        )
      : await clockOrders(db, now, config.params.staleOpenSeconds);
    return { typical, orders };
  });
  if (!next) return { orders: 0, days: [] };
  config.typical = next.typical;
  return rebuildOrders(uniqueSorted(next.orders), config, now, chunkSize);
}

async function recordFailure(name: string, now: number, error: unknown, detail: Record<string, unknown>) {
  try {
    await withService((db) =>
      saveState(db, name, now, { lastError: errorText(error), detail: { ...detail, status: "error" } })
    );
  } catch {
    // The state row is bookkeeping: the original error is the one to report.
  }
}

async function apply(
  kind: "scans" | "documents",
  changed: ChangedScan[],
  documentOrders: number[],
  now: number
): Promise<ApplyResult> {
  const started = performance.now();
  try {
    // affectedBy only needs the order, the station and the time of a scan.
    const plan = affectedBy(
      changed.map(
        (c): Scan => ({
          id: c.scanId,
          barcode: c.barcode,
          orderNo: c.orderNo,
          position: null,
          subPosition: null,
          piece: null,
          station: "",
          stationNo: c.stationNo,
          stationKind: "Assembly",
          direction: "In",
          time: c.scanTime,
          durationSec: null,
          device: null,
        })
      )
    );
    const stationNos = uniqueSorted(changed.map((c) => c.stationNo).filter((no): no is number => no != null));

    const { config, refresh } = await withService(async (db) => {
      await ensureStations(db, stationNos);
      const config = await loadConfig(db, now);
      return { config, refresh: await clockOrders(db, now, config.params.staleOpenSeconds) };
    });

    const orderNos = uniqueSorted([...plan.orderNos, ...documentOrders, ...refresh]);
    const first = await rebuildOrders(orderNos, config, now, ORDER_CHUNK);
    const second = await settleForecasts(config, now, ORDER_CHUNK, false);

    const today = dayKey(now);
    const clockDays = await withService((db) => clockStationDays(db, today));
    const stationDays = await rebuildStationDays(
      mergeStationDays(plan.stationDays, first.days, second.days, clockDays),
      config,
      now
    );

    const result: ApplyResult = { orders: orderNos.length, stationDays };
    await withService(async (db) => {
      const total = await db.query<{ n: number }>("select count(*) as n from core.orders");
      await saveState(db, READMODEL_STATE, now, {
        lastSuccessAt: now,
        lastError: null,
        rowsTotal: Number(total[0]?.n ?? 0),
        detail: {
          status: "ok",
          kind,
          changedScans: changed.length,
          changedDocuments: documentOrders.length,
          orders: result.orders,
          stationDays: result.stationDays,
          forecastsSettled: second.orders,
          ms: Math.round(performance.now() - started),
        },
      });
    });
    return result;
  } catch (error) {
    await recordFailure(READMODEL_STATE, now, error, { kind });
    throw error;
  }
}

/**
 * Recompute what new or late scans touch: their orders and station days.
 * Also refreshes what moves with the clock (orders in progress, today's
 * station days), so call it on every sync run, with an empty list when no
 * scan arrived.
 */
export async function applyScanChanges(changed: ChangedScan[], now: number): Promise<ApplyResult> {
  return apply("scans", changed, [], now);
}

/** Recompute orders whose 3E document arrived or changed (customer, delivery week, expected elements, element types). */
export async function applyDocumentChanges(orderNos: number[], now: number): Promise<ApplyResult> {
  return apply("documents", [], uniqueSorted(orderNos), now);
}

interface RebuildProgress {
  status: "running" | "done" | "error";
  startedAt: string;
  phase: "orders" | "days";
  /** Phase orders: the last order number of the last finished chunk. */
  orderCursor: number | null;
  /** Phase days: the last day finished. */
  dayCursor: string | null;
  orders: number;
  stationDays: number;
}

function resumable(detail: Record<string, unknown> | null, now: number): RebuildProgress | null {
  if (!detail || (detail.status !== "running" && detail.status !== "error")) return null;
  if (detail.phase !== "orders" && detail.phase !== "days") return null;
  const startedAt = typeof detail.startedAt === "string" ? Date.parse(detail.startedAt) : NaN;
  if (!Number.isFinite(startedAt) || now - startedAt > RESUME_MAX_AGE_MS || startedAt > now) return null;
  return detail as unknown as RebuildProgress;
}

/**
 * Throw away core.* and build it again from raw.*. Safe to run at any time,
 * also while the minute sync runs: orders are replaced chunk by chunk, each
 * in its own transaction, and nothing is truncated, so readers always see a
 * full core.*. Rows of orders that raw.scans no longer holds are removed, and
 * so are station days nothing touches any more.
 *
 * Resumable: progress is kept in app.sync_state ("readmodel_rebuild"). A call
 * that finds an unfinished rebuild less than a day old goes on where it
 * stopped, unless `restart` is set. With `budgetMs` it stops in time and
 * returns `complete: false`.
 */
export async function rebuildAll(now: number, options: RebuildOptions = {}): Promise<RebuildResult> {
  const chunkSize = options.chunkSize ?? ORDER_CHUNK;
  const deadline = options.budgetMs != null ? performance.now() + options.budgetMs : Infinity;
  const started = performance.now();
  let progress: RebuildProgress = {
    status: "running",
    startedAt: new Date(now).toISOString(),
    phase: "orders",
    orderCursor: null,
    dayCursor: null,
    orders: 0,
    stationDays: 0,
  };
  const result: RebuildResult = { orders: 0, stationDays: 0, complete: false };
  const save = (db: Db) => saveState(db, REBUILD_STATE, now, { lastError: null, detail: { ...progress } });
  const report = () =>
    options.onChunk?.({ phase: progress.phase, orders: progress.orders, stationDays: progress.stationDays });

  try {
    const { config, all, live } = await withService(async (db) => {
      const prior = options.restart ? null : resumable(await readStateDetail(db, REBUILD_STATE), now);
      if (prior) progress = { ...prior, status: "running" };
      await ensureStations(db, null);
      const config = await loadConfig(db, now);
      const all = await db.query<{ order_no: number }>(
        "select distinct order_no from raw.scans where order_no is not null order by order_no"
      );
      const live = await liveOrders(db, now, config.params.staleOpenSeconds);
      await save(db);
      return { config, all: all.map((r) => r.order_no), live: new Set(live) };
    });

    if (progress.phase === "orders") {
      // 1. Every order that cannot hold an open In, by order number, resumable.
      const cursor = progress.orderCursor;
      const rest = all.filter((no) => !live.has(no) && (cursor == null || no > cursor));
      for (const chunk of chunks(rest, chunkSize)) {
        await withService(async (db) => {
          await lockWriter(db);
          const done = await replaceOrders(db, chunk, config, now);
          progress.orders += done.orders;
          progress.orderCursor = chunk[chunk.length - 1];
          await save(db);
        });
        result.orders += chunk.length;
        await report();
        if (performance.now() > deadline) return result;
      }

      // 2. The orders that can: together.
      const liveList = all.filter((no) => live.has(no));
      if (liveList.length > 0) {
        await withService(async (db) => {
          await lockWriter(db);
          await replaceOrders(db, liveList, config, now);
        });
        progress.orders += liveList.length;
        result.orders += liveList.length;
        await report();
      }

      // 3. Orders that raw.scans no longer holds. Checked against raw.scans
      //    itself, not the list read above: an order that arrived since then
      //    must stay.
      await withService(async (db) => {
        await lockWriter(db);
        await db.query(
          `delete from core.orders o
            where not exists (select 1 from raw.scans s where s.order_no = o.order_no)`
        );
      });

      // 4. The forecasts, on the typical times of the rebuilt history.
      await settleForecasts(config, now, chunkSize, true);

      progress.phase = "days";
      progress.dayCursor = null;
      await withService(save);
      await report();
    }

    // 5. Every station day from the first pass (or the first stored row) to today.
    const today = dayKey(now);
    const range = await withService(async (db) => {
      const first = await db.query<{ first_start: Date | null; first_day: string | null }>(
        `select (select min(start_at) from core.station_intervals) as first_start,
                (select min(local_day) from core.station_day_facts) as first_day`
      );
      const stations = await db.query<{ station_no: number }>(
        `select station_no from core.station_intervals
         union
         select station_no from core.station_day_facts
         order by station_no`
      );
      return { ...first[0], stations: stations.map((s) => s.station_no) };
    });
    const candidates = [range.first_start ? dayKey(range.first_start.getTime()) : null, range.first_day].filter(
      (d): d is string => d != null
    );
    const days: StationDay[] = [];
    if (candidates.length > 0) {
      let day = candidates.sort()[0];
      if (progress.dayCursor != null && progress.dayCursor >= day) day = addDays(progress.dayCursor, 1);
      for (; day <= today; day = addDays(day, 1)) {
        for (const stationNo of range.stations) days.push({ stationNo, localDay: day });
      }
    }
    let stopped = false;
    await rebuildStationDays(days, config, now, async (window) => {
      progress.dayCursor = window[window.length - 1].localDay;
      progress.stationDays += window.length;
      result.stationDays += window.length;
      await withService(save);
      await report();
      stopped = performance.now() > deadline && progress.dayCursor < today;
      return !stopped;
    });
    if (stopped) return result;

    progress.status = "done";
    await withService(async (db) => {
      const total = await db.query<{ n: number }>("select count(*) as n from core.orders");
      await saveState(db, REBUILD_STATE, now, {
        lastSuccessAt: now,
        lastError: null,
        rowsTotal: Number(total[0]?.n ?? 0),
        detail: { ...progress, ms: Math.round(performance.now() - started) },
      });
    });
    result.complete = true;
    return result;
  } catch (error) {
    await recordFailure(REBUILD_STATE, now, error, { ...progress });
    throw error;
  }
}

/**
 * Goes on with a rebuild that was left unfinished (a time budget ran out, or
 * the process died). Does nothing when there is none. For the cron run.
 */
export async function continueRebuild(now: number, options: Omit<RebuildOptions, "restart"> = {}): Promise<RebuildResult> {
  const pending = await withService(async (db) => resumable(await readStateDetail(db, REBUILD_STATE), now));
  if (!pending) return { orders: 0, stationDays: 0, complete: true };
  return rebuildAll(now, options);
}

// ---------------------------------------------------------------------------
// When configuration changes
// ---------------------------------------------------------------------------

/**
 * Call after a commit that changed config.calendar_shifts or
 * config.calendar_closed_days. Every *_working_seconds column, the station
 * days' shift figures and the forecasts rest on the calendar, so everything
 * is rebuilt, from the start.
 */
export function onCalendarChanged(now: number, options: Omit<RebuildOptions, "restart"> = {}): Promise<RebuildResult> {
  return rebuildAll(now, { ...options, restart: true });
}

/**
 * Call after a commit that changed rows of config.settings, with the keys
 * that changed. Only the keys in DERIVE_TIME_SETTINGS are stored in core.*
 * and need a rebuild. Every other key (deduct_off_shift and the thresholds)
 * is applied when a report is read: nothing is done for them.
 */
export async function onSettingsChanged(
  keys: string[],
  now: number,
  options: Omit<RebuildOptions, "restart"> = {}
): Promise<RebuildResult> {
  const stored: readonly string[] = DERIVE_TIME_SETTINGS;
  if (!keys.some((key) => stored.includes(key))) return { orders: 0, stationDays: 0, complete: true };
  return rebuildAll(now, { ...options, restart: true });
}

/**
 * Call after a commit that changed config.element_types (a recognition rule,
 * the sort order, active). The element type of every element of an order
 * with a document is worked out again.
 */
export async function onElementTypesChanged(now: number): Promise<ApplyResult> {
  const orders = await withService((db) =>
    db.query<{ order_no: number }>(
      `select distinct d.order_no from raw.order_documents d
        where d.order_no is not null and jsonb_typeof(d.parsed) = 'object'
          and exists (select 1 from core.orders o where o.order_no = d.order_no)`
    )
  );
  return applyDocumentChanges(orders.map((o) => o.order_no), now);
}
