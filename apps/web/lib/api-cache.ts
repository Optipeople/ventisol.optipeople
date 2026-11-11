// Process-memory cache for what is read from OptiCloud.
//
// The reads this site leans on are far over the 2 MB that Next's data cache
// (the `next: { revalidate }` option on fetch) accepts, so the cache sits in
// front of the API client instead: a hit costs neither a request nor a JSON
// parse. What it gives up in exchange:
//
//   - It lives in the server process, so it is per instance and disappears on
//     restart or redeploy. A cold instance pays full price once.
//   - revalidateTag() does not reach it; entries leave on their age only.
//
// Two things are kept, and they are shared differently:
//
//   - cachedJson: a response under a key the caller picks. Reads are made
//     with the signed-in user's own token and OptiCloud decides what a token
//     may read, so anything that depends on the user (the table list and the
//     one row read, which together are the access check) is keyed per user by
//     the caller.
//   - sharedScans: the scan rows of one table, one copy for everyone. The
//     rows are the same whoever reads them, so holding them per user only
//     multiplied the memory. The store itself checks nobody: the caller must
//     have checked the user against the account before asking for rows (see
//     loadScansSince in lib/opticloud.ts), on every call, hit or not.

import { isTokenRefusal } from "@/lib/api-errors";
import type { ReadResult } from "@/lib/paging";
import type { Scan } from "@/lib/scans";

interface Entry {
  value: unknown;
  /** Size of the raw JSON, used to bound what is held. */
  bytes: number;
  /** When it was read. A hit must be younger than the TTL its caller asks for. */
  fetchedAt: number;
  /** When nobody could want it any more: the longest TTL it was stored with. */
  expiresAt: number;
}

/** Ceiling on the raw JSON held by cachedJson at once. */
export const MAX_JSON_BYTES = 32 * 1024 * 1024;

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

function store(key: string, value: unknown, bytes: number, ttlSeconds: number, now: number): void {
  drop(key);
  // A single response bigger than the whole budget is served but not kept:
  // holding it would evict everything else for one entry.
  if (bytes > MAX_JSON_BYTES) return;

  for (const [k, entry] of entries) {
    if (entry.expiresAt <= now) drop(k);
  }
  for (const k of [...entries.keys()]) {
    if (heldBytes + bytes <= MAX_JSON_BYTES) break;
    drop(k);
  }

  entries.set(key, { value, bytes, fetchedAt: now, expiresAt: now + ttlSeconds * 1000 });
  heldBytes += bytes;
}

/**
 * Returns the cached value for `key` when it is younger than `ttlSeconds`,
 * or runs `load` and keeps its result. The age is judged by the TTL this
 * caller asks for, not the one it was stored with, so a caller that needs it
 * fresh never gets what another was happy to keep for longer. Failures are
 * not cached, and concurrent callers for the same key wait on one shared load
 * rather than starting their own; a load that fails is forgotten at once, so
 * the next caller starts a new one.
 */
export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<{ value: T; bytes: number }>,
  now: number = Date.now()
): Promise<T> {
  if (ttlSeconds <= 0) return (await load()).value;

  const hit = entries.get(key);
  if (hit && now - hit.fetchedAt < ttlSeconds * 1000) {
    // Touch it so the LRU order reflects this use.
    entries.delete(key);
    entries.set(key, hit);
    return hit.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) return (await pending) as T;

  const promise = load().then(
    ({ value, bytes }) => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
      store(key, value, bytes, ttlSeconds, now);
      return value;
    },
    (err: unknown) => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
      throw err;
    }
  );
  inFlight.set(key, promise);
  return (await promise) as T;
}

// ---------------------------------------------------------------------------
// The shared scan rows
// ---------------------------------------------------------------------------

/**
 * Ceiling on the scan rows held, by the estimate below. Two months at a few
 * thousand scans a day is about 190 000 rows, some 70 MB: it fits, once, where
 * a copy per user did not. The most one read can bring back (MAX_PAGES pages
 * in lib/paging.ts, 300 000 rows) is about 110 MB by the same estimate, so
 * every read that is not truncated fits too.
 */
export const MAX_SCAN_BYTES = 128 * 1024 * 1024;

