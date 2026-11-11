// A small sliding-window rate limiter for the login and password-reset
// actions, which otherwise relay unlimited attempts to OptiCloud from this
// server's IP.
//
// It lives in process memory, so it is per server instance: on Vercel each
// warm function instance counts on its own and a cold start begins at zero.
// That slows a single client down but is not a real defence against a
// distributed attack. The real fix is a Vercel WAF rate limit rule on
// /login, /forgot-password and /reset-password; this is the backstop.
//
// Two counters per action: one per IP, and one per IP and account together.
// The account counter is never keyed on the account alone. It is checked
// before the password goes upstream, so a counter on the name alone would let
// anyone who knows a user name lock that user out with a handful of wrong
// tries. Keyed with the IP, a stranger only uses up their own tries. Guessing
// at one account from many IPs is for the WAF rule and OptiCloud to stop.
//
// Dependency free, and the clock can be passed in so it is unit tested.

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

// Module-level, so one set of counters per server instance.

/** Login: 10 tries per 10 minutes per IP, 5 of them at one account. */
export const loginLimits = {
  ip: createRateLimiter({ limit: 10, windowMs: 10 * MINUTE }),
  account: createRateLimiter({ limit: 5, windowMs: 10 * MINUTE }),
};

/** Reset mails: 10 per hour per IP, 3 of them to one e-mail. */
export const forgotLimits = {
  ip: createRateLimiter({ limit: 10, windowMs: 60 * MINUTE }),
  account: createRateLimiter({ limit: 3, windowMs: 60 * MINUTE }),
};

/** Setting a new password from a reset link: 10 tries per 10 minutes per IP, 5 of them for one e-mail. */
export const resetLimits = {
  ip: createRateLimiter({ limit: 10, windowMs: 10 * MINUTE }),
  account: createRateLimiter({ limit: 5, windowMs: 10 * MINUTE }),
};

/**
 * Count one try against the IP, and against this IP's tries at the account
 * (attemptKey). The IP is checked first, so a blocked IP does not count
 * further. One IP's tries never count against the same account from another
 * IP, so the account's owner is not locked out by someone else's guesses.
 */
export function allowAttempt(
  limits: { ip: RateLimiter; account: RateLimiter },
  ip: string,
  account: string,
  now: number = Date.now()
): boolean {
  if (!limits.ip.hit(ip, now).ok) return false;
  return limits.account.hit(attemptKey(ip, account), now).ok;
}
