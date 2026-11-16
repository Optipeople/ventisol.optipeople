// The service login the sync jobs read OptiCloud with.
//
// Env: OPTICLOUD_SERVICE_USER, OPTICLOUD_SERVICE_PASSWORD, and
// VENTISOL_ACCOUNT_ID (the account whose lists are read). Any of them missing
// is a normal state ("not_configured"), not an error.
//
// Tokens. A cron run every minute must not log in every minute, so the token
// is kept in two places:
//   1. process memory (a warm serverless instance),
//   2. app.sync_private, row "opticloud_token": service only, no policy and
//      no grant, so no portal user can read it. A cold instance starts there.
// A token is used until it is refused (401) or its expires_in has passed;
// then the refresh token is tried (grant_type=refresh_token with username),
// and the password only when that is refused too.
//
// A rejected password. Every wrong try counts towards locking the account
// out, so after one rejected password login nothing tries again for 15
// minutes, on any instance: the backoff is a row in app.sync_private. It is
// tied to the user name and API address, so changing either tries at once.
// After correcting only the password, wait out the 15 minutes (or delete the
// row "opticloud_login_backoff").
//
// Nothing here logs a token, a password or a blob link.
//
// The functions of this module open their own service transactions: never
// call them from inside withService or withUser.

import { API_URL, optipeopleLogin, ventisolAccountId, type LoginResponse } from "@/lib/auth";
import { withService } from "@/lib/db";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import { PAGE_SIZE } from "@/lib/paging";
import type { MasterDataRow } from "@/lib/scans";
import { deletePrivate, getPrivate, PRIVATE, setPrivate } from "./state";

/** The OptiCloud list of order PDFs (docs/order-documents.md). */
export const DOCUMENT_TABLE_NAME = "VentisolOrderDocuments";

/** How long no login is tried after the password was rejected. */
export const LOGIN_BACKOFF_MS = 15 * 60_000;

/** A token is taken as expired this long before OptiCloud says it is. */
const EXPIRY_SLACK_MS = 60_000;

/** Longest wait for one JSON answer, and for one file. */
const JSON_TIMEOUT_MS = 20_000;
const BLOB_TIMEOUT_MS = 30_000;

/** How long a table id is remembered in this process. */
const TABLE_ID_TTL_MS = 10 * 60_000;

export interface SourcePage {
  rows: MasterDataRow[];
  /** Total pages, when the API says. */
  totalPage: number | null;
  /** Total rows, when the API says. */
  count: number | null;
}

export interface PageQuery {
  /** Column to sort by. */
  orderBy?: string;
  ascending?: boolean;
  pageSize?: number;
}

