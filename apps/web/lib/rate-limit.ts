// Rate limiting for the login and password-reset actions, which otherwise
// relay unlimited attempts to OptiCloud from this server's IP.
//
// Two layers:
//
// 1. Postgres (app.rate_limits), shared by every server instance: a fixed
//    window counter per key, bumped by one atomic upsert. This is the one
//    that counts on Vercel, where each warm function instance has its own
//    memory and a cold start begins at zero.
// 2. Process memory (createRateLimiter, a sliding window), per instance. It
//    is the fallback when the database is not configured, is down or is slow
//    (DB_TIMEOUT_MS), so login never breaks because of the limiter. It slows
//    a single client down but is no defence against a distributed attack.
//
// Neither replaces a Vercel WAF rate limit rule on /login, /forgot-password
// and /reset-password; this is the backstop.
//
// Fixed window means: the first try opens a window of windowMs, tries in it
// are counted, and the first try after it has ended opens a new one. A
// refused try is counted too, but never moves the window, so hammering does
// not extend the wait. Right at a window boundary a client can get up to
// twice the limit in a short time, which is fine at these numbers.
//
// Two counters per action: one per IP, and one per IP and account together.
// The account counter is never keyed on the account alone. It is checked
// before the password goes upstream, so a counter on the name alone would let
// anyone who knows a user name lock that user out with a handful of wrong
// tries. Keyed with the IP, a stranger only uses up their own tries. Guessing
// at one account from many IPs is for the WAF rule and OptiCloud to stop.
//
// The clock can be passed in everywhere, so it is unit tested.

import { withService, type Db } from "@/lib/db";

export type RateLimitResult =
  | { ok: true }
  /** Over the limit. `retryAfterMs` is when the oldest counted try leaves the window. */
  | { ok: false; retryAfterMs: number };

export type RateLimiter = {
  /** Count one try for `key`. A refused try is not counted. */
  hit(key: string, now?: number): RateLimitResult;
  /** Forget `key`, for example after a successful login. */
  reset(key: string): void;
  /** Keys held right now (for the tests). */
  size(): number;
};

/** Longest key kept: a huge "e-mail" must not become a huge map key. */
const MAX_KEY_LENGTH = 200;

