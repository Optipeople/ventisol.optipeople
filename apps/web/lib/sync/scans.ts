// Scan sync: copies new rows of the OptiCloud list VentisolScans into
// raw.scans, and tells the read model writer exactly which rows are new or
// changed.
//
// GetRowsPaged has no date filter and no "changed since". Pages are asked for
// newest scan time first.
//
// THE STOP RULE
//
// Reading goes on, page after page, until the first page that
//   (a) brought nothing new and nothing changed, and
//   (b) lies wholly below the floor: its newest scan is older than
//       min(newest stored scan time, now) minus a margin.
// The margin is 10 minutes on an ordinary run. Every 5 minutes a run is
// "deep": its floor is at least 36 hours back.
//
// Why both halves. A station that was offline sends its scans late, with the
// time they were scanned, so they land deep in the list, not on page 1. Time
// order alone would never look there. (b) makes every run read back over the
// stretch where late rows usually land, even when page 1 holds nothing new.
// (a) makes a run that is still finding rows keep going past the floor: a
// station that sends two days of scans at once, or a portal that was down for
// hours, is read to the end of what is new, not to the margin.
// What neither catches, a single late scan older than 36 hours between pages
// of known rows, the nightly reconcile finds (reconcile.ts, 45 days).
//
// IF THE API IGNORES THE ORDERING
//
// Whether GetRowsPaged honours Orderby on a value column is not confirmed
// (docs/opticloud-scans.md, "Open with the backend owner"). The rows are
// watched as lib/paging.ts watches them: more rows newer than the row before
// them than a stray or two means the order is not ours. The list then lies in
// the order the rows were stored, newest last, so the run reads from the last
// page backwards and stops at the first page that brought nothing new (after
// two pages at least: the last page may be nearly empty). Late scans are
// stored last, so this finds them too. Without a page count every page is
// read.
//
// LIMITS
//
// A run reads at most `maxPages` pages and stops at `deadline`. What is left
// (a first sync of a list of months, a long outage) is handed to the
// reconcile cursor (reconcile.ts), which the next runs continue: the walk
// resumes one page before where it stopped, since new rows only push old ones
// to later pages.
//
// Writing is one statement per page (jsonb_to_recordset), idempotent by
// scan_id. A stored row whose values differ is updated and counts as changed.
// A row edited in OptiCloud to another order is queued twice: for the new
// order and for the one it left, which would otherwise keep the old pass.
// Each page is its own short transaction, and in that same transaction the
// new and changed rows are queued for the read model writer
// (app.sync_private, "pending:scans"); the queue is emptied by
// applyScanChanges after the commit. So a run that dies between the two
// loses nothing: the next run hands the rest over.

import { withService, type Db } from "@/lib/db";
import { INVERSIONS_ALLOWED } from "@/lib/paging";
import { applyScanChanges, type ApplyResult, type ChangedScan } from "@/lib/readmodel";
import {
  getValue,
  parseBarcode,
  parseScanTime,
  SCAN_TABLE_NAME,
  type MasterDataRow,
} from "@/lib/scans";
import {
  getOptiCloud,
  ServiceLoginError,
  ServiceUnavailableError,
  type OptiCloudSource,
  type ServiceAccess,
  type SourcePage,
} from "./opticloud-service";
import { handOver } from "./handover";
import {
  appendPending,
  dropPending,
  errorText,
  JOBS,
  PRIVATE,
  readPending,
  readState,
  writeState,
  type Detail,
  type JobName,
  type JobStatus,
} from "./state";

/** The floor of an ordinary run lies this far below the newest stored scan. */
export const SCAN_MARGIN_MS = 10 * 60_000;
/** The floor of a deep run lies at least this far back from now. */
export const DEEP_WINDOW_MS = 36 * 3_600_000;
/** A run is deep when the last deep run is this old. */
export const DEEP_INTERVAL_MS = 5 * 60_000;
/** Pages one sync run reads at most (500 rows each). */
export const SCAN_MAX_PAGES = 60;
/** The read model writer is called after this many queued rows, and at the end. */
export const APPLY_EVERY_ROWS = 10_000;

