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

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cachedJson } from "@/lib/api-cache";
import { SESSION_COOKIES } from "@/lib/auth-cookies";
import { API_URL, refreshPath, type AuthContext } from "@/lib/auth";
import { fixturePageLoader } from "@/lib/fixtures";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import { PAGE_SIZE, readScansSince, type ReadResult, type RowsPage } from "@/lib/paging";
import { SCAN_TABLE_NAME, type MasterDataRow } from "@/lib/scans";

/** 401, the token was refused: send the user through the refresh flow. */
export class ApiAuthError extends Error {}

/** 403, the token is fine but may not read this: no refresh, a clear page. */
export class ApiAccessError extends Error {}

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
    });
  } catch (err) {
    console.error(`Optipeople API ${path} unreachable:`, err);
    throw new Error("Optipeople API kunne ikke nås.");
  }
  if (res.status === 401) throw new ApiAuthError(`${path}: 401`);
  if (res.status === 403) throw new ApiAccessError(`${path}: 403`);
  if (!res.ok) throw new Error(`Optipeople API ${path} failed: ${res.status} ${res.statusText}`);

  const text = await res.text();
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

/** Id of the VentisolScans table, matched by name case-insensitively. */
async function getScanTableId(ctx: AuthContext): Promise<string> {
  const find = async (includeHidden: boolean) => {
    const path = `/api/MasterData/GetTables/${ctx.accountId}${includeHidden ? "?includeHidden=true" : ""}`;
    const tables = await cachedJson(`${ctx.accountId}|${path}`, CACHE_SECONDS.tables, () =>
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
      `/api/MasterData/GetRowsPaged/${tableId}?${qs}`
    );
    return { rows: value?.rows ?? [], totalPage: value?.totalPage ?? null };
  };
}

/**
 * All scans from `since` until now, newest first from the API, cached for
 * `ttlSeconds`. Callers keep `since` stable (a day start) so the cache hits.
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
    return await cachedJson(`${ctx.accountId}|scans|${since}`, ttlSeconds, async () => {
      const tableId = await getScanTableId(ctx);
      const result = await readScansSince(apiPageLoader(ctx, tableId), since);
      if (result.unordered) {
        console.warn("GetRowsPaged ignored Orderby=ScanTime; read every page.");
      }
      // Rough size for the cache budget: a parsed scan is a few hundred bytes.
      return { value: result, bytes: result.scans.length * 400 };
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
