// Bookkeeping of the sync jobs.
//
//   app.sync_state    one row per job, what the settings page shows (admin
//                     may read it). Never holds a secret.
//   app.sync_private  service only: token cache, login backoff, the lease,
//                     and the changes not yet handed to the read model writer.
//
// Every function here takes the `db` of a withService transaction.

import type { Db } from "@/lib/db";

/** The job rows in app.sync_state. */
export const JOBS = {
  /** The orchestration: when a run last started, how it ended. */
  sync: "sync",
  scans: "scans",
  documents: "documents",
  reconcile: "reconcile",
  rebuild: "rebuild",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** The rows in app.sync_private. */
export const PRIVATE = {
  token: "opticloud_token",
  loginBackoff: "opticloud_login_backoff",
  lease: "lease:sync",
  pendingScans: "pending:scans",
  pendingOrders: "pending:orders",
} as const;

/** How a job run ended. Stored in detail.status. */
export type JobStatus =
  | "ok"
  /** OPTICLOUD_SERVICE_USER, OPTICLOUD_SERVICE_PASSWORD or VENTISOL_ACCOUNT_ID is not set. */
  | "not_configured"
  /** The password was rejected: no new login try until detail.retryAt. */
  | "login_backoff"
  /** OptiCloud could not be reached. */
  | "unavailable"
  /** The list does not exist in the account yet. */
  | "no_table"
  | "error";

export type Detail = Record<string, unknown>;

export interface StateRow {
  name: string;
  watermark: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  rowsTotal: number | null;
  detail: Detail;
}

interface RawStateRow {
  name: string;
  watermark: string | null;
  last_run_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error: string | null;
  rows_total: number | string | null;
  detail: Detail | null;
}

const asDate = (v: Date | string | null): Date | null => (v == null ? null : new Date(v));

export function toStateRow(row: RawStateRow): StateRow {
  return {
    name: row.name,
    watermark: row.watermark,
    lastRunAt: asDate(row.last_run_at),
    lastSuccessAt: asDate(row.last_success_at),
    lastError: row.last_error,
    rowsTotal: row.rows_total == null ? null : Number(row.rows_total),
    detail: row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail : {},
  };
}

export const STATE_COLUMNS =
  "name, watermark, last_run_at, last_success_at, last_error, rows_total, detail";

export async function readState(db: Db, name: JobName): Promise<StateRow | null> {
  const rows = await db.query<RawStateRow>(
    `select ${STATE_COLUMNS} from app.sync_state where name = $1`,
    [name]
  );
  return rows[0] ? toStateRow(rows[0]) : null;
}

export interface StatePatch {
  /** Left as it is when undefined. */
  watermark?: string | null;
  lastRunAt?: number;
  lastSuccessAt?: number;
  /** null clears it. Left as it is when undefined. */
  lastError?: string | null;
  rowsTotal?: number | null;
  /** Merged over the stored detail, key by key. A key set to undefined is left alone. */
  detail?: Detail;
}

/** Longest error text kept. Upstream error bodies can be pages long. */
const MAX_ERROR_LENGTH = 500;

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

/** Creates or updates one job row. Only what the patch names changes. */
export async function writeState(db: Db, name: JobName, patch: StatePatch): Promise<void> {
  const before = await readState(db, name);
  const detail: Detail = { ...(before?.detail ?? {}) };
  for (const [key, value] of Object.entries(patch.detail ?? {})) {
    if (value !== undefined) detail[key] = value;
  }
  const iso = (ms: number | undefined, kept: Date | null | undefined) =>
    ms !== undefined ? new Date(ms).toISOString() : kept ? kept.toISOString() : null;
  await db.query(
    `insert into app.sync_state (name, watermark, last_run_at, last_success_at, last_error, rows_total, detail)
     values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7::jsonb)
     on conflict (name) do update set
       watermark = excluded.watermark,
       last_run_at = excluded.last_run_at,
       last_success_at = excluded.last_success_at,
       last_error = excluded.last_error,
       rows_total = excluded.rows_total,
       detail = excluded.detail`,
    [
      name,
      patch.watermark !== undefined ? patch.watermark : (before?.watermark ?? null),
      iso(patch.lastRunAt, before?.lastRunAt),
      iso(patch.lastSuccessAt, before?.lastSuccessAt),
      patch.lastError !== undefined
        ? patch.lastError === null
          ? null
          : errorText(patch.lastError)
        : (before?.lastError ?? null),
      patch.rowsTotal !== undefined ? patch.rowsTotal : (before?.rowsTotal ?? null),
      JSON.stringify(detail),
    ]
  );
}

// --- app.sync_private ---

export interface PrivateRow<T> {
  value: T;
  expiresAt: Date | null;
}

export async function getPrivate<T>(db: Db, name: string): Promise<PrivateRow<T> | null> {
  const rows = await db.query<{ value: T; expires_at: Date | string | null }>(
    "select value, expires_at from app.sync_private where name = $1",
    [name]
  );
  return rows[0] ? { value: rows[0].value, expiresAt: asDate(rows[0].expires_at) } : null;
}

export async function setPrivate(
  db: Db,
  name: string,
  value: unknown,
  expiresAt: number | null = null
): Promise<void> {
  await db.query(
    `insert into app.sync_private (name, value, expires_at, updated_at)
     values ($1, $2::jsonb, $3::timestamptz, now())
     on conflict (name) do update set
       value = excluded.value, expires_at = excluded.expires_at, updated_at = now()`,
    [name, JSON.stringify(value), expiresAt == null ? null : new Date(expiresAt).toISOString()]
  );
}

export async function deletePrivate(db: Db, name: string): Promise<void> {
  await db.query("delete from app.sync_private where name = $1", [name]);
}

/**
 * Takes the lease when nobody holds it or the holder's time is up. One
 * statement, so two callers cannot both win. True when `owner` now holds it.
 */
export async function acquireLease(
  db: Db,
  owner: string,
  now: number,
  ttlMs: number,
  what: string
): Promise<boolean> {
  const rows = await db.query(
    `insert into app.sync_private as p (name, value, expires_at, updated_at)
     values ($1, $2::jsonb, $3::timestamptz, now())
     on conflict (name) do update set
       value = excluded.value, expires_at = excluded.expires_at, updated_at = now()
     where p.expires_at is null or p.expires_at <= $4::timestamptz
     returning name`,
    [
      PRIVATE.lease,
      JSON.stringify({ owner, what }),
      new Date(now + ttlMs).toISOString(),
      new Date(now).toISOString(),
    ]
  );
  return rows.length > 0;
}

/** Gives the lease back, if `owner` still holds it. */
export async function releaseLease(db: Db, owner: string): Promise<void> {
  await db.query(
    "delete from app.sync_private where name = $1 and value->>'owner' = $2",
    [PRIVATE.lease, owner]
  );
}

/**
 * Adds items to a pending list (a jsonb array). Called in the same
 * transaction as the write the items describe, so a change that is stored is
 * also queued for the read model, whatever happens to the process next.
 */
export async function appendPending(db: Db, name: string, items: unknown[]): Promise<void> {
  if (items.length === 0) return;
  await db.query(
    `insert into app.sync_private as p (name, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (name) do update set value = p.value || excluded.value, updated_at = now()`,
    [name, JSON.stringify(items)]
  );
}

/** The pending list, oldest first. */
export async function readPending<T>(db: Db, name: string): Promise<T[]> {
  const row = await getPrivate<unknown>(db, name);
  return Array.isArray(row?.value) ? (row.value as T[]) : [];
}

/** Drops the first `count` items of a pending list: the ones that were handed over. */
export async function dropPending(db: Db, name: string, count: number): Promise<void> {
  if (count <= 0) return;
  await db.query(
    `update app.sync_private
        set value = coalesce(
              (select jsonb_agg(t.item order by t.n)
                 from jsonb_array_elements(value) with ordinality as t(item, n)
                where t.n > $2),
              '[]'::jsonb),
            updated_at = now()
      where name = $1`,
    [name, count]
  );
}