const INT_MAX = 2_147_483_647;

// --- one OptiCloud row to one raw.scans row ---

/** A row of raw.scans as it is sent to the database (timestamps as ISO text). */
export interface RawScan {
  scan_id: string;
  barcode: string | null;
  order_no: number | null;
  position: number | null;
  sub_position: number | null;
  piece: number | null;
  station: string | null;
  station_no: number | null;
  station_kind: string | null;
  machine_id: string | null;
  direction: "In" | "Out" | "Mark" | null;
  scan_time: string | null;
  duration_sec: number | null;
  device: string | null;
  row_id: string | null;
  created_date: string | null;
  /** The Event column as OptiCloud holds it (null when empty: an ordinary scan). */
  event: string | null;
}

export function asText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** A whole number that fits an integer column, else null. */
export function asInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  const whole = Math.trunc(n);
  return Math.abs(whole) <= INT_MAX ? whole : null;
}

export function asIsoTime(v: unknown): string | null {
  const ms = parseScanTime(v);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * The mirror of one row: every column as OptiCloud holds it, nothing filled
 * in from elsewhere. The direction is normalised to "In" / "Out" / "Mark" (the
 * column has a check), anything else is null. Null when the row has no id at all.
 */
export function toRawScan(row: MasterDataRow): RawScan | null {
  const v = row.values ?? {};
  const scanId = asText(getValue(v, "ScanId")) ?? asText(row.id);
  if (!scanId) return null;
  const direction = asText(getValue(v, "Direction"))?.toLowerCase();
  return {
    scan_id: scanId,
    barcode: asText(getValue(v, "Barcode")),
    order_no: asInt(getValue(v, "OrderNo")),
    position: asInt(getValue(v, "Position")),
    sub_position: asInt(getValue(v, "SubPosition")),
    piece: asInt(getValue(v, "Piece")),
    station: asText(getValue(v, "Station")),
    station_no: asInt(getValue(v, "StationNo")),
    station_kind: asText(getValue(v, "StationKind")),
    machine_id: asText(getValue(v, "MachineId")),
    direction: direction === "in" ? "In" : direction === "out" ? "Out" : direction === "mark" ? "Mark" : null,
    scan_time: asIsoTime(getValue(v, "ScanTime")),
    duration_sec: asInt(getValue(v, "DurationSec")),
    device: asText(getValue(v, "Device")),
    row_id: asText(row.id),
    created_date: asIsoTime(row.createdDate),
    event: asText(getValue(v, "Event")),
  };
}

/**
 * What the read model writer is told about a row. Null for a row it cannot
 * place: no barcode, no time, or no order (the order falls back to the
 * barcode, as in parseScanRow).
 */
export function toChangedScan(scan: {
  scan_id: string;
  barcode: string | null;
  order_no: number | null;
  station_no: number | null;
  scan_time: string | Date | null;
}): ChangedScan | null {
  if (!scan.barcode || scan.scan_time == null) return null;
  const orderNo = scan.order_no ?? parseBarcode(scan.barcode)?.orderNo ?? null;
  if (orderNo == null) return null;
  return {
    scanId: scan.scan_id,
    orderNo,
    stationNo: scan.station_no,
    barcode: scan.barcode,
    scanTime: new Date(scan.scan_time).getTime(),
  };
}

// --- writing ---

const SCAN_COLUMNS = [
  "scan_id",
  "barcode",
  "order_no",
  "position",
  "sub_position",
  "piece",
  "station",
  "station_no",
  "station_kind",
  "machine_id",
  "direction",
  "scan_time",
  "duration_sec",
  "device",
  "row_id",
  "created_date",
  "event",
] as const;

const quoted = (column: string) => `"${column}"`;
const COLUMN_LIST = SCAN_COLUMNS.map(quoted).join(", ");
const VALUE_COLUMNS = SCAN_COLUMNS.filter((c) => c !== "scan_id");

// One statement for a whole page. The update only happens when a value
// differs, so a row that is the same is not written and not returned.
// xmax = 0 tells an inserted row from an updated one. The CTE "old" reads the
// stored rows before the update (every part of the statement sees the same
// snapshot), so a row that moved to another order also names the order it
// left.
const UPSERT_SQL = `
  with r as (
    select * from jsonb_to_recordset($1::jsonb) as r(
      "scan_id" text, "barcode" text, "order_no" integer, "position" integer,
      "sub_position" integer, "piece" integer, "station" text, "station_no" integer,
      "station_kind" text, "machine_id" text, "direction" text, "scan_time" timestamptz,
      "duration_sec" integer, "device" text, "row_id" text, "created_date" timestamptz, "event" text)
  ),
  old as (
    select o.scan_id, o.barcode, o.order_no, o.station_no, o.scan_time
      from raw.scans o
     where o.scan_id in (select r.scan_id from r)
  ),
  up as (
    insert into raw.scans as s (${COLUMN_LIST}, synced_at)
    select ${SCAN_COLUMNS.map((c) => `r.${quoted(c)}`).join(", ")}, $2::timestamptz
      from r
    on conflict (scan_id) do update set
      ${VALUE_COLUMNS.map((c) => `${quoted(c)} = excluded.${quoted(c)}`).join(", ")},
      synced_at = excluded.synced_at
    where (${VALUE_COLUMNS.map((c) => `s.${quoted(c)}`).join(", ")})
      is distinct from (${VALUE_COLUMNS.map((c) => `excluded.${quoted(c)}`).join(", ")})
    returning s.scan_id, (s.xmax = 0) as inserted
  )
  select up.scan_id, up.inserted,
         old.barcode as old_barcode, old.order_no as old_order_no,
         old.station_no as old_station_no, old.scan_time as old_scan_time
    from up left join old on old.scan_id = up.scan_id`;

/** What a changed row held before this write. */
export interface PreviousScan {
  scan_id: string;
  barcode: string | null;
  order_no: number | null;
  station_no: number | null;
  scan_time: Date | string | null;
}

export interface UpsertResult {
  /** scan_id of the rows that were not stored before. */
  inserted: string[];
  /** scan_id of the stored rows whose values differed. */
  changed: string[];
  /** The changed rows as they were before, by scan_id. */
  previous: Map<string, PreviousScan>;
}

/**
 * Stores a batch of scans idempotently by scan_id: one statement. The batch
 * may hold the same scan_id twice (a row that moved between two pages): the
 * last one wins.
 */
export async function upsertScans(db: Db, scans: RawScan[], now: number): Promise<UpsertResult> {
  const byId = new Map<string, RawScan>();
  for (const scan of scans) byId.set(scan.scan_id, scan);
  if (byId.size === 0) return { inserted: [], changed: [], previous: new Map() };
  const rows = await db.query<{
    scan_id: string;
    inserted: boolean;
    old_barcode: string | null;
    old_order_no: number | null;
    old_station_no: number | null;
    old_scan_time: Date | string | null;
  }>(UPSERT_SQL, [JSON.stringify([...byId.values()]), new Date(now).toISOString()]);
  const previous = new Map<string, PreviousScan>();
  for (const r of rows) {
    if (r.inserted) continue;
    previous.set(r.scan_id, {
      scan_id: r.scan_id,
      barcode: r.old_barcode,
      order_no: r.old_order_no,
      station_no: r.old_station_no,
      scan_time: r.old_scan_time,
    });
  }
  return {
    inserted: rows.filter((r) => r.inserted).map((r) => r.scan_id),
    changed: rows.filter((r) => !r.inserted).map((r) => r.scan_id),
    previous,
  };
}

/**
 * What to queue for one new or changed row: the row as it is now, and, when
 * it was moved to another order, the row as it was, so the writer derives
 * the old order again (and removes it when it has no scans left).
 */
export function changesOf(scan: RawScan, previous: PreviousScan | undefined): {
  queue: ChangedScan[];
  unplaceable: boolean;
} {
  const now = toChangedScan(scan);
  const queue = now ? [now] : [];
  const before = previous ? toChangedScan(previous) : null;
  if (before && before.orderNo !== now?.orderNo) queue.push(before);
  return { queue, unplaceable: now === null };
}

// --- the read model queue ---

/**
 * Hands everything queued in "pending:scans" to applyScanChanges and takes
 * it off the queue once the writer has returned. An order the writer keeps
 * failing on is set aside (handover.ts) and the rest goes on; the queue is
 * only kept when the writer fails as a whole. Null when nothing was queued
 * (the writer is then not called). Opens its own transactions.
 */
export async function flushScanChanges(now: number): Promise<ApplyResult | null> {
  const pending = await withService((db) => readPending<ChangedScan>(db, PRIVATE.pendingScans));
  if (pending.length === 0) return null;
  // The same entry queued twice goes once. A scan moved to another order has
  // two entries, one per order, and both stay.
  const unique = new Map<string, ChangedScan>();
  for (const scan of pending) {
    unique.set(JSON.stringify([scan.scanId, scan.orderNo, scan.stationNo, scan.scanTime]), scan);
  }
  const result = await handOver({
    source: "scans",
    items: [...unique.values()],
    orderOf: (scan) => scan.orderNo,
    apply: (items) => applyScanChanges(items, now),
    now,
  });
  await withService((db) => dropPending(db, PRIVATE.pendingScans, pending.length));
  return result;
}

// --- taking pages ---

export interface PageOutcome {
  /** Rows of this page that were new or changed. */
  fresh: number;
  /** Newest and oldest scan time on the page, null when no row had a time. */
  maxTime: number | null;
  minTime: number | null;
}

/**
 * Takes pages of scans: stores them, queues what changed, and keeps count.
 * One per run. Shared by the sync and the reconcile.
 */
export class ScanIntake {
  rowsRead = 0;
  inserted = 0;
  changed = 0;
  /** Rows the read model writer cannot place (no barcode, time or order). Stored all the same. */
  unplaceable = 0;
  /** Set once the rows are seen not to come newest first. */
  unordered = false;
  /** Every scan_id seen, when asked for (the reconcile needs it). */
  readonly seen: Set<string> | null;

  private parsed = 0;
  private inversions = 0;
  private previousTime = Number.POSITIVE_INFINITY;
  private queued = 0;
  private applied: ApplyResult = { orders: 0, stationDays: 0 };

  constructor(
    private readonly now: number,
    options: { trackSeen?: boolean } = {}
  ) {
    this.seen = options.trackSeen ? new Set() : null;
  }

  /** Stores one page. `watchOrder` is off for pages read out of sequence. */
  async take(rows: MasterDataRow[], watchOrder = true): Promise<PageOutcome> {
    const scans: RawScan[] = [];
    let maxTime: number | null = null;
    let minTime: number | null = null;
    for (const row of rows) {
      const scan = toRawScan(row);
      if (!scan) continue;
      scans.push(scan);
      this.rowsRead++;
      if (this.seen) {
        // A row seen before in this run moved between pages: not out of order.
        if (this.seen.has(scan.scan_id)) continue;
        this.seen.add(scan.scan_id);
      }
      if (scan.scan_time == null) continue;
      const time = Date.parse(scan.scan_time);
      maxTime = maxTime == null ? time : Math.max(maxTime, time);
      minTime = minTime == null ? time : Math.min(minTime, time);
      if (watchOrder) {
        this.parsed++;
        if (time > this.previousTime) this.inversions++;
        this.previousTime = time;
      }
    }
    if (watchOrder && this.inversions > INVERSIONS_ALLOWED + Math.floor(this.parsed / 100)) {
      this.unordered = true;
    }

    const byId = new Map(scans.map((s) => [s.scan_id, s]));
    const fresh = await withService(async (db) => {
      const result = await upsertScans(db, scans, this.now);
      const queue: ChangedScan[] = [];
      for (const id of [...result.inserted, ...result.changed]) {
        const changes = changesOf(byId.get(id)!, result.previous.get(id));
        queue.push(...changes.queue);
        if (changes.unplaceable) this.unplaceable++;
      }
      await appendPending(db, PRIVATE.pendingScans, queue);
      this.inserted += result.inserted.length;
      this.changed += result.changed.length;
      this.queued += queue.length;
      return result.inserted.length + result.changed.length;
    });

    if (this.queued >= APPLY_EVERY_ROWS) await this.flush();
    return { fresh, maxTime, minTime };
  }

  /** Hands what is queued to the read model writer. */
  async flush(): Promise<void> {
    this.queued = 0;
    const result = await flushScanChanges(this.now);
    if (result) {
      this.applied = {
        orders: this.applied.orders + result.orders,
        stationDays: this.applied.stationDays + result.stationDays,
      };
    }
  }

  get appliedTotals(): ApplyResult {
    return this.applied;
  }
}

// --- walking pages ---

export interface WalkOptions {
  load: (page: number) => Promise<SourcePage>;
  startPage: number;
  /** Pages this walk may read. */
  maxPages: number;
  /** Date.now() after which no further page is asked for. */
  deadline: number;
  /** Pages asked for at once. They are still taken in page order. */
  concurrency?: number;
  /** Takes one page. "stop" ends the walk. */
  onPage: (page: number, rows: MasterDataRow[]) => Promise<"continue" | "stop">;
}

export interface WalkResult {
  pagesRead: number;
  /**
   * "stop": onPage said so. "end": the list has no more pages. "budget":
   * maxPages or the deadline was reached with pages left.
   */
  reason: "stop" | "end" | "budget";
  /** The first page not taken. Only meaningful for "budget". */
  nextPage: number;
  /** Total pages, when the API said. */
  totalPage: number | null;
}

/** Reads pages in rising order from `startPage` until onPage stops it, the list ends, or the budget is spent. */
export async function walkPages(options: WalkOptions): Promise<WalkResult> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  let page = options.startPage;
  let pagesRead = 0;
  let total: number | null = null;
  // Without a page count, a page shorter than the fullest seen is the last.
  let fullPage = 0;

  for (;;) {
    if (pagesRead >= options.maxPages || Date.now() >= options.deadline) {
      return { pagesRead, reason: "budget", nextPage: page, totalPage: total };
    }
    // The first read is alone: it says how many pages there are.
    const room = Math.min(options.maxPages - pagesRead, total == null ? 1 : total - page + 1);
    const wanted = pagesRead === 0 ? 1 : Math.max(1, Math.min(concurrency, room));
    const numbers = Array.from({ length: wanted }, (_, i) => page + i);
    const loaded = await Promise.all(numbers.map((n) => options.load(n)));

    for (let i = 0; i < loaded.length; i++) {
      const { rows, totalPage } = loaded[i];
      // The list may have grown while it was read.
      if (totalPage != null && (total == null || totalPage > total)) total = totalPage;
      if (rows.length === 0) return { pagesRead, reason: "end", nextPage: page, totalPage: total };
      pagesRead++;
      page = numbers[i] + 1;
      const verdict = await options.onPage(numbers[i], rows);
      if (verdict === "stop") return { pagesRead, reason: "stop", nextPage: page, totalPage: total };
      if (total != null ? numbers[i] >= total : rows.length < fullPage) {
        return { pagesRead, reason: "end", nextPage: page, totalPage: total };
      }
      fullPage = Math.max(fullPage, rows.length);
    }
  }
}