export function createRateLimiter(options: {
  /** Tries allowed per window. */
  limit: number;
  windowMs: number;
  /** Most keys held at once, so a flood of made-up keys cannot fill memory. */
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 5000;
  // Key -> times of the counted tries, oldest first. A Map keeps insertion
  // order, which is what the eviction below leans on.
  const tries = new Map<string, number[]>();

  function prune(now: number): void {
    for (const [key, times] of tries) {
      if (times[times.length - 1] <= now - windowMs) tries.delete(key);
    }
  }

  return {
    hit(rawKey, now = Date.now()) {
      const key = rawKey.slice(0, MAX_KEY_LENGTH);
      const cutoff = now - windowMs;
      const recent = (tries.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= limit) {
        tries.set(key, recent);
        return { ok: false, retryAfterMs: recent[0] + windowMs - now };
      }

      recent.push(now);
      // Re-insert so the most recently used keys sit last.
      tries.delete(key);
      tries.set(key, recent);

      if (tries.size > maxKeys) {
        prune(now);
        // Still full of live keys: drop the least recently used ones.
        for (const oldest of tries.keys()) {
          if (tries.size <= maxKeys) break;
          tries.delete(oldest);
        }
      }
      return { ok: true };
    },
    reset(rawKey) {
      tries.delete(rawKey.slice(0, MAX_KEY_LENGTH));
    },
    size() {
      return tries.size;
    },
  };
}

/**
 * The client's IP from the platform headers. Vercel sets `x-real-ip` (it is
 * what `ipAddress()` in @vercel/functions reads, which the Next docs point
 * to) and overwrites `x-forwarded-for`, so a client cannot forge either
 * there. Behind another proxy, make sure it sets them too. Without a header
 * (local dev) everyone shares the one "unknown" bucket.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** One spelling per account, so "Anna@X.dk " and "anna@x.dk" share a bucket. */
export function accountKey(nameOrEmail: string): string {
  return nameOrEmail.trim().toLowerCase();
}

/**
 * The key of the account counter: this IP's tries at this account. The IP
 * comes first, so cutting a very long key never cuts the IP away.
 */
export function attemptKey(ip: string, nameOrEmail: string): string {
  return `${ip}|${accountKey(nameOrEmail)}`;
}

/** Shown for every refused try, whether or not the account exists. */
export const TOO_MANY_ATTEMPTS = "For mange forsøg. Prøv igen om lidt.";

const MINUTE = 60_000;

/** The limits of one action, with the in-memory counters of the fallback. */
export type AttemptLimits = {
  /** Key prefix in app.rate_limits: "login", "forgot", "reset". */
  name: string;
  windowMs: number;
  /** Tries per window from one IP. */
  ipLimit: number;
  /** Of those, tries at one account. */
  accountLimit: number;
  /** In-memory fallback counters, one set per server instance. */
  ip: RateLimiter;
  account: RateLimiter;
};

export function createAttemptLimits(options: {
  name: string;
  windowMs: number;
  ipLimit: number;
  accountLimit: number;
}): AttemptLimits {
  return {
    ...options,
    ip: createRateLimiter({ limit: options.ipLimit, windowMs: options.windowMs }),
    account: createRateLimiter({
      limit: options.accountLimit,
      windowMs: options.windowMs,
    }),
  };
}

/** Login: 10 tries per 10 minutes per IP, 5 of them at one account. */
export const loginLimits = createAttemptLimits({
  name: "login",
  windowMs: 10 * MINUTE,
  ipLimit: 10,
  accountLimit: 5,
});

/** Reset mails: 10 per hour per IP, 3 of them to one e-mail. */
export const forgotLimits = createAttemptLimits({
  name: "forgot",
  windowMs: 60 * MINUTE,
  ipLimit: 10,
  accountLimit: 3,
});

/** Setting a new password from a reset link: 10 tries per 10 minutes per IP, 5 of them for one e-mail. */
export const resetLimits = createAttemptLimits({
  name: "reset",
  windowMs: 10 * MINUTE,
  ipLimit: 10,
  accountLimit: 5,
});

/**
 * The in-memory check. Count one try against the IP, and against this IP's
 * tries at the account (attemptKey). The IP is checked first, so a blocked IP
 * does not count further. One IP's tries never count against the same account
 * from another IP, so the account's owner is not locked out by someone else's
 * guesses.
 */
export function allowAttemptInMemory(
  limits: { ip: RateLimiter; account: RateLimiter },
  ip: string,
  account: string,
  now: number = Date.now()
): boolean {
  if (!limits.ip.hit(ip, now).ok) return false;
  return limits.account.hit(attemptKey(ip, account), now).ok;
}

// --- The Postgres layer ---

/** Longest wait for the database before the in-memory fallback answers. */
export const DB_TIMEOUT_MS = 2_000;

/** Rows older than this are swept now and then. Longer than any window. */
const SWEEP_AGE_MS = 24 * 60 * MINUTE;

/** The keys of one try in app.rate_limits. */
export function dbKeys(
  limits: Pick<AttemptLimits, "name">,
  ip: string,
  account: string
): { ip: string; account: string } {
  return {
    ip: `${limits.name}:ip:${ip}`.slice(0, MAX_KEY_LENGTH),
    account: `${limits.name}:acct:${attemptKey(ip, account)}`.slice(0, MAX_KEY_LENGTH),
  };
}

/**
 * Count one try for `key` and say whether it is within `limit`. One
 * statement, so two instances counting at the same moment cannot both read
 * the old count: the upsert takes the row lock.
 */
async function hitInDb(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): Promise<boolean> {
  const rows = await db.query<{ count: number | string }>(
    `insert into app.rate_limits as r (key, window_start, count)
     values ($1, to_timestamp($2::double precision / 1000.0), 1)
     on conflict (key) do update set
       count = case
         when r.window_start <= excluded.window_start - ($3::double precision * interval '1 millisecond')
           then 1
         else r.count + 1
       end,
       window_start = case
         when r.window_start <= excluded.window_start - ($3::double precision * interval '1 millisecond')
           then excluded.window_start
         else r.window_start
       end
     returning count`,
    [key, now, windowMs]
  );
  return Number(rows[0]?.count) <= limit;
}

/** The database check. Same order as allowAttemptInMemory: IP first. */
export async function allowAttemptInDb(
  limits: AttemptLimits,
  ip: string,
  account: string,
  now: number = Date.now()
): Promise<boolean> {
  const keys = dbKeys(limits, ip, account);
  return withService(async (db) => {
    // About one try in a hundred also clears out long dead counters.
    if (now % 100 === 0) {
      await db.query(
        `delete from app.rate_limits
          where window_start < to_timestamp($1::double precision / 1000.0)`,
        [now - SWEEP_AGE_MS]
      );
    }
    if (!(await hitInDb(db, keys.ip, limits.ipLimit, limits.windowMs, now))) {
      return false;
    }
    return hitInDb(db, keys.account, limits.accountLimit, limits.windowMs, now);
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer from the database in ${ms} ms`)),
      ms
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// One log line a minute at most, so a database that is down does not fill
// the log with one error per login try.
let lastFallbackLog = 0;

function logFallback(err: unknown): void {
  const now = Date.now();
  if (now - lastFallbackLog < MINUTE) return;
  lastFallbackLog = now;
  console.error(
    "rate limit: database unavailable, counting in memory instead:",
    err
  );
}

/**
 * May this try go ahead? Counts it in Postgres, shared by all instances.
 * When the database is not configured, fails or does not answer in
 * DB_TIMEOUT_MS, the in-memory counters of this instance decide instead, so
 * the caller always gets an answer and never an exception.
 */
export async function allowAttempt(
  limits: AttemptLimits,
  ip: string,
  account: string,
  now: number = Date.now()
): Promise<boolean> {
  try {
    return await withTimeout(
      allowAttemptInDb(limits, ip, account, now),
      DB_TIMEOUT_MS
    );
  } catch (err) {
    logFallback(err);
    return allowAttemptInMemory(limits, ip, account, now);
  }
}

/**
 * Forget this IP's tries at this account, for example after a successful
 * login: earlier typos no longer count. The IP's own counter stays. Never
 * throws.
 */
export async function forgetAccountAttempts(
  limits: AttemptLimits,
  ip: string,
  account: string
): Promise<void> {
  limits.account.reset(attemptKey(ip, account));
  try {
    await withTimeout(
      withService(async (db) => {
        await db.query("delete from app.rate_limits where key = $1", [
          dbKeys(limits, ip, account).account,
        ]);
      }),
      DB_TIMEOUT_MS
    );
  } catch (err) {
    logFallback(err);
  }
}