/**
 * A scan sent late (the station was offline) carries its own, older scan
 * time, so it lands behind rows already held. Reading only the newest rows
 * would never see it. As the station app does: most reads go back
 * TOP_UP_OVERLAP_MS from the newest row held; the last LATE_WINDOW_MS are read
 * again every LATE_RECHECK_SECONDS; and a read that reaches further back than
 * that has everything it asks for read again every WHOLE_RECHECK_SECONDS.
 * None of these lets go of older rows held: only a read that reaches further
 * back than what is held replaces it.
 */
export const TOP_UP_OVERLAP_MS = 10 * 60_000;
export const LATE_WINDOW_MS = 36 * 3_600_000;
export const LATE_RECHECK_SECONDS = 300;
export const WHOLE_RECHECK_SECONDS = 3600;

interface ScanStore {
  /** Newest first, each ScanId once. Every row from `since` on. */
  scans: Scan[];
  since: number;
  /** When the newest rows were last read. */
  fetchedAt: number;
  /** When the last LATE_WINDOW_MS (or more) were last read. */
  lateAt: number;
  /**
   * The last deep read: everything from `wholeFrom` on was read at `wholeAt`.
   * `wholeFrom` can be later than `since` (a shallow view did the recheck);
   * the rows before it are kept, and are read again for a caller that reaches
   * back to them.
   */
  wholeFrom: number;
  wholeAt: number;
  unordered: boolean;
  bytes: number;
}

const scanStores = new Map<string, ScanStore>();
const scanReads = new Map<string, Promise<unknown>>();

/**
 * What one parsed scan holds in memory, roughly: the object and its numbers,
 * plus each string (a header and its characters).
 */
export function estimateScanBytes(scan: Scan): number {
  const chars =
    scan.id.length +
    scan.barcode.length +
    scan.station.length +
    scan.stationKind.length +
    (scan.device?.length ?? 0);
  return 200 + 2 * chars;
}

const newestFirst = (a: Scan, b: Scan) => b.time - a.time;

/** The rows from `since` on, out of a newest-first list. */
function from(scans: Scan[], since: number): Scan[] {
  // Binary search for the first row older than `since`.
  let lo = 0;
  let hi = scans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scans[mid].time >= since) lo = mid + 1;
    else hi = mid;
  }
  return scans.slice(0, lo);
}

interface ReadPlan {
  from: number;
  /** The read replaces everything held (it reaches at least as far back). */
  replace: boolean;
}

/** What to read, or null when what is held will do. */
function planRead(held: ScanStore | undefined, since: number, ttlSeconds: number, now: number): ReadPlan | null {
  if (!held || since < held.since) return { from: since, replace: true };
  const wantsOld = since < now - LATE_WINDOW_MS;
  const rechecked = since >= held.wholeFrom && now - held.wholeAt < WHOLE_RECHECK_SECONDS * 1000;
  // The hourly recheck reads what this caller asks for and no more, and adds
  // it to what is held: a shallow view (today) must not throw away the weeks
  // a deeper view read, nor pay for reading them again.
  if (wantsOld && !rechecked) return { from: since, replace: false };
  if (ttlSeconds > 0 && now - held.fetchedAt < ttlSeconds * 1000) return null;
  if (now - held.lateAt >= LATE_RECHECK_SECONDS * 1000) {
    return { from: Math.max(held.since, now - LATE_WINDOW_MS), replace: false };
  }
  const newest = held.scans.length > 0 ? held.scans[0].time : held.since;
  return { from: Math.max(held.since, Math.min(newest, now) - TOP_UP_OVERLAP_MS), replace: false };
}

function keep(key: string, next: ScanStore): void {
  // Over the ceiling: let go of the oldest rows and say so in `since`, so a
  // read that wants them goes to OptiCloud instead of getting a short answer.
  if (next.bytes > MAX_SCAN_BYTES) {
    let bytes = 0;
    let count = 0;
    while (count < next.scans.length) {
      const b = estimateScanBytes(next.scans[count]);
      if (bytes + b > MAX_SCAN_BYTES) break;
      bytes += b;
      count++;
    }
    // Never cut through rows of the same instant: drop all of them.
    const cut = next.scans[count].time;
    next.scans = next.scans.slice(0, count).filter((s) => s.time > cut);
    next.since = cut + 1;
    next.bytes = next.scans.reduce((t, s) => t + estimateScanBytes(s), 0);
  }
  scanStores.delete(key);
  let total = next.bytes;
  for (const s of scanStores.values()) total += s.bytes;
  for (const [k, s] of [...scanStores]) {
    if (total <= MAX_SCAN_BYTES) break;
    scanStores.delete(k);
    total -= s.bytes;
  }
  scanStores.set(key, next);
}

