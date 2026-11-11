import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What a refused read does: 403 goes to a page that says so (no refresh), a
// 401 goes through /auth/refresh once, and a 401 right after a refresh ends
// the session instead of looping. And who may read the shared scan rows.

const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

vi.mock("@/lib/fixtures-flag", () => ({ fixturesEnabled: () => false, FIXTURE_USER: {} }));

const { API_TIMEOUT_MS, loadScansSince, NO_ACCESS_PATH } = await import("@/lib/opticloud");
const { SESSION_COOKIES } = await import("@/lib/auth-cookies");
const { clearApiCache } = await import("@/lib/api-cache");

let since = 0;

async function readWith(status: number): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
  // A new `since` (and account) each time, so the memory cache never answers.
  since++;
  const ctx = { user: {} as never, token: "t", accountId: `acc${since}`, currentPath: "/periode?fra=2026-10-01" };
  try {
    await loadScansSince(ctx, since, 30, Date.now());
  } catch (err) {
    if (err instanceof Redirect) return err.to;
    throw err;
  }
  throw new Error("expected a redirect");
}

describe("a refused read", () => {
  beforeEach(() => cookieJar.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("goes to the no-access page on 403, without a refresh", async () => {
    expect(await readWith(403)).toBe(NO_ACCESS_PATH);
  });

  it("goes through the refresh flow on 401", async () => {
    expect(await readWith(401)).toBe(`/auth/refresh?next=${encodeURIComponent("/periode?fra=2026-10-01")}`);
  });

  it("asks the refresh flow to end the session on a 401 right after a refresh", async () => {
    cookieJar.set(SESSION_COOKIES.refreshed, "1");
    expect(await readWith(401)).toBe(
      `/auth/refresh?next=${encodeURIComponent("/periode?fra=2026-10-01")}&retry=1`
    );
  });
});

// ---------------------------------------------------------------------------
// A small OptiCloud: one account with the scan table, and who may read it.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 21, 12);
const HOUR = 3_600_000;
const TABLE_ID = "7b0c3c0e-1111-4222-8333-444455556666";

interface Call {
  token: string;
  path: string;
}

/** The access check's one row read, as opposed to a read of the rows themselves. */
const isProbe = (path: string) => path.includes("/GetRowsPaged/") && /[?&]pageSize=1(&|$)/.test(path);

function opticloud(
  opts: { refused?: string[]; rowsRefused?: string[]; tableId?: string; rows?: number } = {}
) {
  const calls: Call[] = [];
  const rows = Array.from({ length: opts.rows ?? 3 }, (_, i) => ({
    id: `row${i}`,
    values: {
      ScanId: `scan${i}`,
      Barcode: "058556050103",
      Station: "Station 10",
      StationNo: 1,
      Direction: i % 2 ? "In" : "Out",
      ScanTime: new Date(NOW - (i + 1) * HOUR).toISOString(),
    },
  }));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ token, path });
    if (opts.refused?.includes(token)) return new Response("{}", { status: 403 });
    if (path.includes("/GetTables/")) {
      return Response.json({ data: [{ id: opts.tableId ?? TABLE_ID, name: "ventisolscans" }], errors: [] });
    }
    // May list the tables, but not read rows.
    if (opts.rowsRefused?.includes(token)) return new Response("{}", { status: 403 });
    if (isProbe(path)) return Response.json({ data: { rows: rows.slice(0, 1), totalPage: rows.length }, errors: null });
    return Response.json({ data: { rows, totalPage: 1 }, errors: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    tables: () => calls.filter((c) => c.path.includes("/GetTables/")),
    probes: () => calls.filter((c) => isProbe(c.path)),
    rowReads: () => calls.filter((c) => c.path.includes("/GetRowsPaged/") && !isProbe(c.path)),
  };
}

const user = (id: string, accountId = "ventisol") => ({
  user: { id } as never,
  token: `token-${id}`,
  accountId,
  currentPath: "/",
});

async function outcome(read: Promise<unknown>): Promise<unknown> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof Redirect) return err.to;
    throw err;
  }
}

