// Reconcile: the wider read that catches what the minute sync cannot see.
//
//   - an edit to a row that is already stored,
//   - a scan sent so late that it lies deeper than the sync looks,
//   - a row deleted in OptiCloud.
//
// TWO MODES
//
//   window (default, 45 days)  newest first, until a page lies wholly before
//                              the window (with the 10 minute margin of
//                              lib/paging.ts).
//   full                       every page of the list.
//
// Both are passes with a cursor in app.sync_state ("reconcile", detail.cursor).
// One invocation reads a bounded chunk (pages and time), saves the cursor,
// and the next invocation goes on: the nightly cron starts a pass, and the
// minute sync continues an unfinished one with whatever time it has left
// (run.ts). A pass resumes one page before where it stopped: new rows only
// push old ones to later pages, so a row is read twice rather than skipped.
// The scan sync starts a pass too, when it runs into its own limits (a first
// sync, a long outage).
//
// THE DELETION RULE
//
// A stored row is deleted only when two separate passes both prove it gone.
//
// What one chunk proves. The pages of a chunk are consecutive and newest
// first, so they hold every row of the list between the chunk's newest and
// oldest scan time. A row in raw.scans with a scan time inside that stretch
// that was on none of those pages is missing. To be safe at the edges, the
// stretch ends 2 seconds inside the first and the last page read (and is open
// at the top when the chunk starts at page 1, and at the bottom when it
// reached the end of the list); the overlap on resume covers the seams.
//
// Why twice. Two rows with the same scan time can swap places between two
// page requests, and a row deleted upstream during the read pulls every later
// row one place up: either can hide a row that is still there. So a missing
// row is first only noted (detail.missing, with the pass that missed it). If
// a later pass sees it, the note is dropped. If a later pass misses it again,
// it is deleted from raw.scans and handed to the read model writer like any
// other change. With the nightly cron a deletion in OptiCloud therefore
// reaches the portal on the second night.
//
// Not checked, so never deleted: rows without a scan time; anything, when the
// API ignores the ordering (there is then no stretch to reason about); and a
// chunk in which more than a fifth of the stored rows (and more than 20) look
// missing, which says the read is wrong, not the data.

import { withService, type Db } from "@/lib/db";
import { STOP_MARGIN_MS } from "@/lib/paging";
import { SCAN_TABLE_NAME } from "@/lib/scans";
import { getOptiCloud, type ServiceAccess } from "./opticloud-service";
import {
  failureStatus,
  recordNoAccess,
  ScanIntake,
  scanPageLoader,
  toChangedScan,
  walkPages,
  type HandOver,
} from "./scans";
import {
  appendPending,
  errorText,
  JOBS,
  PRIVATE,
  readState,
  writeState,
  type JobStatus,
} from "./state";

export const RECONCILE_DEFAULT_DAYS = 45;
/** Pages one invocation reads at most (500 rows each). */
export const RECONCILE_MAX_PAGES = 150;
/** Pages asked for at once. */
export const RECONCILE_CONCURRENCY = 3;
/** The proven stretch ends this far inside the first and last page of a chunk. */
const EDGE_GUARD_MS = 2_000;
/** Noted missing rows kept at most. Beyond it nothing more is noted (and so not deleted). */
const MAX_MISSING_NOTES = 5_000;
/** A note not confirmed within this time is dropped. */
const MISSING_NOTE_TTL_MS = 60 * 86_400_000;

const DAY_MS = 86_400_000;

export interface ReconcileCursor {
  mode: "window" | "full";
  /** Window mode: read back to this time (epoch ms). */
  since: number | null;
  /** The first page not read yet. */
  nextPage: number;
  /** When the pass started (epoch ms). Tells one pass from another. */
  passId: number;
  pagesRead: number;
  inserted: number;
  changed: number;
  deleted: number;
}

function asCursor(value: unknown): ReconcileCursor | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<ReconcileCursor>;
  if ((c.mode !== "window" && c.mode !== "full") || typeof c.nextPage !== "number" || typeof c.passId !== "number") {
    return null;
  }
  return {
    mode: c.mode,
    since: typeof c.since === "number" ? c.since : null,
    nextPage: Math.max(1, Math.trunc(c.nextPage)),
    passId: c.passId,
    pagesRead: Number(c.pagesRead) || 0,
    inserted: Number(c.inserted) || 0,
    changed: Number(c.changed) || 0,
    deleted: Number(c.deleted) || 0,
  };
}

function asMissing(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [id, pass] of Object.entries(value)) {
      if (typeof pass === "number") out[id] = pass;
    }
  }
  return out;
}

/**
 * Starts a pass where the scan sync had to stop, unless one is under way.
 * Runs in the caller's service transaction.
 */
