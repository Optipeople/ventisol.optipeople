import { describe, expect, it } from "vitest";
import {
  accountKey,
  allowAttempt,
  attemptKey,
  clientIp,
  createRateLimiter,
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

describe("allowAttempt", () => {
  const make = () => ({
    ip: createRateLimiter({ limit: 3, windowMs: MINUTE }),
    account: createRateLimiter({ limit: 2, windowMs: MINUTE }),
  });

  it("refuses on the account limit, across spellings, for the same IP", () => {
    const limits = make();
    expect(allowAttempt(limits, "1.1.1.1", "anna@x.dk", 0)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", " Anna@X.dk", 1)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "ANNA@x.dk", 2)).toBe(false);
  });

  it("does not let one IP's wrong tries lock the account for another IP", () => {
    const limits = make();
    // A stranger who knows the user name uses up their own tries at it.
    expect(allowAttempt(limits, "6.6.6.6", "anna@x.dk", 0)).toBe(true);
    expect(allowAttempt(limits, "6.6.6.6", "anna@x.dk", 1)).toBe(true);
    expect(allowAttempt(limits, "6.6.6.6", "anna@x.dk", 2)).toBe(false);
    // Anna, from her own IP, still has all of hers.
    expect(allowAttempt(limits, "1.1.1.1", "anna@x.dk", 3)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "anna@x.dk", 4)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "anna@x.dk", 5)).toBe(false);
  });

  it("forgets one IP's tries at an account with attemptKey, as a successful login does", () => {
    const limits = make();
    allowAttempt(limits, "1.1.1.1", "anna@x.dk", 0);
    allowAttempt(limits, "1.1.1.1", "anna@x.dk", 1);
    allowAttempt(limits, "2.2.2.2", "anna@x.dk", 2);
    allowAttempt(limits, "2.2.2.2", "anna@x.dk", 3);
    limits.account.reset(attemptKey("1.1.1.1", " Anna@X.dk "));
    expect(allowAttempt(limits, "1.1.1.1", "anna@x.dk", 4)).toBe(true);
    // The other IP's count is its own and stays.
    expect(allowAttempt(limits, "2.2.2.2", "anna@x.dk", 5)).toBe(false);
  });

  it("refuses on the IP limit, across accounts", () => {
    const limits = make();
    expect(allowAttempt(limits, "1.1.1.1", "a", 0)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "b", 1)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "c", 2)).toBe(true);
    expect(allowAttempt(limits, "1.1.1.1", "d", 3)).toBe(false);
  });

  it("a blocked IP does not use up an account's tries", () => {
    const limits = make();
    for (let i = 0; i < 3; i++) allowAttempt(limits, "1.1.1.1", `other${i}`, i);
    expect(allowAttempt(limits, "1.1.1.1", "anna", 10)).toBe(false);
    expect(allowAttempt(limits, "1.1.1.1", "anna", 11)).toBe(false);
    // Nothing was counted against the account for the blocked tries.
    expect(limits.account.size()).toBe(3);
    // Anna still has both of her tries from elsewhere.
    expect(allowAttempt(limits, "2.2.2.2", "anna", 12)).toBe(true);
    expect(allowAttempt(limits, "2.2.2.2", "anna", 13)).toBe(true);
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