/** A page loader for the scan list, newest scan time first. */
export function scanPageLoader(source: OptiCloudSource, tableId: string) {
  return (page: number) => source.loadRowsPage(tableId, page, { orderBy: "ScanTime", ascending: false });
}

// --- job bookkeeping shared with the other jobs ---

/** How a failure is filed: by what the service client threw. */
export function failureStatus(err: unknown): JobStatus {
  if (err instanceof ServiceLoginError) return "login_backoff";
  if (err instanceof ServiceUnavailableError) return "unavailable";
  return "error";
}

/**
 * Files "there is no OptiCloud to read right now" on a job row. Not
 * configured is a normal state and leaves no error.
 */
export async function recordNoAccess(
  job: JobName,
  access: Exclude<ServiceAccess, { status: "ok" }>,
  now: number
): Promise<void> {
  const detail: Detail = { status: access.status, configured: access.status !== "not_configured" };
  let lastError: string | null = null;
  if (access.status === "not_configured") {
    detail.missingEnv = access.missing;
  } else if (access.status === "login_backoff") {
    detail.retryAt = new Date(access.retryAt).toISOString();
    lastError = `OptiCloud rejected the service login. Next try at ${detail.retryAt}.`;
  } else {
    lastError = access.message;
  }
  await withService((db) => writeState(db, job, { lastRunAt: now, lastError, detail }));
}

