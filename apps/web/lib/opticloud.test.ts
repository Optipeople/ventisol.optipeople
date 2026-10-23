import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What a refused read does: 403 goes to a page that says so (no refresh), a
// 401 goes through /auth/refresh once, and a 401 right after a refresh ends
// the session instead of looping.

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

const { loadScansSince, NO_ACCESS_PATH } = await import("@/lib/opticloud");
const { SESSION_COOKIES } = await import("@/lib/auth-cookies");

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
