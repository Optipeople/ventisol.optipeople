// Server-side reads from the Optipeople API, with the signed-in user's bearer
// token (vola reads through the External API with an access key instead).
//
//   GET /api/MasterData/GetTables/{accountId}       -> find "VentisolScans"
//   GET /api/MasterData/GetRowsPaged/{tableId}?page&pageSize=500&Orderby=ScanTime&IsAscending=false
//
// Every response is wrapped in { data, errors, meta } and errors can arrive
// with HTTP 200, so errors[] is checked on every call. A 401 means the token
// expired between the page guard and the read: the caller sends the user
// through /auth/refresh, once (a second 401 right after a refresh ends the
// session instead of looping). A 403 means the user is signed in but may not
// read Ventisol's tables: refreshing would not change that, so it goes to
// /ingen-adgang.
//
// The scan rows are held once per account and table (sharedScans in
// lib/api-cache.ts), not once per user. So the user is checked first, on
// every read, with the user's own token: GetTables must list the scan table,
// and a one row GetRowsPaged must be answered (seeing a table in the list is
// not the same as being allowed to read its rows). Both answers are kept per
// user for a few minutes. Only then are shared rows handed out. A user
// OptiCloud refuses never gets them.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cachedJson, sharedScans } from "@/lib/api-cache";
import { ApiAccessError, ApiAuthError } from "@/lib/api-errors";
import { SESSION_COOKIES } from "@/lib/auth-cookies";
import { API_URL, refreshPath, type AuthContext } from "@/lib/auth";
import { fixturePageLoader } from "@/lib/fixtures";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import { PAGE_SIZE, readScansSince, type ReadResult, type RowsPage } from "@/lib/paging";
import { SCAN_TABLE_NAME, type MasterDataRow } from "@/lib/scans";

export { ApiAccessError, ApiAuthError };

/** Where a refused read sends the user. */
export const NO_ACCESS_PATH = "/ingen-adgang";

/**
 * How long reads stay in process memory (lib/api-cache.ts). Today keeps
 * changing, so its window is short; past days are settled.
 */
export const CACHE_SECONDS = {
  today: 30,
  past: 300,
  tables: 300,
} as const;

/** Longest a single call to the API may take before it is given up. */
export const API_TIMEOUT_MS = 20_000;

interface Envelope<T> {
  data: T;
  errors?: unknown[] | null;
}

function describeErrors(errors: unknown[]): string {
  return errors
    .map((e) =>
      typeof e === "string"
        ? e
        : e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : JSON.stringify(e)
    )
    .join("; ");
}

