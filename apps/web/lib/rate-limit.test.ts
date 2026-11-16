import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withService } from "@/lib/db";
import { createTestDb } from "@/lib/db/testing";
import {
  accountKey,
  allowAttempt,
  allowAttemptInDb,
  allowAttemptInMemory,
  attemptKey,
  clientIp,
  createAttemptLimits,
  createRateLimiter,
  dbKeys,
  forgetAccountAttempts,
  forgotLimits,
  loginLimits,
  resetLimits,
} from "@/lib/rate-limit";

const MINUTE = 60_000;

describe("createRateLimiter", () => {
  it("allows up to the limit, then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 10 * MINUTE });
    expect(limiter.hit("a", 0).ok).toBe(true);
    expect(limiter.hit("a", 1).ok).toBe(true);
    expect(limiter.hit("a", 2).ok).toBe(true);
    expect(limiter.hit("a", 3)).toEqual({ ok: false, retryAfterMs: 10 * MINUTE - 3 });
  });

  it("counts each key on its own", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
    expect(limiter.hit("a", 0).ok).toBe(true);
    expect(limiter.hit("b", 0).ok).toBe(true);
    expect(limiter.hit("a", 1).ok).toBe(false);
  });

  it("slides: a try is allowed again once the oldest one leaves the window", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: MINUTE });
    expect(limiter.hit("a", 0).ok).toBe(true);
    expect(limiter.hit("a", 30_000).ok).toBe(true);
    expect(limiter.hit("a", 59_999).ok).toBe(false);
    // The try at 0 is out; the one at 30 s still counts.
    expect(limiter.hit("a", 60_000).ok).toBe(true);
    expect(limiter.hit("a", 60_001).ok).toBe(false);
    expect(limiter.hit("a", 90_000).ok).toBe(true);
  });

  it("does not count refused tries, so hammering does not extend the wait", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
    expect(limiter.hit("a", 0).ok).toBe(true);
    for (let t = 1; t < 60_000; t += 5_000) expect(limiter.hit("a", t).ok).toBe(false);
    expect(limiter.hit("a", 60_000).ok).toBe(true);
  });

  it("reset forgets a key", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
    limiter.hit("a", 0);
    limiter.reset("a");
    expect(limiter.hit("a", 1).ok).toBe(true);
  });

  it("holds at most maxKeys keys: expired ones go first, then the least recently used", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE, maxKeys: 3 });
    limiter.hit("old", 0);
    limiter.hit("b", 59_000);
    limiter.hit("c", 59_500);
    // "old" has expired by now and is pruned to make room.
    limiter.hit("d", 61_000);
    expect(limiter.size()).toBe(3);
    // All live: the least recently used ("b") is dropped.
    limiter.hit("e", 61_500);
    expect(limiter.size()).toBe(3);
    expect(limiter.hit("b", 61_600).ok).toBe(true);
    expect(limiter.hit("e", 61_700).ok).toBe(false);
  });

  it("cuts very long keys instead of storing them whole", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
    const long = "x".repeat(10_000);
    expect(limiter.hit(long, 0).ok).toBe(true);
    expect(limiter.hit(`${long}y`, 1).ok).toBe(false);
  });
});

describe("allowAttemptInMemory (the fallback)", () => {
  const make = () => ({
    ip: createRateLimiter({ limit: 3, windowMs: MINUTE }),
    account: createRateLimiter({ limit: 2, windowMs: MINUTE }),
  });

  it("refuses on the account limit, across spellings, for the same IP", () => {
    const limits = make();
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 0)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", " Anna@X.dk", 1)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "ANNA@x.dk", 2)).toBe(false);
  });

  it("does not let one IP's wrong tries lock the account for another IP", () => {
    const limits = make();
    // A stranger who knows the user name uses up their own tries at it.
    expect(allowAttemptInMemory(limits, "6.6.6.6", "anna@x.dk", 0)).toBe(true);
    expect(allowAttemptInMemory(limits, "6.6.6.6", "anna@x.dk", 1)).toBe(true);
    expect(allowAttemptInMemory(limits, "6.6.6.6", "anna@x.dk", 2)).toBe(false);
    // Anna, from her own IP, still has all of hers.
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 3)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 4)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 5)).toBe(false);
  });

  it("forgets one IP's tries at an account with attemptKey, as a successful login does", () => {
    const limits = make();
    allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 0);
    allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 1);
    allowAttemptInMemory(limits, "2.2.2.2", "anna@x.dk", 2);
    allowAttemptInMemory(limits, "2.2.2.2", "anna@x.dk", 3);
    limits.account.reset(attemptKey("1.1.1.1", " Anna@X.dk "));
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna@x.dk", 4)).toBe(true);
    // The other IP's count is its own and stays.
    expect(allowAttemptInMemory(limits, "2.2.2.2", "anna@x.dk", 5)).toBe(false);
  });

  it("refuses on the IP limit, across accounts", () => {
    const limits = make();
    expect(allowAttemptInMemory(limits, "1.1.1.1", "a", 0)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "b", 1)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "c", 2)).toBe(true);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "d", 3)).toBe(false);
  });

  it("a blocked IP does not use up an account's tries", () => {
    const limits = make();
    for (let i = 0; i < 3; i++) allowAttemptInMemory(limits, "1.1.1.1", `other${i}`, i);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna", 10)).toBe(false);
    expect(allowAttemptInMemory(limits, "1.1.1.1", "anna", 11)).toBe(false);
    // Nothing was counted against the account for the blocked tries.
    expect(limits.account.size()).toBe(3);
    // Anna still has both of her tries from elsewhere.
    expect(allowAttemptInMemory(limits, "2.2.2.2", "anna", 12)).toBe(true);
    expect(allowAttemptInMemory(limits, "2.2.2.2", "anna", 13)).toBe(true);
  });
});

