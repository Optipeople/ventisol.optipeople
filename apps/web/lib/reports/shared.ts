// What every report wrapper shares: the transaction with settings, the
// mechanical step from a database row to a result object, the clock choice,
// parameter schemas and the access error.

import { z } from "zod";
import { withUser, type Claims, type Db } from "@/lib/db";
import { DEFAULT_THRESHOLDS, type StationThresholds } from "@/lib/derive";
import { can, type Capability } from "@/lib/portal/roles";
import { addDays, dayKey, isIsoDay } from "@/lib/time";
import type { Clock, Duration, Paged, ReportSettings } from "./types";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The caller's role may not see this report. Pages answer 403, the chat says so. */
export class ReportAccessError extends Error {
  readonly code = "forbidden";
  constructor(message = "Din rolle har ikke adgang til denne rapport.") {
    super(message);
    this.name = "ReportAccessError";
  }
}

/** Throws ReportAccessError unless the role has the capability. The database checks again. */
export function requireCapability(claims: Claims, capability: Capability): void {
  if (!can(claims.role, capability)) throw new ReportAccessError();
}

const INSUFFICIENT_PRIVILEGE = "42501";

/** Turns the database's insufficient_privilege into ReportAccessError. */
export async function mapAccessError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: unknown }).code === INSUFFICIENT_PRIVILEGE) throw new ReportAccessError();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rows to results
// ---------------------------------------------------------------------------

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)$/;

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * A database value as a result value: snake_case keys become camelCase, a
 * timestamptz (a Date from a column, a string with an offset from jsonb)
 * becomes an ISO 8601 UTC string. Recursive. Values are untouched otherwise,
 * so an id like "vindue-1-fag" or a day "2026-10-21" stays as it is.
 */
export function fromDb<T>(value: unknown): T {
  return convert(value) as T;
}

function convert(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return TIMESTAMP_RE.test(value) ? new Date(value.replace(" ", "T")).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map(convert);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[camel(key)] = convert(v);
    return out;
  }
  return value;
}

/** The rows of a table function, converted. */
export async function rows<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return fromDb<T[]>(await db.query(sql, params));
}

// ---------------------------------------------------------------------------
// Settings and the clock
// ---------------------------------------------------------------------------

export interface ReportContext {
  settings: ReportSettings;
  clock: Clock;
  useWorking: boolean;
  thresholds: StationThresholds;
}

export async function loadSettings(db: Db): Promise<ReportSettings> {
  const [row] = await db.query<{ settings: unknown }>("select rpt.settings() as settings");
  return fromDb<ReportSettings>(row.settings);
}

export function contextFor(settings: ReportSettings, clock?: Clock): ReportContext {
  const useWorking = clock ? clock === "working" : settings.useWorkingTime;
  return {
    settings,
    clock: useWorking ? "working" : "wall",
    useWorking,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      slowPercent: settings.slowThresholdPercent,
      standstillMinGapSeconds: Math.round(settings.standstillThresholdMinutes * 60),
      longDwellSeconds: Math.round(settings.longDwellThresholdMinutes * 60),
      useWorkingTime: useWorking,
    },
  };
}

/**
 * One user transaction with the settings loaded: every wrapper runs in this.
 * Row level security applies; a refusal by the database becomes ReportAccessError.
 */
export function report<T>(
  claims: Claims,
  clock: Clock | undefined,
  fn: (db: Db, ctx: ReportContext) => Promise<T>
): Promise<T> {
  return mapAccessError(() =>
    withUser(claims, async (db) => fn(db, contextFor(await loadSettings(db), clock)))
  );
}

/**
 * Both clocks and the headline. On the working clock a missing working-time
 * value falls back to the wall clock, as stationStatus() in lib/derive does.
 */
export function duration(
  wallSeconds: number | null | undefined,
  workingSeconds: number | null | undefined,
  useWorking: boolean
): Duration {
  const wall = wallSeconds ?? null;
  const working = workingSeconds ?? null;
  return { seconds: useWorking ? (working ?? wall) : wall, wallSeconds: wall, workingSeconds: working };
}

export const NO_DURATION: Duration = { seconds: null, wallSeconds: null, workingSeconds: null };

/** (value - base) / base in percent, rounded. Null without both or with a zero base. */
export function percentChange(value: number | null, base: number | null): number | null {
  if (value == null || base == null || base === 0) return null;
  return Math.round(((value - base) / base) * 100);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** A Europe/Copenhagen day, yyyy-MM-dd. */
export const daySchema = z.string().refine(isIsoDay, "Expected a day as yyyy-MM-dd");

/** A month as "yyyy-MM" or any day of it; becomes the first day of the month. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Expected a month as yyyy-MM")
  .transform((value) => `${value.slice(0, 7)}-01`)
  .refine(isIsoDay, "Expected a month as yyyy-MM");

/** "Now" as epoch milliseconds. Wrappers never read the clock themselves. */
export const nowSchema = z.number().finite();

export const clockSchema = z.enum(["working", "wall"]).optional();

export const periodShape = { from: daySchema, to: daySchema, clock: clockSchema };

export const periodSchema = z
  .object(periodShape)
  .refine((p) => p.from <= p.to, "from must not be after to");

export const pageShape = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
};

export const orderNoSchema = z.number().int().min(1).max(2_147_483_647);
export const stationNoSchema = z.number().int().min(0).max(2_147_483_647);

/** The last day of the month that starts on `month`. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The first day of the month `months` after (or before) `month`. */
export function addMonths(month: string, months: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** The period of equal length right before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** The Copenhagen day of an instant. */
export const dayOf = (now: number): string => dayKey(now);

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * Runs a list function whose rows carry total_count. `fetch` gets limit and
 * offset. A page past the end has no row to carry the total, so the first
 * row is asked for once more to learn it.
 */
export async function paged<Raw extends { totalCount: number }, T>(
  page: number,
  pageSize: number,
  fetch: (limit: number, offset: number) => Promise<Raw[]>,
  map: (row: Raw) => T
): Promise<Paged<T>> {
  const found = await fetch(pageSize, (page - 1) * pageSize);
  let total = found[0]?.totalCount ?? 0;
  if (found.length === 0 && page > 1) total = (await fetch(1, 0))[0]?.totalCount ?? 0;
  return { rows: found.map(map), total, page, pageSize };
}
