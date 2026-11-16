// The one file in lib/sync that pages may import: the sync status for the
// settings page, the admin's "sync now" and "rebuild" buttons, and the
// throttled requestSync for report pages.
//
// What a page can see. getSyncStatus reads app.sync_state as the user, so row
// level security decides: an admin gets the rows, everyone else gets none.
// Of each row only the fields below are passed on, picked by name. Secrets
// are not in that table at all: the cached OptiCloud token, the login backoff
// and the lease live in app.sync_private, which has no policy and no grant.
// Of that table an admin is told one number: how many orders are in the dead
// letters.
//
// The heavy parts (the PDF parser, the OptiCloud client) are only loaded when
// a run is actually started.

import { withService, withUser, type Claims } from "@/lib/db";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import { audit } from "@/lib/portal/audit";
import type { RebuildRunResult, RequestSyncOptions, RequestSyncResult, SyncRunResult } from "./run";
import { readDeadLetters, STATE_COLUMNS, toStateRow } from "./state";
// Registers the fixture seed (does nothing outside fixture mode).
import "./fixture-seed";

export type { RebuildRunResult, RequestSyncResult, SyncRunResult } from "./run";

/** The counters a job may report. All optional: each job has its own. */
const TOTAL_KEYS = [
  "pagesRead",
  "rowsRead",
  "inserted",
  "changed",
  "deleted",
  "listed",
  "removed",
  "parsed",
  "withProblems",
  "failed",
  "queued",
  "bytes",
  "durationMs",
] as const;

export type SyncTotals = Partial<Record<(typeof TOTAL_KEYS)[number], number>>;

export interface SyncStatusRow {
  /** "sync", "scans", "documents", "reconcile", "rebuild", and whatever the read model writer files. */
  name: string;
  /** How the last run ended: "ok", "not_configured", "login_backoff", "unavailable", "no_table", "error", "running". */
  status: string | null;
  /** False when the job could not run because the service account is not set. Null when the row does not say. */
  configured: boolean | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  /** Whole seconds since the last success. Null when it never succeeded. */
  lagSeconds: number | null;
  error: string | null;
  /** Rows in the mirrored table after the last run. */
  rowsTotal: number | null;
  /** Scans: the newest scan time stored. Documents: the newest row. ISO text. */
  watermark: string | null;
  /** Counters of the last run. */
  totals: SyncTotals;
  /** After a rejected password: when the next login is tried. */
  retryAt: Date | null;
  /** A reconcile pass is under way and will be continued. */
  passRunning: boolean;
  /** The API did not return rows newest first, so more was read than usual. */
  unordered: boolean;
}

export interface SyncStatus {
  /** The service account is set in the environment (or fixture mode is on). */
  configured: boolean;
  /** The names of the missing environment variables. Never their values. */
  missing: string[];
  jobs: SyncStatusRow[];
  /**
   * Orders the read model writer kept failing on and set aside, so their
   * figures are out of date until a rebuild. 0 for anyone but an admin.
   */
  deadLetters: number;
}

function missingEnv(): string[] {
  if (fixturesEnabled()) return [];
  return [
    !process.env.OPTICLOUD_SERVICE_USER?.trim() && "OPTICLOUD_SERVICE_USER",
    !process.env.OPTICLOUD_SERVICE_PASSWORD && "OPTICLOUD_SERVICE_PASSWORD",
    !process.env.VENTISOL_ACCOUNT_ID?.trim() && "VENTISOL_ACCOUNT_ID",
  ].filter((name): name is string => typeof name === "string");
}

/**
 * The sync jobs as the settings page shows them. Runs as the user: only an
 * admin gets rows, anyone else an empty list.
 */