/** What the sync jobs need from OptiCloud. The real client, the fixture source and the test fakes all are one. */
export interface OptiCloudSource {
  /** The id of a master-data table by name (case-insensitive), null when the account has none. */
  findTableId(name: string): Promise<string | null>;
  /** One page of GetRowsPaged, pages counted from 1. */
  loadRowsPage(tableId: string, page: number, query?: PageQuery): Promise<SourcePage>;
  /** The bytes of a file in a Blob column. Throws BlobTooLargeError over `maxBytes`. */
  getBlob(reference: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * True when the document list of this source is not the whole truth, so a
   * stored document it does not hold must stay. Fixture mode sets it: the
   * fixture database also holds made-up documents that come from no list.
   */
  partialDocumentList?: boolean;
}

export type ServiceAccess =
  | { status: "ok"; source: OptiCloudSource }
  | { status: "not_configured"; missing: string[] }
  /** The password was rejected. No login is tried before `retryAt` (epoch ms). */
  | { status: "login_backoff"; retryAt: number }
  | { status: "unavailable"; message: string };

/** OptiCloud refused the service login, or is in the 15 minutes after it did. */
export class ServiceLoginError extends Error {
  constructor(readonly retryAt: number) {
    super("OptiCloud rejected the service login.");
    this.name = "ServiceLoginError";
  }
}

/** OptiCloud could not be reached, or answered with something unusable. */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export class BlobTooLargeError extends Error {
  constructor(readonly bytes: number | null) {
    super("The file is larger than the limit.");
    this.name = "BlobTooLargeError";
  }
}

export interface ServiceConfig {
  user: string;
  password: string;
  accountId: string;
}

/** The service account from the environment, or the names of what is missing. */
export function serviceConfig(): { ok: true; config: ServiceConfig } | { ok: false; missing: string[] } {
  const user = process.env.OPTICLOUD_SERVICE_USER?.trim() ?? "";
  const password = process.env.OPTICLOUD_SERVICE_PASSWORD ?? "";
  const accountId = ventisolAccountId() ?? "";
  const missing = [
    !user && "OPTICLOUD_SERVICE_USER",
    !password && "OPTICLOUD_SERVICE_PASSWORD",
    !accountId && "VENTISOL_ACCOUNT_ID",
  ].filter((name): name is string => typeof name === "string");
  return missing.length > 0 ? { ok: false, missing } : { ok: true, config: { user, password, accountId } };
}

/** True when the sync has something to read: the service account is set, or fixture mode is on. */
export function syncConfigured(): boolean {
  return fixturesEnabled() || serviceConfig().ok;
}

// --- the token ---

interface StoredToken {
  /** Who and where the token is for: a changed user or address must not reuse it. */
  user: string;
  apiUrl: string;
  accessToken: string;
  refreshToken: string | null;
  /** Name to send with the refresh grant. */
  userName: string;
  /** Epoch ms, null when OptiCloud gave no lifetime. */
  expiresAt: number | null;
}

interface StoredBackoff {
  user: string;
  apiUrl: string;
  rejectedAt: number;
}

interface Memory {
  token: StoredToken | null;
  tables: Map<string, { id: string; at: number }>;
}

// On globalThis, like the pool in lib/db: `next dev` evaluates modules again
// on every hot reload, and a module variable would forget the token each time.
const memoryKey = Symbol.for("ventisol.sync.opticloud");
const memoryStore = globalThis as unknown as { [memoryKey]?: Memory };

function memory(): Memory {
  return (memoryStore[memoryKey] ??= { token: null, tables: new Map() });
}

/** Forgets what this process remembers (the token, table ids). For tests, which play a cold instance. */
export function resetServiceMemory(): void {
  memory().token = null;
  memory().tables.clear();
}

const sameAccount = (t: { user: string; apiUrl: string }, config: ServiceConfig) =>
  t.user === config.user.toLowerCase() && t.apiUrl === API_URL;

function usable(token: StoredToken | null, config: ServiceConfig, now: number, refused: string | null): boolean {
  return (
    token !== null &&
    sameAccount(token, config) &&
    token.accessToken !== refused &&
    (token.expiresAt === null || token.expiresAt > now)
  );
}

function toStored(config: ServiceConfig, data: LoginResponse, now: number, previous: StoredToken | null): StoredToken {
  const lifetime = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in * 1000 : null;
  return {
    user: config.user.toLowerCase(),
    apiUrl: API_URL,
    accessToken: data.access_token,
    // A refresh answer may leave the refresh token out: the old one stays.
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
    userName: data.user_name ?? previous?.userName ?? config.user,
    expiresAt: lifetime === null ? null : now + Math.max(lifetime - EXPIRY_SLACK_MS, lifetime / 2),
  };
}

/**
 * A bearer token for the service account. `refused` is a token OptiCloud
 * just answered 401 to: it is never handed back. Throws ServiceLoginError or
 * ServiceUnavailableError.
 */
async function acquireToken(config: ServiceConfig, now: number, refused: string | null): Promise<string> {
  const mem = memory();
  if (mem.token && usable(mem.token, config, now, refused)) return mem.token.accessToken;

  const { stored, backoff } = await withService(async (db) => ({
    stored: (await getPrivate<StoredToken>(db, PRIVATE.token))?.value ?? null,
    backoff: await getPrivate<StoredBackoff>(db, PRIVATE.loginBackoff),
  }));

  // Another instance may have logged in already.
  if (stored && usable(stored, config, now, refused)) {
    mem.token = stored;
    return stored.accessToken;
  }

  const save = async (token: StoredToken) => {
    mem.token = token;
    await withService(async (db) => {
      await setPrivate(db, PRIVATE.token, token);
      await deletePrivate(db, PRIVATE.loginBackoff);
    });
    return token.accessToken;
  };

  // The refresh token first: it costs no password try.
  const previous = stored && sameAccount(stored, config) ? stored : null;
  if (previous?.refreshToken) {
    const refreshed = await optipeopleLogin({
      grant_type: "refresh_token",
      username: previous.userName,
      refresh_token: previous.refreshToken,
    });
    if (refreshed.ok) return save(toStored(config, refreshed.data, now, previous));
    if (refreshed.reason === "unavailable") {
      throw new ServiceUnavailableError("OptiCloud could not be reached for the token refresh.");
    }
    // Refused: the refresh token is dead too. On to the password.
  }

  if (
    backoff &&
    sameAccount(backoff.value, config) &&
    backoff.expiresAt !== null &&
    backoff.expiresAt.getTime() > now
  ) {
    throw new ServiceLoginError(backoff.expiresAt.getTime());
  }

  const login = await optipeopleLogin({
    grant_type: "password",
    username: config.user,
    password: config.password,
  });
  if (login.ok) return save(toStored(config, login.data, now, null));
  if (login.reason === "unavailable") {
    throw new ServiceUnavailableError("OptiCloud could not be reached for the login.");
  }

  const retryAt = now + LOGIN_BACKOFF_MS;
  mem.token = null;
  await withService(async (db) => {
    await deletePrivate(db, PRIVATE.token);
    const value: StoredBackoff = { user: config.user.toLowerCase(), apiUrl: API_URL, rejectedAt: now };
    await setPrivate(db, PRIVATE.loginBackoff, value, retryAt);
  });
  throw new ServiceLoginError(retryAt);
}

// --- the client ---

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

interface TableInfo {
  id: string;
  name?: string | null;
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

interface PagedRows {
  rows?: MasterDataRow[] | null;
  count?: number | null;
  totalPage?: number | null;
}

function createClient(config: ServiceConfig, firstToken: string, now: number): OptiCloudSource {
  let token = firstToken;

  /** One GET with the token. A 401 gets one new token and one more try. */
  async function send(path: string, accept: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API_URL}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // The cause can hold the request, and so the token: not logged.
        throw new ServiceUnavailableError(`OptiCloud could not be reached (${path.split("?")[0]}).`);
      }
      if (res.status === 401 && attempt === 0) {
        token = await acquireToken(config, now, token);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`OptiCloud refused the service account (${res.status}) on ${path.split("?")[0]}.`);
      }
      if (!res.ok) {
        throw new Error(`OptiCloud ${path.split("?")[0]} failed: ${res.status}.`);
      }
      return res;
    }
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await send(path, "application/json", JSON_TIMEOUT_MS);
    let body: Envelope<T>;
    try {
      body = JSON.parse(await res.text()) as Envelope<T>;
    } catch {
      throw new Error(`OptiCloud ${path.split("?")[0]} returned something that is not JSON.`);
    }
    // Errors can arrive with HTTP 200.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new Error(`OptiCloud ${path.split("?")[0]} returned errors: ${describeErrors(body.errors)}`);
    }
    return body?.data;
  }

  return {
    async findTableId(name) {
      const key = `${config.accountId}|${name.toLowerCase()}`;
      const known = memory().tables.get(key);
      if (known && Date.now() - known.at < TABLE_ID_TTL_MS) return known.id;
      for (const hidden of [false, true]) {
        const path = `/api/MasterData/GetTables/${encodeURIComponent(config.accountId)}${hidden ? "?includeHidden=true" : ""}`;
        const table = asTableList(await getJson<unknown>(path)).find(
          (t) => t.name?.toLowerCase() === name.toLowerCase()
        );
        if (table) {
          memory().tables.set(key, { id: table.id, at: Date.now() });
          return table.id;
        }
      }
      return null;
    },

    async loadRowsPage(tableId, page, query = {}) {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(query.pageSize ?? PAGE_SIZE) });
      if (query.orderBy) {
        qs.set("Orderby", query.orderBy);
        qs.set("IsAscending", String(query.ascending ?? false));
      }
      const value = await getJson<PagedRows | null>(
        `/api/MasterData/GetRowsPaged/${encodeURIComponent(tableId)}?${qs}`
      );
      return {
        rows: Array.isArray(value?.rows) ? value.rows : [],
        totalPage: typeof value?.totalPage === "number" && value.totalPage > 0 ? value.totalPage : null,
        count: typeof value?.count === "number" ? value.count : null,
      };
    },

    async getBlob(reference, maxBytes) {
      const res = await send(
        `/api/MasterDataBlob/Get?${new URLSearchParams({ path: reference })}`,
        "*/*",
        BLOB_TIMEOUT_MS
      );
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new BlobTooLargeError(declared);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        throw new ServiceUnavailableError("OptiCloud gave up in the middle of a file.");
      }
      if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(bytes.byteLength);
      return bytes;
    },
  };
}

/**
 * The OptiCloud the sync reads, or why there is none right now. Never
 * throws for the expected states: not configured, password rejected,
 * OptiCloud down. In fixture mode the "OptiCloud" is the fixture rows.
 */
export async function getOptiCloud(now: number): Promise<ServiceAccess> {
  if (fixturesEnabled()) {
    const { fixtureSource } = await import("./fixture-source");
    return { status: "ok", source: fixtureSource(now) };
  }
  const env = serviceConfig();
  if (!env.ok) return { status: "not_configured", missing: env.missing };
  try {
    const token = await acquireToken(env.config, now, null);
    return { status: "ok", source: createClient(env.config, token, now) };
  } catch (err) {
    if (err instanceof ServiceLoginError) return { status: "login_backoff", retryAt: err.retryAt };
    if (err instanceof ServiceUnavailableError) return { status: "unavailable", message: err.message };
    throw err;
  }
}