async function apiGet<T>(token: string, path: string): Promise<{ value: T; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      // Freshness is the memory cache's job; see lib/api-cache.ts.
      cache: "no-store",
      // Covers the body too: a call that hangs ends here instead of holding
      // the page, and everyone waiting on the same read, forever.
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Optipeople API ${path} unreachable:`, err);
    throw new Error("Optipeople API kunne ikke nås.");
  }
  if (res.status === 401) throw new ApiAuthError(`${path}: 401`);
  if (res.status === 403) throw new ApiAccessError(`${path}: 403`);
  if (!res.ok) throw new Error(`Optipeople API ${path} failed: ${res.status} ${res.statusText}`);

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    console.error(`Optipeople API ${path} gave up mid-answer:`, err);
    throw new Error("Optipeople API kunne ikke nås.");
  }
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`Optipeople API ${path} returned something that is not JSON.`);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`Optipeople API ${path} returned errors: ${describeErrors(body.errors)}`);
  }
  return { value: body.data, bytes: text.length };
}

interface TableInfo {
  id: string;
  name?: string | null;
  friendlyName?: string | null;
}

function asTableList(data: unknown): TableInfo[] {
  if (Array.isArray(data)) return data as TableInfo[];
  if (data && typeof data === "object") {
    for (const key of ["tables", "items", "rows"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as TableInfo[];
    }
  }
  return [];
}

/**
 * Id of the VentisolScans table, matched by name case-insensitively. This is
 * also the first half of the access check for the shared scan rows: it is
 * asked with the user's own token, so a 401 or 403 here stops the read before
 * any row is served. checkRowAccess is the second half.
 */
// Cached per user, not per account: what a token may read is decided by OptiCloud, so one user's
// read must never be served to another whose token would be refused.
async function getScanTableId(ctx: AuthContext): Promise<string> {
  const find = async (includeHidden: boolean) => {
    const path = `/api/MasterData/GetTables/${encodeURIComponent(ctx.accountId)}${includeHidden ? "?includeHidden=true" : ""}`;
    const tables = await cachedJson(`${ctx.user.id}|${path}`, CACHE_SECONDS.tables, () =>
      apiGet<unknown>(ctx.token, path)
    );
    return asTableList(tables).find(
      (t) => t.name?.toLowerCase() === SCAN_TABLE_NAME.toLowerCase()
    );
  };
  const table = (await find(false)) ?? (await find(true));
  if (!table) {
    throw new Error(
      `Tabellen ${SCAN_TABLE_NAME} findes ikke på kontoen endnu. Station-appen opretter den ved første forbindelse.`
    );
  }
  return table.id;
}

/**
 * The second half of the access check: one row of the scan table, asked for
 * with the user's own token. A user who may list the account's tables but not
 * read this one's rows is refused here (401 or 403), before any shared row is
 * served. Kept per user as long as the table lookup, so it costs one small
 * request per user per CACHE_SECONDS.tables. Only "it was answered" is kept,
 * not the row.
 */
async function checkRowAccess(ctx: AuthContext, tableId: string): Promise<void> {
  const qs = new URLSearchParams({ page: "1", pageSize: "1", Orderby: "ScanTime", IsAscending: "false" });
  const path = `/api/MasterData/GetRowsPaged/${encodeURIComponent(tableId)}?${qs}`;
  await cachedJson(`${ctx.user.id}|${path}`, CACHE_SECONDS.tables, async () => {
    await apiGet<unknown>(ctx.token, path);
    return { value: true, bytes: 1 };
  });
}

interface PagedRows {
  rows?: MasterDataRow[] | null;
  count?: number | null;
  totalPage?: number | null;
}

function apiPageLoader(ctx: AuthContext, tableId: string): (page: number) => Promise<RowsPage> {
  return async (page) => {
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      Orderby: "ScanTime",
      IsAscending: "false",
    });
    const { value } = await apiGet<PagedRows>(
      ctx.token,
      `/api/MasterData/GetRowsPaged/${encodeURIComponent(tableId)}?${qs}`
    );
    return { rows: value?.rows ?? [], totalPage: value?.totalPage ?? null };
  };
}

/**
 * All scans from `since` until now, no older than `ttlSeconds`. The rows come
 * from the copy shared by everyone on the account, after this user has been
 * checked against the account's tables and the table's rows; only what is missing or too old is
 * read from OptiCloud, with this user's token.
 */
export async function loadScansSince(
  ctx: AuthContext,
  since: number,
  ttlSeconds: number,
  now: number
): Promise<ReadResult> {
  if (fixturesEnabled()) {
    return readScansSince(fixturePageLoader(now), since);
  }
  try {
    // The access check. It comes first and runs for every user and every
    // read: a hit in the shared rows must never skip it. The table must be
    // in this user's list, and this user must be able to read a row of it.
    const tableId = await getScanTableId(ctx);
    await checkRowAccess(ctx, tableId);
    const loadPage = apiPageLoader(ctx, tableId);
    return await sharedScans(`${ctx.accountId}|${tableId}`, since, ttlSeconds, async (from) => {
      const result = await readScansSince(loadPage, from);
      if (result.unordered) {
        console.warn("GetRowsPaged ignored Orderby=ScanTime; read every page.");
      }
      return result;
    });
  } catch (err) {
    if (err instanceof ApiAccessError) redirect(NO_ACCESS_PATH);
    if (err instanceof ApiAuthError) {
      // Refused again within a minute of a refresh: the new token does not
      // help either, so /auth/refresh ends the session rather than loop.
      const store = await cookies();
      const justRefreshed = Boolean(store.get(SESSION_COOKIES.refreshed)?.value);
      redirect(refreshPath(ctx.currentPath, justRefreshed));
    }
    throw err;
  }
}
