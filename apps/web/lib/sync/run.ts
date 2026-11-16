// Orchestration: what the cron routes, the settings page and the report
// pages start.
//
//   runSync       scans, then documents, then (with the time left) a chunk
//                 of an unfinished reconcile pass.
//   runReconcile  starts or continues a reconcile pass, and reads the
//                 document list.
//   runRebuild    builds core.* again from raw.* (rebuildAll) and writes the
//                 search chunks again.
//   requestSync   for pages: a throttled "sync now" that never holds up the
//                 page.
//
// ONE RUN AT A TIME
//
// The guard is a lease: the row "lease:sync" in app.sync_private with an
// expiry, taken in a single statement (insert, or update only where the old
// lease has run out), so two callers cannot both get it. An advisory lock
// would not do: the database is reached through the transaction pooler, where
// a session lock does not survive the statement and pg_try_advisory_xact_lock
// only lasts one transaction, while a run is many transactions with HTTP
// calls in between. All three jobs share the one lease, because they write
// the same tables and the deletion rule of the reconcile counts on nobody
// else writing raw.scans while it compares.
//
// A run that dies leaves its lease behind until it expires (the run's time
// budget plus a minute), then the next run takes over. Every run gives the
// lease back when it ends.
//
// Nothing here throws for the expected states (not configured, password
// rejected, OptiCloud down, another run busy): they are results.

import { randomUUID } from "node:crypto";
import { DatabaseNotConfiguredError, withService } from "@/lib/db";
import { continueRebuild, rebuildAll, type ApplyResult } from "@/lib/readmodel";
import { flushDocumentChanges, rebuildDocumentChunks, runDocumentSync, type DocumentSyncResult } from "./documents";
import { getOptiCloud } from "./opticloud-service";
import { reconcilePending, runScanReconcile, type ReconcileResult } from "./reconcile";
import { flushScanChanges, runScanSync, type ScanSyncResult } from "./scans";
import {
  acquireLease,
  deletePrivate,
  errorText,
  JOBS,
  PRIVATE,
  readState,
  releaseLease,
  writeState,
} from "./state";
// Registers the fixture seed (does nothing outside fixture mode).
import "./fixture-seed";

/** Time a sync run gives itself. The cron route allows 60 seconds. */
export const SYNC_BUDGET_MS = 45_000;
/** Time a reconcile invocation gives itself. The cron route allows 300 seconds. */
export const RECONCILE_BUDGET_MS = 240_000;
/** A lease outlives its run's budget by this much, then anyone may take it. */
const LEASE_SLACK_MS = 60_000;
/** The lease of a rebuild, which has no budget of its own. */
const REBUILD_LEASE_MS = 15 * 60_000;
/** A reconcile chunk is only started in a sync run with this much time left. */
const MIN_RECONCILE_TIME_MS = 10_000;

/** requestSync starts nothing when the last run began less than this ago. */
export const REQUEST_SYNC_INTERVAL_SECONDS = 20;
/** Longest requestSync keeps its caller waiting. */
export const REQUEST_SYNC_WAIT_MS = 1_500;

type Skipped =
  /** Another run holds the lease. */
  | { status: "busy" }
  /** The last run began less than minIntervalMs ago. */
  | { status: "recent" };

export type SyncRunResult =
  | Skipped
  | {
      status: "done";
      scans: ScanSyncResult;
      documents: DocumentSyncResult;
      /** Present when an unfinished reconcile pass was continued. */
      reconcile?: ReconcileResult;
      durationMs: number;
    }
  | { status: "error"; error: string };

export type ReconcileRunResult =
  | Skipped
  | { status: "done"; scans: ReconcileResult; documents: DocumentSyncResult; durationMs: number }
  | { status: "error"; error: string };

export type RebuildRunResult =
  | Skipped
  | { status: "done"; applied: ApplyResult; chunkedFiles: number; durationMs: number }
  | { status: "error"; error: string };

/**
 * Runs `work` holding the lease. "busy" when someone else holds it, "recent"
 * when minIntervalMs has not passed since the last run began.
 */