// --- the sync run ---

export interface ScanSyncOptions {
  now: number;
  /** Resolved by the caller when several jobs share one login. */
  access?: ServiceAccess;
  /** Force a deep run (floor 36 hours back) or an ordinary one. Default: deep every 5 minutes. */
  deep?: boolean;
  maxPages?: number;
  /** Date.now() after which no further page is asked for. */
  deadline?: number;
}

export interface ScanSyncResult {
  status: JobStatus;
  pagesRead: number;
  rowsRead: number;
  inserted: number;
  changed: number;
  deep: boolean;
  unordered: boolean;
  /** The run ended on its page or time limit; the rest was handed to the reconcile cursor. */
  truncated: boolean;
  durationMs: number;
  error?: string;
}

/** What the reconcile cursor needs to take over an unfinished read. See reconcile.ts. */
export interface HandOver {
  mode: "window" | "full";
  /** Window mode: read back to this time (epoch ms). */
  since: number | null;
  nextPage: number;
}

async function storedExtent(db: Db): Promise<{ newest: number | null; count: number }> {
  const rows = await db.query<{ newest: Date | string | null; count: number }>(
    "select max(scan_time) as newest, count(*) as count from raw.scans"
  );
  const newest = rows[0]?.newest;
  return { newest: newest == null ? null : new Date(newest).getTime(), count: Number(rows[0]?.count ?? 0) };
}

