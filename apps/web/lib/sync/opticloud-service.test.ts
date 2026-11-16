// The service client against a fake OptiCloud HTTP API (global fetch is
// replaced, nothing reaches the network).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";

const applyScanChanges = vi.fn(async () => ({ orders: 0, stationDays: 0 }));
vi.mock("@/lib/readmodel", () => ({
  applyScanChanges: () => applyScanChanges(),
  applyDocumentChanges: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
  rebuildAll: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
}));

import { getOptiCloud, LOGIN_BACKOFF_MS, resetServiceMemory } from "./opticloud-service";
import { runScanSync } from "./scans";
import { getPrivate, JOBS, PRIVATE, readState } from "./state";
import { HOUR, NOW, scanRow } from "./test-fakes";

const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const PASSWORD = "correct horse battery";

let db: TestDb;

/** The fake API: what it accepts, and what it was asked. */
const api = {
  password: PASSWORD,
  /** Access tokens it answers 200 to. */
  valid: new Set<string>(),
  refreshTokens: new Set<string>(),
  issued: 0,
  expiresIn: undefined as number | undefined,
  down: false,
  logins: [] as Record<string, string>[],
  gets: [] as { path: string; token: string }[],
  rows: [scanRow(NOW - HOUR, {}, "http-1"), scanRow(NOW - 2 * HOUR, {}, "http-2")],
};