describe("the shared scan rows", () => {
  const SINCE = NOW - 12 * HOUR;

  beforeEach(() => {
    cookieJar.clear();
    clearApiCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("are read once and served to the next user, after that user's own access check", async () => {
    const api = opticloud();
    const a = await loadScansSince(user("anna"), SINCE, 30, NOW);
    const b = await loadScansSince(user("bo"), SINCE, 30, NOW + 1000);
    expect(a.scans).toHaveLength(3);
    expect(b.scans.map((s) => s.id)).toEqual(a.scans.map((s) => s.id));
    // One read of the rows, with the first user's token.
    expect(api.rowReads().map((c) => c.token)).toEqual(["token-anna"]);
    // But each user was checked against the account's tables with their own token.
    expect(api.tables().map((c) => c.token)).toEqual(["token-anna", "token-bo"]);
    // And each read one row of the table with their own token.
    expect(api.probes().map((c) => c.token)).toEqual(["token-anna", "token-bo"]);
    expect(api.probes()[0].path).toBe(
      `/api/MasterData/GetRowsPaged/${TABLE_ID}?page=1&pageSize=1&Orderby=ScanTime&IsAscending=false`
    );
  });

  it("are never served to a user who may list the tables but not read rows, also when they are in memory", async () => {
    const api = opticloud({ rowsRefused: ["token-eve"] });
    await loadScansSince(user("anna"), SINCE, 30, NOW);
    const eve = await outcome(loadScansSince(user("eve"), SINCE, 30, NOW + 1000));
    expect(eve).toBe(NO_ACCESS_PATH);
    // The table list was answered; the one row read was refused, and that was the end of it.
    expect(api.calls.filter((c) => c.token === "token-eve").map((c) => c.path)).toEqual([
      "/api/MasterData/GetTables/ventisol",
      `/api/MasterData/GetRowsPaged/${TABLE_ID}?page=1&pageSize=1&Orderby=ScanTime&IsAscending=false`,
    ]);
    // A refusal is not remembered as an answer: she is refused again, by OptiCloud.
    expect(await outcome(loadScansSince(user("eve"), SINCE, 30, NOW + 2000))).toBe(NO_ACCESS_PATH);
    expect(api.probes().filter((c) => c.token === "token-eve")).toHaveLength(2);
  });

  it("asks for the one row again once the access check is too old", async () => {
    const api = opticloud();
    // The caches go by the clock, so the clock is moved.
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await loadScansSince(user("anna"), SINCE, 30, NOW);
      clock.mockReturnValue(NOW + 299_000);
      await loadScansSince(user("anna"), SINCE, 30, NOW + 299_000);
      expect(api.probes()).toHaveLength(1);
      clock.mockReturnValue(NOW + 300_000);
      await loadScansSince(user("anna"), SINCE, 30, NOW + 300_000);
      expect(api.probes()).toHaveLength(2);
      expect(api.tables()).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("are never served to a user OptiCloud refuses, also when they are already in memory", async () => {
    const api = opticloud({ refused: ["token-eve"] });
    await loadScansSince(user("anna"), SINCE, 30, NOW);
    const eve = await outcome(loadScansSince(user("eve"), SINCE, 30, NOW + 1000));
    expect(eve).toBe(NO_ACCESS_PATH);
    // Refused at the access check: no rows were asked for with that token either.
    expect(api.calls.filter((c) => c.token === "token-eve").map((c) => c.path)).toEqual([
      "/api/MasterData/GetTables/ventisol",
    ]);
  });

  it("do not let one user's access check stand in for another's", async () => {
    const api = opticloud({ refused: ["token-eve"] });
    // Many reads by a user with access, so every cache there is has been filled.
    await loadScansSince(user("anna"), SINCE, 30, NOW);
    await loadScansSince(user("anna"), SINCE, 300, NOW + 1000);
    expect(await outcome(loadScansSince(user("eve"), SINCE, 300, NOW + 2000))).toBe(NO_ACCESS_PATH);
    expect(api.tables().map((c) => c.token)).toEqual(["token-anna", "token-eve"]);
  });

  it("keeps a user's access check for a few minutes, so a hit costs no call at all", async () => {
    const api = opticloud();
    await loadScansSince(user("anna"), SINCE, 30, NOW);
    await loadScansSince(user("anna"), SINCE, 30, NOW + 1000);
    // The table list, the one row of the access check, and the rows: once each.
    expect(api.calls).toHaveLength(3);
  });

  it("are kept apart per account and table", async () => {
    const api = opticloud();
    await loadScansSince(user("anna", "ventisol"), SINCE, 30, NOW);
    await loadScansSince(user("carl", "another-account"), SINCE, 30, NOW);
    expect(api.rowReads().map((c) => c.token)).toEqual(["token-anna", "token-carl"]);
  });

  it("puts the account and table ids into the path encoded", async () => {
    const api = opticloud({ tableId: "a/b?c" });
    await loadScansSince(user("anna", "acc/../x"), SINCE, 30, NOW);
    expect(api.tables()[0].path).toBe("/api/MasterData/GetTables/acc%2F..%2Fx");
    expect(api.rowReads()[0].path).toMatch(/^\/api\/MasterData\/GetRowsPaged\/a%2Fb%3Fc\?page=1&/);
  });
});

describe("a call that hangs", () => {
  beforeEach(() => clearApiCache());
  afterEach(() => vi.unstubAllGlobals());

  it("gives every call to the API a time limit", async () => {
    const api = opticloud();
    await loadScansSince(user("anna"), NOW - HOUR, 30, NOW);
    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
    expect(api.fetchMock.mock.calls).toHaveLength(3);
    for (const [, init] of api.fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("fails with a message, and is not left behind for the next reader to wait on", async () => {
    // A call that is given up, as AbortSignal.timeout does it.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    const first = loadScansSince(user("anna"), NOW - HOUR, 30, NOW);
    const second = loadScansSince(user("anna"), NOW - HOUR, 30, NOW);
    await expect(first).rejects.toThrow("Optipeople API kunne ikke nås.");
    await expect(second).rejects.toThrow("Optipeople API kunne ikke nås.");
    quiet.mockRestore();

    // OptiCloud answers again: the next read gets through.
    opticloud();
    const result = await loadScansSince(user("anna"), NOW - HOUR, 30, NOW + 1000);
    expect(result.scans).toHaveLength(1);
  });
});