/** One scan sync run. Never throws: how it went is in the result and in app.sync_state ("scans"). */
export async function runScanSync(options: ScanSyncOptions): Promise<ScanSyncResult> {
  const { now } = options;
  const started = Date.now();
  const result: ScanSyncResult = {
    status: "ok",
    pagesRead: 0,
    rowsRead: 0,
    inserted: 0,
    changed: 0,
    deep: false,
    unordered: false,
    truncated: false,
    durationMs: 0,
  };
  const done = () => ({ ...result, durationMs: Date.now() - started });

  const access = options.access ?? (await getOptiCloud(now));
  if (access.status !== "ok") {
    await recordNoAccess(JOBS.scans, access, now);
    result.status = access.status;
    return done();
  }
  const source = access.source;
  const intake = new ScanIntake(now);
  let handOver: HandOver | null = null;
  let failure: unknown = null;
  let deepDone = false;

  try {
    const tableId = await source.findTableId(SCAN_TABLE_NAME);
    if (!tableId) {
      // The station app makes the list at its first connect.
      await withService((db) =>
        writeState(db, JOBS.scans, {
          lastRunAt: now,
          lastError: null,
          detail: { status: "no_table", configured: true },
        })
      );
      result.status = "no_table";
      return done();
    }

    const before = await withService(async (db) => ({
      extent: await storedExtent(db),
      state: await readState(db, JOBS.scans),
    }));
    const lastDeep = Date.parse(String(before.state?.detail.lastDeepAt ?? ""));
    result.deep = options.deep ?? (Number.isNaN(lastDeep) || now - lastDeep >= DEEP_INTERVAL_MS);
    const newest = before.extent.newest;
    // Nothing stored: no floor, everything is read.
    const floor =
      newest == null
        ? Number.NEGATIVE_INFINITY
        : Math.min(Math.min(newest, now) - SCAN_MARGIN_MS, result.deep ? now - DEEP_WINDOW_MS : Infinity);

    const maxPages = options.maxPages ?? SCAN_MAX_PAGES;
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const load = scanPageLoader(source, tableId);

    const walk = await walkPages({
      load,
      startPage: 1,
      maxPages,
      deadline,
      onPage: async (_page, rows) => {
        const page = await intake.take(rows);
        if (intake.unordered) return "stop";
        // The stop rule, see the header.
        return page.fresh === 0 && page.maxTime != null && page.maxTime < floor ? "stop" : "continue";
      },
    });
    result.pagesRead = walk.pagesRead;

    if (!intake.unordered) {
      deepDone = result.deep && walk.reason !== "budget";
      if (walk.reason === "budget") {
        result.truncated = true;
        handOver =
          newest == null
            ? { mode: "full", since: null, nextPage: walk.nextPage }
            : { mode: "window", since: floor, nextPage: walk.nextPage };
      }
    } else if (walk.totalPage != null) {
      // Stored order, newest last: from the last page backwards.
      let read = 0;
      for (let page = walk.totalPage; page > walk.pagesRead; page--) {
        if (result.pagesRead >= maxPages || Date.now() >= deadline) {
          result.truncated = true;
          handOver = { mode: "full", since: null, nextPage: walk.pagesRead + 1 };
          break;
        }
        const { rows } = await load(page);
        result.pagesRead++;
        read++;
        const outcome = await intake.take(rows, false);
        if (outcome.fresh === 0 && read >= 2) break;
      }
    } else {
      // No order and no page count: every page.
      const rest = await walkPages({
        load,
        startPage: walk.nextPage,
        maxPages: Math.max(0, maxPages - walk.pagesRead),
        deadline,
        onPage: async (_page, rows) => {
          await intake.take(rows, false);
          return "continue";
        },
      });
      result.pagesRead += rest.pagesRead;
      if (rest.reason === "budget") {
        result.truncated = true;
        handOver = { mode: "full", since: null, nextPage: rest.nextPage };
      }
    }
  } catch (err) {
    failure = err;
  }

  // What was stored is handed over even when a later page failed.
  try {
    await intake.flush();
  } catch (err) {
    failure ??= err;
  }

  result.rowsRead = intake.rowsRead;
  result.inserted = intake.inserted;
  result.changed = intake.changed;
  result.unordered = intake.unordered;
  if (failure) {
    result.status = failureStatus(failure);
    result.error = errorText(failure);
    if (result.status === "error") console.error("Scan sync failed:", result.error);
  }

  const finished = done();
  await withService(async (db) => {
    const extent = await storedExtent(db);
    await writeState(db, JOBS.scans, {
      watermark: extent.newest == null ? null : new Date(extent.newest).toISOString(),
      lastRunAt: now,
      lastSuccessAt: failure ? undefined : now,
      lastError: failure ? finished.error! : null,
      rowsTotal: extent.count,
      detail: {
        status: finished.status,
        configured: true,
        pagesRead: finished.pagesRead,
        rowsRead: finished.rowsRead,
        inserted: finished.inserted,
        changed: finished.changed,
        unplaceable: intake.unplaceable,
        deep: finished.deep,
        unordered: finished.unordered,
        truncated: finished.truncated,
        durationMs: finished.durationMs,
        applied: intake.appliedTotals,
        lastDeepAt: deepDone ? new Date(now).toISOString() : undefined,
        retryAt: null,
        missingEnv: null,
      },
    });
    if (handOver) {
      const { startCursorIfIdle } = await import("./reconcile");
      await startCursorIfIdle(db, handOver, now);
    }
  });
  return finished;
}