describe("attemptKey", () => {
  it("joins the IP and the account in one spelling", () => {
    expect(attemptKey("1.1.1.1", "  Anna@X.DK ")).toBe("1.1.1.1|anna@x.dk");
  });
});

describe("clientIp", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("prefers x-real-ip", () => {
    expect(clientIp(headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe("9.9.9.9");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    expect(clientIp(headers({ "x-forwarded-for": " 1.1.1.1 , 10.0.0.1" }))).toBe("1.1.1.1");
  });

  it("is 'unknown' without a header", () => {
    expect(clientIp(headers({}))).toBe("unknown");
  });
});

describe("accountKey", () => {
  it("trims and lowercases", () => {
    expect(accountKey("  Anna@X.DK ")).toBe("anna@x.dk");
  });
});

describe("the limits of the three actions", () => {
  it("are what the forms promise", () => {
    expect(loginLimits).toMatchObject({ name: "login", windowMs: 10 * MINUTE, ipLimit: 10, accountLimit: 5 });
    expect(forgotLimits).toMatchObject({ name: "forgot", windowMs: 60 * MINUTE, ipLimit: 10, accountLimit: 3 });
    expect(resetLimits).toMatchObject({ name: "reset", windowMs: 10 * MINUTE, ipLimit: 10, accountLimit: 5 });
  });
});

describe("dbKeys", () => {
  it("prefixes the action, so login and reset never share a counter", () => {
    expect(dbKeys({ name: "login" }, "1.1.1.1", " Anna@X.dk ")).toEqual({
      ip: "login:ip:1.1.1.1",
      account: "login:acct:1.1.1.1|anna@x.dk",
    });
  });

  it("cuts very long keys", () => {
    const keys = dbKeys({ name: "login" }, "1.1.1.1", "x".repeat(10_000));
    expect(keys.account).toHaveLength(200);
    expect(keys.account.startsWith("login:acct:1.1.1.1|")).toBe(true);
  });
});

// The Postgres layer, on the real migrations in an in-process PGlite.
describe("allowAttempt in Postgres", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb?.close();
  });

  beforeEach(async () => {
    await withService((db) => db.query("delete from app.rate_limits"));
  });

  const make = () =>
    createAttemptLimits({ name: "test", windowMs: MINUTE, ipLimit: 3, accountLimit: 2 });

  // A real-looking clock: to_timestamp() of a small number is fine too, but
  // this keeps the rows readable when a test fails.
  const T0 = Date.UTC(2026, 10, 16, 8, 0, 0) + 1;

  const counts = () =>
    withService((db) =>
      db.query<{ key: string; count: number }>("select key, count from app.rate_limits order by key")
    );

  it("allows up to the account limit, then refuses, across spellings", async () => {
    const limits = make();
    expect(await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", " Anna@X.dk", T0 + 1)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "ANNA@x.dk", T0 + 2)).toBe(false);
  });

  it("counts in the table, not in memory", async () => {
    const limits = make();
    await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0);
    expect(await counts()).toEqual([
      { key: "test:acct:1.1.1.1|anna@x.dk", count: 1 },
      { key: "test:ip:1.1.1.1", count: 1 },
    ]);
    expect(limits.ip.size()).toBe(0);
    expect(limits.account.size()).toBe(0);
  });

  it("is shared: a second instance with fresh memory sees the same counts", async () => {
    const one = make();
    const two = make();
    expect(await allowAttempt(one, "1.1.1.1", "anna@x.dk", T0)).toBe(true);
    expect(await allowAttempt(two, "1.1.1.1", "anna@x.dk", T0 + 1)).toBe(true);
    expect(await allowAttempt(one, "1.1.1.1", "anna@x.dk", T0 + 2)).toBe(false);
    expect(await allowAttempt(two, "1.1.1.1", "anna@x.dk", T0 + 3)).toBe(false);
  });

  it("refuses on the IP limit, across accounts", async () => {
    const limits = make();
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "b", T0 + 1)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "c", T0 + 2)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "d", T0 + 3)).toBe(false);
  });

  it("a blocked IP does not use up an account's tries", async () => {
    const limits = make();
    for (let i = 0; i < 3; i++) await allowAttempt(limits, "1.1.1.1", `other${i}`, T0 + i);
    expect(await allowAttempt(limits, "1.1.1.1", "anna", T0 + 10)).toBe(false);
    expect((await counts()).find((r) => r.key === "test:acct:1.1.1.1|anna")).toBeUndefined();
    expect(await allowAttempt(limits, "2.2.2.2", "anna", T0 + 11)).toBe(true);
    expect(await allowAttempt(limits, "2.2.2.2", "anna", T0 + 12)).toBe(true);
  });

  it("does not let one IP's wrong tries lock the account for another IP", async () => {
    const limits = make();
    expect(await allowAttempt(limits, "6.6.6.6", "anna@x.dk", T0)).toBe(true);
    expect(await allowAttempt(limits, "6.6.6.6", "anna@x.dk", T0 + 1)).toBe(true);
    expect(await allowAttempt(limits, "6.6.6.6", "anna@x.dk", T0 + 2)).toBe(false);
    expect(await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0 + 3)).toBe(true);
  });

  it("is a fixed window: it opens at the first try and a new one starts when it has ended", async () => {
    const limits = createAttemptLimits({ name: "test", windowMs: MINUTE, ipLimit: 100, accountLimit: 2 });
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 30_000)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 59_999)).toBe(false);
    // The window that opened at T0 has ended: both tries are forgotten at once.
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 60_000)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 60_001)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 60_002)).toBe(false);
  });

  it("hammering does not extend the wait", async () => {
    const limits = createAttemptLimits({ name: "test", windowMs: MINUTE, ipLimit: 100, accountLimit: 1 });
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0)).toBe(true);
    for (let t = 5_000; t < 60_000; t += 5_000) {
      expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + t)).toBe(false);
    }
    expect(await allowAttempt(limits, "1.1.1.1", "a", T0 + 60_000)).toBe(true);
  });

  it("concurrent tries are counted one by one", async () => {
    const limits = createAttemptLimits({ name: "test", windowMs: MINUTE, ipLimit: 100, accountLimit: 5 });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => allowAttempt(limits, "1.1.1.1", "a", T0 + i))
    );
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("forgetAccountAttempts forgets this IP's tries at the account, and only those", async () => {
    const limits = make();
    await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0);
    await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0 + 1);
    await allowAttempt(limits, "2.2.2.2", "anna@x.dk", T0 + 2);
    await allowAttempt(limits, "2.2.2.2", "anna@x.dk", T0 + 3);
    await forgetAccountAttempts(limits, "1.1.1.1", " Anna@X.dk ");
    expect(await allowAttempt(limits, "1.1.1.1", "anna@x.dk", T0 + 4)).toBe(true);
    // The other IP's count is its own and stays.
    expect(await allowAttempt(limits, "2.2.2.2", "anna@x.dk", T0 + 5)).toBe(false);
    // The IP counter is not reset by a successful login.
    expect((await counts()).find((r) => r.key === "test:ip:1.1.1.1")?.count).toBe(3);
  });

  it("sweeps long dead counters now and then", async () => {
    const limits = make();
    await allowAttemptInDb(limits, "9.9.9.9", "old", T0 - 48 * 60 * MINUTE);
    // `now` divisible by 100 is when the sweep runs.
    const sweepAt = Math.ceil(T0 / 100) * 100;
    await allowAttemptInDb(limits, "1.1.1.1", "new", sweepAt);
    expect((await counts()).map((r) => r.key)).toEqual(["test:acct:1.1.1.1|new", "test:ip:1.1.1.1"]);
  });
});
