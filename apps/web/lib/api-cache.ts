// Process-memory cache for OptiCloud responses.
//
// Next's data cache (the `next: { revalidate }` option on fetch) refuses any
// entry over 2 MB, and the responses this app leans on are mostly over it:
// GetDataExport is 1.9 MB for a week and 7.3 MB for a month, the completed
// task instances are 3 MB, the Items and quality-control tables 2.7 and
// 2.3 MB. Those were re-downloaded and re-parsed on every single page load,
// which is most of the wait when moving between the report pages — they all
// read the same export for the same period.
//
// This cache sits in front of the API client instead, so size is not a
// criterion and a hit costs neither a request nor a JSON parse. What it gives
// up in exchange:
//
//   - It lives in the server process, so it is per instance and disappears on
//     restart or redeploy. A cold instance pays full price once.
//   - revalidateTag() does not reach it; entries leave on their TTL only.
//
// Every row here belongs to the one Optipeople account this app reads (a
// single API key, identical for every signed-in user), so there is nothing
// user-specific to keep apart.

interface Entry {
  value: unknown;
  /** Size of the raw JSON, used to bound what is held. */
  bytes: number;
  expiresAt: number;
}

/**
 * Ceiling on the raw JSON held at once. The heaviest page needs about 10 MB
 * of it, so this leaves room for a couple of periods side by side while
 * staying well inside a function's memory once parsed (the object graph runs
 * several times the size of the text it came from).
 */
const MAX_BYTES = 32 * 1024 * 1024;

/** Insertion order doubles as the LRU order: oldest use first. */
const entries = new Map<string, Entry>();

/** In-flight requests, so parallel callers share one download. */
const inFlight = new Map<string, Promise<unknown>>();

let heldBytes = 0;

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  heldBytes -= entry.bytes;
}

function store(key: string, value: unknown, bytes: number, ttlSeconds: number): void {
  // A single response bigger than the whole budget is served but not kept —
  // holding it would evict everything else for one entry.
  if (bytes > MAX_BYTES) return;

  const now = Date.now();
  for (const [k, entry] of entries) {
    if (entry.expiresAt <= now) drop(k);
  }
  for (const k of entries.keys()) {
    if (heldBytes + bytes <= MAX_BYTES) break;
    drop(k);
  }

  entries.set(key, { value, bytes, expiresAt: now + ttlSeconds * 1000 });
  heldBytes += bytes;
}

/**
 * Returns the cached value for `key`, or runs `load` and keeps its result for
 * `ttlSeconds`. Failures are not cached, and concurrent callers for the same
 * key wait on one shared load rather than starting their own.
 */
export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<{ value: T; bytes: number }>
): Promise<T> {
  if (ttlSeconds <= 0) return (await load()).value;

  const hit = entries.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) {
      // Touch it so the LRU order reflects this use.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value as T;
    }
    drop(key);
  }

  const pending = inFlight.get(key);
  if (pending) return (await pending) as T;

  const promise = load().then(
    ({ value, bytes }) => {
      inFlight.delete(key);
      store(key, value, bytes, ttlSeconds);
      return value;
    },
    (err: unknown) => {
      inFlight.delete(key);
      throw err;
    }
  );
  inFlight.set(key, promise);
  return (await promise) as T;
}

/** Drops everything. Exported for tests and for a manual flush. */
export function clearApiCache(): void {
  entries.clear();
  inFlight.clear();
  heldBytes = 0;
}