/**
 * All scans from `since` on, out of the one shared copy held under `key` (an
 * account and its table), no older than `ttlSeconds`. What is missing or too
 * old is read with `read(from)`, which must return every scan from `from` on
 * (readScansSince), and only that part is read: mostly the newest page.
 *
 * The rows are shared between users. The caller must have checked that this
 * user may read them before calling, every time.
 *
 * One read per key runs at a time. A caller that waited on another's read
 * looks again afterwards. When that read failed because the other user's
 * token was refused (401 or 403), the caller makes its own. Any other failure
 * (OptiCloud down, a timeout) is the caller's failure too: it is handed on,
 * so an outage costs one failed read, not one per waiter in turn. A read that
 * came back truncated is handed on as it is and not kept.
 */
export async function sharedScans(
  key: string,
  since: number,
  ttlSeconds: number,
  read: (from: number) => Promise<ReadResult>,
  now: number = Date.now()
): Promise<ReadResult> {
  for (;;) {
    const pending = scanReads.get(key);
    if (pending) {
      try {
        await pending;
      } catch (err) {
        if (!isTokenRefusal(err)) throw err;
      }
      continue;
    }

    const held = scanStores.get(key);
    const plan = planRead(held, since, ttlSeconds, now);
    if (!plan) {
      return { scans: from(held!.scans, since), pagesRead: 0, unordered: held!.unordered, truncated: false };
    }

    const promise = refresh(key, plan.replace ? undefined : held, since, plan.from, read, now);
    scanReads.set(key, promise);
    try {
      return await promise;
    } finally {
      if (scanReads.get(key) === promise) scanReads.delete(key);
    }
  }
}

async function refresh(
  key: string,
  held: ScanStore | undefined,
  since: number,
  readFrom: number,
  read: (from: number) => Promise<ReadResult>,
  now: number
): Promise<ReadResult> {
  let result = await read(readFrom);
  if (result.truncated) {
    // Not something to build on. Ask for exactly what the caller wants and
    // hand that on, kept nowhere.
    if (readFrom !== since) result = await read(since);
    if (result.truncated) return result;
    readFrom = since;
    held = undefined;
  }

  // `held` is only handed in when the read adds to it.
  const whole = !held || readFrom <= held.since;
  const fresh = [...result.scans].sort(newestFirst);
  let scans = fresh;
  if (!whole && held) {
    // The part read replaces what was held from there on; older rows stay.
    const ids = new Set(fresh.map((s) => s.id));
    scans = fresh.concat(held.scans.filter((s) => s.time < readFrom && !ids.has(s.id)));
  }

  const coversLate = readFrom <= now - LATE_WINDOW_MS || whole;
  // This read becomes the deep read on record when it reaches at least as far
  // back as the one before, or when that one is too old to count anyway.
  const deepest =
    whole || !held || readFrom <= held.wholeFrom || now - held.wholeAt >= WHOLE_RECHECK_SECONDS * 1000;
  keep(key, {
    scans,
    since: whole ? readFrom : held!.since,
    fetchedAt: now,
    lateAt: coversLate || !held ? now : held.lateAt,
    wholeFrom: deepest || !held ? readFrom : held.wholeFrom,
    wholeAt: deepest || !held ? now : held.wholeAt,
    unordered: result.unordered,
    bytes: scans.reduce((t, s) => t + estimateScanBytes(s), 0),
  });

  return {
    scans: from(scans, since),
    pagesRead: result.pagesRead,
    unordered: result.unordered,
    truncated: false,
  };
}

/** Drops everything. Exported for tests and for a manual flush. */
export function clearApiCache(): void {
  entries.clear();
  inFlight.clear();
  heldBytes = 0;
  scanStores.clear();
  scanReads.clear();
}

/** What is held right now, for tests. */
export function cacheStats(): { jsonBytes: number; jsonEntries: number; scanBytes: number; scanRows: number } {
  let scanBytes = 0;
  let scanRows = 0;
  for (const s of scanStores.values()) {
    scanBytes += s.bytes;
    scanRows += s.scans.length;
  }
  return { jsonBytes: heldBytes, jsonEntries: entries.size, scanBytes, scanRows };
}