async function withLease<T>(
  what: string,
  now: number,
  ttlMs: number,
  minIntervalMs: number,
  work: () => Promise<T>
): Promise<T | Skipped> {
  const owner = randomUUID();
  const entry = await withService(async (db): Promise<"go" | Skipped["status"]> => {
    if (minIntervalMs > 0) {
      const last = (await readState(db, JOBS.sync))?.lastRunAt;
      if (last && now - last.getTime() < minIntervalMs) return "recent";
    }
    if (!(await acquireLease(db, owner, now, ttlMs, what))) return "busy";
    await writeState(db, JOBS.sync, { lastRunAt: now, detail: { status: "running", what } });
    return "go";
  });
  if (entry !== "go") return { status: entry };

  let error: string | null = null;
  try {
    return await work();
  } catch (err) {
    error = errorText(err);
    throw err;
  } finally {
    await withService(async (db) => {
      await releaseLease(db, owner);
      await writeState(db, JOBS.sync, {
        lastSuccessAt: error === null ? now : undefined,
        lastError: error,
        detail: { status: error === null ? "ok" : "error", what },
      });
    }).catch((err) => console.error("Sync: the lease could not be given back:", errorText(err)));
  }
}

export interface RunSyncOptions {
  now: number;
  /** Start nothing when the last run began less than this ago. 0: always run. */
  minIntervalMs?: number;
  budgetMs?: number;
  /** Scans only. The fixture seed uses it to get the first page up fast. */
  skipDocuments?: boolean;
}

/** Scans, then documents. Safe to call from anywhere, any number of times. */
export async function runSync(options: RunSyncOptions): Promise<SyncRunResult> {
  const { now } = options;
  const budget = options.budgetMs ?? SYNC_BUDGET_MS;
  try {
    return await withLease("sync", now, budget + LEASE_SLACK_MS, options.minIntervalMs ?? 0, async () => {
      const started = Date.now();
      const deadline = started + budget;
      // One login for the whole run.
      const access = await getOptiCloud(now);
      const scans = await runScanSync({ now, access, deadline });
      const documents = await runDocumentSync({ now, access, deadline, maxFiles: options.skipDocuments ? 0 : undefined });
      let reconcile: ReconcileResult | undefined;
      if (access.status === "ok" && deadline - Date.now() >= MIN_RECONCILE_TIME_MS && (await reconcilePending())) {
        reconcile = await runScanReconcile({ now, access, deadline, resumeOnly: true });
      }
      // A rebuild started by a settings or calendar change with a budget
      // goes on here, a chunk at a time. It does nothing when none is open.
      const left = deadline - Date.now();
      if (left >= MIN_RECONCILE_TIME_MS) await continueRebuild(now, { budgetMs: left });
      return { status: "done" as const, scans, documents, reconcile, durationMs: Date.now() - started };
    });
  } catch (err) {
    // No database is a normal state on a machine without one: no noise.
    if (!(err instanceof DatabaseNotConfiguredError)) console.error("Sync run failed:", errorText(err));
    return { status: "error", error: errorText(err) };
  }
}

export interface RunReconcileOptions {
  now: number;
  /** How many days back. Default 45. */
  days?: number;
  /** Read the whole list. */
  full?: boolean;
  /** Drop an unfinished pass and start anew. */
  restart?: boolean;
  budgetMs?: number;
}

/** The wide read. See reconcile.ts for the modes and the deletion rule. */
export async function runReconcile(options: RunReconcileOptions): Promise<ReconcileRunResult> {
  const { now } = options;
  const budget = options.budgetMs ?? RECONCILE_BUDGET_MS;
  try {
    return await withLease("reconcile", now, budget + LEASE_SLACK_MS, 0, async () => {
      const started = Date.now();
      const deadline = started + budget;
      const access = await getOptiCloud(now);
      const scans = await runScanReconcile({
        now,
        access,
        deadline,
        days: options.days,
        full: options.full,
        restart: options.restart,
      });
      const documents = await runDocumentSync({ now, access, deadline, forceList: true });
      return { status: "done" as const, scans, documents, durationMs: Date.now() - started };
    });
  } catch (err) {
    console.error("Reconcile run failed:", errorText(err));
    return { status: "error", error: errorText(err) };
  }
}