function issue() {
  const n = ++api.issued;
  api.valid.add(`access-${n}`);
  api.refreshTokens.add(`refresh-${n}`);
  return {
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    user_name: "sync@ventisol.dk",
    ...(api.expiresIn === undefined ? {} : { expires_in: api.expiresIn }),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (api.down) throw new TypeError("fetch failed");
  const url = new URL(String(input));
  if (url.pathname === "/api/Authentication/login") {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    api.logins.push(body);
    if (body.grant_type === "password") {
      return body.password === api.password ? json(issue()) : json({ error: "invalid_grant" }, 400);
    }
    if (body.grant_type === "refresh_token" && body.username && api.refreshTokens.delete(body.refresh_token)) {
      return json(issue());
    }
    return json({ error: "invalid_grant" }, 400);
  }
  const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  api.gets.push({ path: url.pathname, token });
  if (!api.valid.has(token)) return new Response("", { status: 401 });
  if (url.pathname.startsWith("/api/MasterData/GetTables/")) {
    return json({ data: [{ id: "t-scans", name: "VentisolScans" }], errors: [] });
  }
  if (url.pathname.startsWith("/api/MasterData/GetRowsPaged/")) {
    const page = Number(url.searchParams.get("page"));
    return json({ data: { rows: page === 1 ? api.rows : [], count: api.rows.length, totalPage: 1 }, errors: [] });
  }
  if (url.pathname === "/api/MasterDataBlob/Get") {
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }
  return json({ data: null, errors: ["Unknown path"] });
}

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  resetServiceMemory();
  applyScanChanges.mockClear();
  Object.assign(api, { password: PASSWORD, issued: 0, expiresIn: undefined, down: false, logins: [], gets: [] });
  api.valid.clear();
  api.refreshTokens.clear();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubEnv("VENTISOL_FIXTURES", "");
  vi.stubEnv("OPTICLOUD_SERVICE_USER", "Sync@Ventisol.dk");
  vi.stubEnv("OPTICLOUD_SERVICE_PASSWORD", PASSWORD);
  vi.stubEnv("VENTISOL_ACCOUNT_ID", ACCOUNT);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

const passwordLogins = () => api.logins.filter((l) => l.grant_type === "password").length;

describe("not configured", () => {
  it("is a recorded state, not an error: nothing thrown, nothing fetched, nothing logged", async () => {
    vi.stubEnv("OPTICLOUD_SERVICE_PASSWORD", "");
    const access = await getOptiCloud(NOW);
    expect(access).toEqual({ status: "not_configured", missing: ["OPTICLOUD_SERVICE_PASSWORD"] });

    const result = await runScanSync({ now: NOW });
    expect(result.status).toBe("not_configured");
    const state = await db.withService((q) => readState(q, JOBS.scans));
    expect(state?.detail).toMatchObject({
      status: "not_configured",
      configured: false,
      missingEnv: ["OPTICLOUD_SERVICE_PASSWORD"],
    });
    expect(state?.lastError).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(applyScanChanges).not.toHaveBeenCalled();
  });

  it("names every missing variable", async () => {
    vi.stubEnv("OPTICLOUD_SERVICE_USER", "");
    vi.stubEnv("VENTISOL_ACCOUNT_ID", "");
    const access = await getOptiCloud(NOW);
    expect(access).toEqual({
      status: "not_configured",
      missing: ["OPTICLOUD_SERVICE_USER", "VENTISOL_ACCOUNT_ID"],
    });
  });
});

describe("the service login", () => {
  it("logs in with the password grant and reads through the client", async () => {
    const access = await getOptiCloud(NOW);
    expect(access.status).toBe("ok");
    expect(api.logins).toEqual([{ grant_type: "password", username: "Sync@Ventisol.dk", password: PASSWORD }]);

    const result = await runScanSync({ now: NOW, access });
    expect(result).toMatchObject({ status: "ok", inserted: 2 });
    expect(api.gets.every((g) => g.token === "access-1")).toBe(true);
  });

  it("reuses the token across instances: a cold process finds it in the database", async () => {
    await getOptiCloud(NOW);
    await getOptiCloud(NOW + 60_000);
    expect(passwordLogins()).toBe(1);

    // A new serverless instance: nothing in memory.
    resetServiceMemory();
    const access = await getOptiCloud(NOW + 120_000);
    expect(access.status).toBe("ok");
    expect(api.logins).toHaveLength(1);
    if (access.status === "ok") {
      expect(await access.source.findTableId("ventisolscans")).toBe("t-scans");
    }
    expect(api.gets.at(-1)?.token).toBe("access-1");
  });

  it("keeps the token where no portal user can read it", async () => {
    await getOptiCloud(NOW);
    const stored = await db.withService((q) => getPrivate<{ accessToken: string }>(q, PRIVATE.token));
    expect(stored?.value.accessToken).toBe("access-1");

    await expect(
      db.withUser(testClaims("admin"), (q) => q.query("select * from app.sync_private"))
    ).rejects.toThrow();
    // And nothing of it in the table an admin can read.
    await runScanSync({ now: NOW });
    const visible = await db.withUser(testClaims("admin"), (q) => q.query("select * from app.sync_state"));
    expect(JSON.stringify(visible)).not.toContain("access-1");
    expect(JSON.stringify(visible)).not.toContain("refresh-1");
    expect(JSON.stringify(visible)).not.toContain(PASSWORD);
  });

  it("refreshes with the refresh grant and the user name when the token is refused", async () => {
    const access = await getOptiCloud(NOW);
    api.valid.clear(); // OptiCloud forgot the token.
    if (access.status !== "ok") throw new Error("no access");
    expect(await access.source.findTableId("VentisolScans")).toBe("t-scans");

    expect(api.logins[1]).toEqual({
      grant_type: "refresh_token",
      username: "sync@ventisol.dk",
      refresh_token: "refresh-1",
    });
    expect(passwordLogins()).toBe(1);
    expect(api.gets.map((g) => g.token)).toEqual(["access-1", "access-2"]);
    const stored = await db.withService((q) => getPrivate<{ accessToken: string }>(q, PRIVATE.token));
    expect(stored?.value.accessToken).toBe("access-2");
  });

  it("falls back to the password when the refresh token is dead too", async () => {
    const access = await getOptiCloud(NOW);
    api.valid.clear();
    api.refreshTokens.clear();
    if (access.status !== "ok") throw new Error("no access");
    expect(await access.source.findTableId("VentisolScans")).toBe("t-scans");
    expect(api.logins.map((l) => l.grant_type)).toEqual(["password", "refresh_token", "password"]);
  });

  it("refreshes a token whose lifetime has passed before using it", async () => {
    api.expiresIn = 3600;
    await getOptiCloud(NOW);
    await getOptiCloud(NOW + 30 * 60_000);
    expect(api.logins).toHaveLength(1);
    await getOptiCloud(NOW + 2 * HOUR);
    expect(api.logins.map((l) => l.grant_type)).toEqual(["password", "refresh_token"]);
  });

  it("does not reuse a token stored for another user", async () => {
    await getOptiCloud(NOW);
    resetServiceMemory();
    vi.stubEnv("OPTICLOUD_SERVICE_USER", "other@ventisol.dk");
    await getOptiCloud(NOW + 60_000);
    expect(api.logins.map((l) => l.grant_type)).toEqual(["password", "password"]);
    expect(api.logins[1].username).toBe("other@ventisol.dk");
  });

  it("reports an unreachable OptiCloud without a backoff", async () => {
    api.down = true;
    const access = await getOptiCloud(NOW);
    expect(access.status).toBe("unavailable");
    expect(await db.withService((q) => getPrivate(q, PRIVATE.loginBackoff))).toBeNull();

    const result = await runScanSync({ now: NOW, access });
    expect(result.status).toBe("unavailable");
  });
});

describe("a rejected password", () => {
  beforeEach(() => {
    api.password = "something else";
  });

  it("waits 15 minutes before trying again, on any instance", async () => {
    const first = await getOptiCloud(NOW);
    expect(first).toEqual({ status: "login_backoff", retryAt: NOW + LOGIN_BACKOFF_MS });
    expect(passwordLogins()).toBe(1);

    // Same instance, and a cold one: no further try.
    expect((await getOptiCloud(NOW + 60_000)).status).toBe("login_backoff");
    resetServiceMemory();
    const again = await getOptiCloud(NOW + 14 * 60_000);
    expect(again).toEqual({ status: "login_backoff", retryAt: NOW + LOGIN_BACKOFF_MS });
    expect(passwordLogins()).toBe(1);

    // After the wait: one more try.
    const later = await getOptiCloud(NOW + LOGIN_BACKOFF_MS + 1000);
    expect(later.status).toBe("login_backoff");
    expect(passwordLogins()).toBe(2);
  });

  it("is recorded on the job with the time of the next try, and without noise", async () => {
    const result = await runScanSync({ now: NOW });
    expect(result.status).toBe("login_backoff");
    const state = await db.withService((q) => readState(q, JOBS.scans));
    expect(state?.detail).toMatchObject({
      status: "login_backoff",
      retryAt: new Date(NOW + LOGIN_BACKOFF_MS).toISOString(),
    });
    expect(state?.lastError).toEqual(expect.any(String));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is over at once when the password is corrected after the wait, and clears the backoff", async () => {
    await getOptiCloud(NOW);
    api.password = PASSWORD;
    expect((await getOptiCloud(NOW + 60_000)).status).toBe("login_backoff");
    expect((await getOptiCloud(NOW + LOGIN_BACKOFF_MS + 1)).status).toBe("ok");
    expect(await db.withService((q) => getPrivate(q, PRIVATE.loginBackoff))).toBeNull();
  });

  it("does not hold back another user name", async () => {
    await getOptiCloud(NOW);
    api.password = PASSWORD;
    vi.stubEnv("OPTICLOUD_SERVICE_USER", "other@ventisol.dk");
    expect((await getOptiCloud(NOW + 60_000)).status).toBe("ok");
  });
});

describe("the client", () => {
  it("fetches a file and refuses one over the limit", async () => {
    const access = await getOptiCloud(NOW);
    if (access.status !== "ok") throw new Error("no access");
    expect(await access.source.getBlob("masterdata/a/b/c.pdf", 100)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(access.source.getBlob("masterdata/a/b/c.pdf", 3)).rejects.toThrow("larger than the limit");
  });

  it("keeps query strings (file references) out of error messages", async () => {
    const access = await getOptiCloud(NOW);
    if (access.status !== "ok") throw new Error("no access");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    );
    await expect(access.source.getBlob("masterdata/secret/ref.pdf", 100)).rejects.toThrow(
      /^OptiCloud \/api\/MasterDataBlob\/Get failed: 500\.$/
    );
  });
});