export async function startCursorIfIdle(db: Db, from: HandOver, now: number): Promise<void> {
  const state = await readState(db, JOBS.reconcile);
  if (asCursor(state?.detail.cursor)) return;
  const cursor: ReconcileCursor = {
    mode: from.mode,
    since: from.since,
    nextPage: from.nextPage,
    passId: now,
    pagesRead: 0,
    inserted: 0,
    changed: 0,
    deleted: 0,
  };
  await writeState(db, JOBS.reconcile, { detail: { cursor } });
}

/** True when a pass is waiting to be continued. Opens its own transaction. */
export async function reconcilePending(): Promise<boolean> {
  const state = await withService((db) => readState(db, JOBS.reconcile));
  return asCursor(state?.detail.cursor) !== null;
}

export interface ReconcileOptions {
  now: number;
  access?: ServiceAccess;
  /** Window mode: how many days back. Default 45. */
  days?: number;
  /** Read the whole list instead of a window. */
  full?: boolean;
  /** Drop an unfinished pass and start a new one. */
  restart?: boolean;
  /** Only continue an unfinished pass; do nothing when there is none. */
  resumeOnly?: boolean;
  maxPages?: number;
  /** Date.now() after which no further page is asked for. */
  deadline?: number;
}

export interface ReconcileResult {
  status: JobStatus | "idle";
  mode: "window" | "full" | null;
  /** This invocation. */
  pagesRead: number;
  rowsRead: number;
  inserted: number;
  changed: number;
  /** Rows a first pass found missing in this chunk (noted, not deleted). */
  noted: number;
  /** Rows deleted because a second pass missed them too. */
  deleted: number;
  /** The pass is done. False: the cursor is saved and the next invocation goes on. */
  finished: boolean;
  unordered: boolean;
  /** Why the deletion check was skipped for this chunk, if it was. */
  deletionCheck: "done" | "unordered" | "too_many_missing" | "no_stretch" | "skipped";
  durationMs: number;
  error?: string;
}

/**
 * One invocation of the reconcile: starts a pass or continues the unfinished
 * one. Never throws: how it went is in the result and in app.sync_state
 * ("reconcile").
 */