export async function getSyncStatus(claims: Claims, now: number = Date.now()): Promise<SyncStatus> {
  const { rows, admin } = await withUser(claims, async (db) => ({
    rows: await db.query<Parameters<typeof toStateRow>[0]>(`select ${STATE_COLUMNS} from app.sync_state order by name`),
    admin: (await db.query<{ ok: boolean }>("select app.has_role('admin') as ok"))[0]?.ok === true,
  }));
  // app.sync_private has no grant: only the count is read, as the service, and only for an admin.
  const deadLetters = admin ? (await withService((db) => readDeadLetters(db))).length : 0;
  const missing = missingEnv();
  return {
    configured: missing.length === 0,
    missing,
    deadLetters,
    jobs: rows.map((raw): SyncStatusRow => {
      const row = toStateRow(raw);
      const d = row.detail;
      const totals: SyncTotals = {};
      for (const key of TOTAL_KEYS) {
        if (typeof d[key] === "number") totals[key] = d[key];
      }
      const retryAt = typeof d.retryAt === "string" ? new Date(d.retryAt) : null;
      return {
        name: row.name,
        status: typeof d.status === "string" ? d.status : null,
        configured: typeof d.configured === "boolean" ? d.configured : null,
        lastRunAt: row.lastRunAt,
        lastSuccessAt: row.lastSuccessAt,
        lagSeconds:
          row.lastSuccessAt === null
            ? null
            : Math.max(0, Math.round((now - row.lastSuccessAt.getTime()) / 1000)),
        error: row.lastError,
        rowsTotal: row.rowsTotal,
        watermark: row.watermark,
        totals,
        retryAt: retryAt && !Number.isNaN(retryAt.getTime()) ? retryAt : null,
        passRunning: d.cursor != null,
        unordered: d.unordered === true,
      };
    }),
  };
}

/**
 * "Sync now" for report pages: starts a sync only when the last one began
 * more than 20 seconds ago, and keeps the page waiting 1.5 seconds at most.
 * Safe on every page view. Never throws. See requestSync in run.ts.
 */
export async function requestSync(options?: RequestSyncOptions): Promise<RequestSyncResult> {
  try {
    const { requestSync: request } = await import("./run");
    return await request(options);
  } catch {
    return { started: false };
  }
}

export type AdminRunResult<T> =
  /** The caller is not an admin. Nothing was started and nothing was logged. */
  | { ok: false; reason: "forbidden" }
  /** Started and ended within the wait. */
  | { ok: true; finished: true; result: T }
  /** Started, still going behind the response. The status rows show how it ends. */
  | { ok: true; finished: false };

/** Longest an admin action keeps its caller waiting. */
export const ADMIN_WAIT_MS = 10_000;

/** The role is checked where it cannot be faked: in the database, from the claims of the transaction. */
async function auditedAsAdmin(claims: Claims, action: string, subject: string): Promise<boolean> {
  return withUser(claims, async (db) => {
    const rows = await db.query<{ ok: boolean }>("select app.has_role('admin') as ok");
    if (rows[0]?.ok !== true) return false;
    await audit(db, action, subject, {});
    return true;
  });
}

async function startAndWait<T>(work: Promise<T>, waitMs: number): Promise<AdminRunResult<T>> {
  // Without this a serverless function may be frozen once the response is sent.
  try {
    const { after } = await import("next/server");
    after(() => work.catch(() => {}));
  } catch {
    // Not inside a request: the promise simply runs on.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const result = await Promise.race([work, timeout]);
    return result === null ? { ok: true, finished: false } : { ok: true, finished: true, result: result as T };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The admin's "sync now": runs at once, whatever the throttle says (but not
 * beside another run: the result is then { status: "busy" }). Audited as
 * "sync.requested".
 */
export async function requestSyncAsAdmin(
  claims: Claims,
  options: { now?: number; waitMs?: number } = {}
): Promise<AdminRunResult<SyncRunResult>> {
  if (!(await auditedAsAdmin(claims, "sync.requested", "sync"))) return { ok: false, reason: "forbidden" };
  const { runSync } = await import("./run");
  return startAndWait(runSync({ now: options.now ?? Date.now() }), options.waitMs ?? ADMIN_WAIT_MS);
}

/**
 * The admin's "rebuild": core.* built again from raw.*, and the search
 * chunks from the stored documents. Audited as "sync.rebuild_requested".
 */
export async function requestRebuildAsAdmin(
  claims: Claims,
  options: { now?: number; waitMs?: number } = {}
): Promise<AdminRunResult<RebuildRunResult>> {
  if (!(await auditedAsAdmin(claims, "sync.rebuild_requested", "rebuild"))) {
    return { ok: false, reason: "forbidden" };
  }
  const { runRebuild } = await import("./run");
  return startAndWait(runRebuild({ now: options.now ?? Date.now() }), options.waitMs ?? ADMIN_WAIT_MS);
}