/** Builds core.* again from raw.*, and the search chunks from the stored documents. Needs no OptiCloud. */
export async function runRebuild(options: { now: number }): Promise<RebuildRunResult> {
  const { now } = options;
  try {
    return await withLease("rebuild", now, REBUILD_LEASE_MS, 0, async () => {
      const started = Date.now();
      let failure: string | null = null;
      let applied: ApplyResult = { orders: 0, stationDays: 0 };
      let chunkedFiles = 0;
      try {
        applied = await rebuildAll(now);
        chunkedFiles = await rebuildDocumentChunks();
      } catch (err) {
        failure = errorText(err);
      }
      const durationMs = Date.now() - started;
      await withService((db) =>
        writeState(db, JOBS.rebuild, {
          lastRunAt: now,
          lastSuccessAt: failure === null ? now : undefined,
          lastError: failure,
          detail: { status: failure === null ? "ok" : "error", configured: true, applied, chunkedFiles, durationMs },
        })
      );
      if (failure !== null) throw new Error(failure);
      // Everything queued for the writer is covered by the rebuild.
      await dropQueues();
      return { status: "done" as const, applied, chunkedFiles, durationMs };
    });
  } catch (err) {
    console.error("Rebuild failed:", errorText(err));
    return { status: "error", error: errorText(err) };
  }
}

async function dropQueues(): Promise<void> {
  await withService(async (db) => {
    await deletePrivate(db, PRIVATE.pendingScans);
    await deletePrivate(db, PRIVATE.pendingOrders);
  });
}

/**
 * Hands over what an earlier run stored but could not pass to the read model
 * writer. The sync jobs do this themselves at the end of every run; this is
 * for a caller that only wants the queues emptied.
 */
export async function flushPendingChanges(now: number): Promise<void> {
  await flushScanChanges(now);
  await flushDocumentChanges(now);
}

// --- requestSync ---

interface RequestMemory {
  lastRequestAt: number;
  running: Promise<SyncRunResult> | null;
}

// On globalThis: `next dev` evaluates modules again on every hot reload.
const requestKey = Symbol.for("ventisol.sync.request");
const requestStore = globalThis as unknown as { [requestKey]?: RequestMemory };

function requestMemory(): RequestMemory {
  return (requestStore[requestKey] ??= { lastRequestAt: 0, running: null });
}

/** For tests. */
export function resetRequestSync(): void {
  requestMemory().lastRequestAt = 0;
  requestMemory().running = null;
}

export interface RequestSyncOptions {
  now?: number;
  /** Start nothing when the last run began less than this ago. Default 20. */
  minIntervalSeconds?: number;
  /** Longest the caller is kept waiting. Default 1.5 seconds. */
  waitMs?: number;
}

export type RequestSyncResult =
  /** A run was started and ended within the wait. */
  | { started: true; finished: true; result: SyncRunResult }
  /** A run was started and is still going. */
  | { started: true; finished: false }
  /** Nothing was started: a run began a moment ago (here or on another instance). */
  | { started: false };

/**
 * "Sync now" for pages. Safe to call on every page view: most calls return
 * at once from a check in memory, the rest cost one small transaction, and a
 * run is only started when the last one began more than minIntervalSeconds
 * ago. The caller waits at most waitMs; a longer run goes on behind the
 * response (kept alive with `after` where there is a request). Never throws.
 */
export async function requestSync(options: RequestSyncOptions = {}): Promise<RequestSyncResult> {
  const now = options.now ?? Date.now();
  const minIntervalMs = (options.minIntervalSeconds ?? REQUEST_SYNC_INTERVAL_SECONDS) * 1000;
  const mem = requestMemory();
  if (mem.running || now - mem.lastRequestAt < minIntervalMs) return { started: false };
  mem.lastRequestAt = now;

  const run = runSync({ now, minIntervalMs }).finally(() => {
    mem.running = null;
  });
  mem.running = run;

  // Without this a serverless function may be frozen once the page is sent.
  try {
    const { after } = await import("next/server");
    after(() => run);
  } catch {
    // Not inside a request (a script, a test): the promise simply runs on.
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    run,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.waitMs ?? REQUEST_SYNC_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (waited === null) return { started: true, finished: false };
  if (waited.status === "busy" || waited.status === "recent") return { started: false };
  return { started: true, finished: true, result: waited };
}