export async function runScanReconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const { now } = options;
  const started = Date.now();
  const result: ReconcileResult = {
    status: "ok",
    mode: null,
    pagesRead: 0,
    rowsRead: 0,
    inserted: 0,
    changed: 0,
    noted: 0,
    deleted: 0,
    finished: false,
    unordered: false,
    deletionCheck: "skipped",
    durationMs: 0,
  };
  const done = () => ({ ...result, durationMs: Date.now() - started });

  const before = await withService((db) => readState(db, JOBS.reconcile));
  let cursor = options.restart ? null : asCursor(before?.detail.cursor);
  if (!cursor && options.resumeOnly) {
    result.status = "idle";
    result.finished = true;
    return done();
  }

  const access = options.access ?? (await getOptiCloud(now));
  if (access.status !== "ok") {
    await recordNoAccess(JOBS.reconcile, access, now);
    result.status = access.status;
    return done();
  }
  const source = access.source;

  if (!cursor) {
    const days = Math.min(3650, Math.max(1, Math.trunc(options.days ?? RECONCILE_DEFAULT_DAYS)));
    cursor = {
      mode: options.full ? "full" : "window",
      since: options.full ? null : now - days * DAY_MS,
      nextPage: 1,
      passId: now,
      pagesRead: 0,
      inserted: 0,
      changed: 0,
      deleted: 0,
    };
  }
  const pass = cursor;
  result.mode = pass.mode;

  const intake = new ScanIntake(now, { trackSeen: true });
  // One page of overlap on resume.
  const startPage = Math.max(1, pass.nextPage - 1);
  // Scan times at the two ends of this chunk.
  const edge: { firstMin: number | null; lastMax: number | null } = { firstMin: null, lastMax: null };
  let walked: Awaited<ReturnType<typeof walkPages>> | null = null;
  let failure: unknown = null;

  try {
    const tableId = await source.findTableId(SCAN_TABLE_NAME);
    if (!tableId) {
      await withService((db) =>
        writeState(db, JOBS.reconcile, {
          lastRunAt: now,
          lastError: null,
          detail: { status: "no_table", configured: true, cursor: null },
        })
      );
      result.status = "no_table";
      return done();
    }
    walked = await walkPages({
      load: scanPageLoader(source, tableId),
      startPage,
      maxPages: options.maxPages ?? RECONCILE_MAX_PAGES,
      deadline: options.deadline ?? Number.POSITIVE_INFINITY,
      concurrency: RECONCILE_CONCURRENCY,
      onPage: async (page, rows) => {
        const outcome = await intake.take(rows);
        if (page === startPage) edge.firstMin = outcome.minTime;
        if (outcome.maxTime != null) edge.lastMax = outcome.maxTime;
        const beforeWindow =
          pass.mode === "window" &&
          pass.since != null &&
          !intake.unordered &&
          outcome.maxTime != null &&
          outcome.maxTime < pass.since - STOP_MARGIN_MS;
        return beforeWindow ? "stop" : "continue";
      },
    });
  } catch (err) {
    failure = err;
  }

  result.pagesRead = walked?.pagesRead ?? 0;
  result.rowsRead = intake.rowsRead;
  result.inserted = intake.inserted;
  result.changed = intake.changed;
  result.unordered = intake.unordered;
  result.finished = walked !== null && walked.reason !== "budget";

  // The deletion rule, see the header.
  try {
    await withService(async (db) => {
      const missing = asMissing(before?.detail.missing);
      const seen = intake.seen!;
      for (const id of Object.keys(missing)) {
        // Seen again, or noted too long ago to mean anything.
        if (seen.has(id) || now - missing[id] > MISSING_NOTE_TTL_MS) delete missing[id];
      }

      if (failure || !walked || walked.pagesRead === 0) {
        result.deletionCheck = "skipped";
      } else if (intake.unordered) {
        result.deletionCheck = "unordered";
      } else {
        const top = startPage === 1 ? null : edge.firstMin == null ? undefined : edge.firstMin - EDGE_GUARD_MS;
        const bottom =
          walked.reason === "end" ? null : edge.lastMax == null ? undefined : edge.lastMax + EDGE_GUARD_MS;
        if (top === undefined || bottom === undefined || (top != null && bottom != null && top <= bottom)) {
          result.deletionCheck = "no_stretch";
        } else {
          const stored = await db.query<{ scan_id: string }>(
            `select scan_id from raw.scans
              where scan_time is not null
                and ($1::timestamptz is null or scan_time < $1::timestamptz)
                and ($2::timestamptz is null or scan_time > $2::timestamptz)`,
            [
              top == null ? null : new Date(top).toISOString(),
              bottom == null ? null : new Date(bottom).toISOString(),
            ]
          );
          const absent = stored.map((r) => r.scan_id).filter((id) => !seen.has(id));
          if (absent.length > Math.max(20, stored.length / 5)) {
            result.deletionCheck = "too_many_missing";
          } else {
            result.deletionCheck = "done";
            const confirmed: string[] = [];
            for (const id of absent) {
              if (missing[id] !== undefined && missing[id] !== pass.passId) {
                confirmed.push(id);
                delete missing[id];
              } else if (missing[id] === undefined && Object.keys(missing).length < MAX_MISSING_NOTES) {
                missing[id] = pass.passId;
                result.noted++;
              }
            }
            if (confirmed.length > 0) {
              const gone = await db.query<{
                scan_id: string;
                barcode: string | null;
                order_no: number | null;
                station_no: number | null;
                scan_time: Date | null;
              }>(
                `delete from raw.scans where scan_id = any($1::text[])
                 returning scan_id, barcode, order_no, station_no, scan_time`,
                [confirmed]
              );
              result.deleted = gone.length;
              // Their orders and station days must be worked out again.
              await appendPending(
                db,
                PRIVATE.pendingScans,
                gone.map(toChangedScan).filter((c) => c !== null)
              );
            }
          }
        }
      }

      if (failure) {
        result.status = failureStatus(failure);
        result.error = errorText(failure);
      }
      const next: ReconcileCursor = {
        ...pass,
        nextPage: walked && walked.reason === "budget" ? walked.nextPage : pass.nextPage,
        pagesRead: pass.pagesRead + result.pagesRead,
        inserted: pass.inserted + result.inserted,
        changed: pass.changed + result.changed,
        deleted: pass.deleted + result.deleted,
      };
      const total = await db.query<{ count: number }>("select count(*) as count from raw.scans");
      await writeState(db, JOBS.reconcile, {
        lastRunAt: now,
        // A pass counts as a success when it is done, not per chunk.
        lastSuccessAt: result.finished ? now : undefined,
        lastError: failure ? result.error! : null,
        rowsTotal: Number(total[0]?.count ?? 0),
        watermark: result.finished ? new Date(pass.passId).toISOString() : undefined,
        detail: {
          status: result.status,
          configured: true,
          cursor: result.finished ? null : next,
          missing,
          unordered: result.unordered,
          deletionCheck: result.deletionCheck,
          lastPass: result.finished
            ? {
                mode: next.mode,
                since: next.since == null ? null : new Date(next.since).toISOString(),
                startedAt: new Date(next.passId).toISOString(),
                finishedAt: new Date(now).toISOString(),
                pagesRead: next.pagesRead,
                inserted: next.inserted,
                changed: next.changed,
                deleted: next.deleted,
              }
            : undefined,
          retryAt: null,
          missingEnv: null,
        },
      });
    });
  } catch (err) {
    failure ??= err;
    result.status = "error";
    result.error = errorText(err);
  }

  try {
    await intake.flush();
  } catch (err) {
    if (!failure) {
      failure = err;
      result.status = "error";
      result.error = errorText(err);
      await withService((db) => writeState(db, JOBS.reconcile, { lastError: result.error! })).catch(() => {});
    }
  }
  if (failure && result.status === "error") console.error("Scan reconcile failed:", result.error);
  return done();
}
