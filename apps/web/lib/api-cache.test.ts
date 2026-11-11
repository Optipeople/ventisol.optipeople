import { beforeEach, describe, expect, it } from "vitest";
import {
  cachedJson,
  cacheStats,
  clearApiCache,
  estimateScanBytes,
  LATE_RECHECK_SECONDS,
  LATE_WINDOW_MS,
  MAX_JSON_BYTES,
  MAX_SCAN_BYTES,
  sharedScans,
  TOP_UP_OVERLAP_MS,
  WHOLE_RECHECK_SECONDS,
} from "@/lib/api-cache";
import { ApiAccessError, ApiAuthError } from "@/lib/api-errors";
import { MAX_PAGES, PAGE_SIZE, type ReadResult } from "@/lib/paging";
import type { Scan } from "@/lib/scans";
import { scan } from "@/lib/test-helpers";

const NOW = Date.UTC(2026, 9, 21, 12);
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => clearApiCache());

/** A loader that counts its calls and answers with the call number. */
function counter(bytes = 10) {
  let calls = 0;
  const load = async () => ({ value: ++calls, bytes });
  return { load, calls: () => calls };
}

describe("cachedJson", () => {
  it("answers from memory inside the TTL", async () => {
    const { load, calls } = counter();
    expect(await cachedJson("k", 30, load, NOW)).toBe(1);
    expect(await cachedJson("k", 30, load, NOW + 29 * SEC)).toBe(1);
    expect(calls()).toBe(1);
  });

  it("reads again once the TTL has passed", async () => {
    const { load } = counter();
    await cachedJson("k", 30, load, NOW);
    expect(await cachedJson("k", 30, load, NOW + 30 * SEC)).toBe(2);
  });

  it("judges a hit by the TTL the caller asks for, not the one it was stored with", async () => {
    const { load, calls } = counter();
    // Stored by a caller happy with five minutes.
    await cachedJson("k", 300, load, NOW);
    // A caller that needs it 30 seconds fresh does not get the old answer.
    expect(await cachedJson("k", 30, load, NOW + 60 * SEC)).toBe(2);
    // And the five-minute caller gets the newer one.
    expect(await cachedJson("k", 300, load, NOW + 200 * SEC)).toBe(2);
    expect(calls()).toBe(2);
  });

  it("does not cache with a TTL of zero", async () => {
    const { load, calls } = counter();
    await cachedJson("k", 0, load, NOW);
    await cachedJson("k", 0, load, NOW);
    expect(calls()).toBe(2);
  });

  it("shares one load between callers that ask at the same time", async () => {
    let calls = 0;
    let release!: (v: { value: string; bytes: number }) => void;
    const load = () => {
      calls++;
      return new Promise<{ value: string; bytes: number }>((r) => (release = r));
    };
    const a = cachedJson("k", 30, load, NOW);
    const b = cachedJson("k", 30, load, NOW);
    release({ value: "x", bytes: 1 });
    expect(await Promise.all([a, b])).toEqual(["x", "x"]);
    expect(calls).toBe(1);
  });

  it("forgets a failed load, so the next caller starts a new one", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new Error("timed out");
      return { value: "ok", bytes: 1 };
    };
    const a = cachedJson("k", 30, load, NOW);
    const b = cachedJson("k", 30, load, NOW);
    await expect(a).rejects.toThrow("timed out");
    await expect(b).rejects.toThrow("timed out");
    expect(await cachedJson("k", 30, load, NOW)).toBe("ok");
    expect(calls).toBe(2);
  });

  it("serves but does not keep a response over the whole budget", async () => {
    const { load, calls } = counter(MAX_JSON_BYTES + 1);
    await cachedJson("big", 30, load, NOW);
    await cachedJson("big", 30, load, NOW);
    expect(calls()).toBe(2);
    expect(cacheStats().jsonBytes).toBe(0);
  });

  it("lets go of the least recently used entries to stay under the ceiling", async () => {
    const third = Math.floor(MAX_JSON_BYTES / 3);
    const a = counter(third);
    const b = counter(third);
    const c = counter(third);
    const d = counter(third);
    await cachedJson("a", 300, a.load, NOW);
    await cachedJson("b", 300, b.load, NOW);
    await cachedJson("c", 300, c.load, NOW);
    // Use a, so b is the one that was used longest ago.
    await cachedJson("a", 300, a.load, NOW + SEC);
    await cachedJson("d", 300, d.load, NOW + 2 * SEC);
    expect(cacheStats().jsonBytes).toBeLessThanOrEqual(MAX_JSON_BYTES);
    await cachedJson("a", 300, a.load, NOW + 3 * SEC);
    await cachedJson("b", 300, b.load, NOW + 3 * SEC);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  it("counts an entry once when it is read again and replaced", async () => {
    const { load } = counter(1000);
    await cachedJson("k", 300, load, NOW);
    await cachedJson("k", 30, load, NOW + 60 * SEC);
    expect(cacheStats()).toMatchObject({ jsonBytes: 1000, jsonEntries: 1 });
  });
});

let n = 0;
const at = (time: number, over: Partial<Scan> = {}) => scan("In", time, { id: `x${++n}`, ...over });

/** "OptiCloud": a table of scans and a read that returns everything from `from` on. */
function table(initial: Scan[] = []) {
  const rows = [...initial];
  const reads: number[] = [];
  const read = async (from: number): Promise<ReadResult> => {
    reads.push(from);
    return { scans: rows.filter((s) => s.time >= from), pagesRead: 1, unordered: false, truncated: false };
  };
  return { rows, reads, read };
}

describe("sharedScans", () => {
  const since = NOW - 12 * HOUR;

  it("reads once and then answers every caller from the one copy", async () => {
    const t = table([at(NOW - HOUR), at(NOW - 2 * HOUR), at(NOW - 20 * HOUR)]);
    const first = await sharedScans("acc|tbl", since, 30, t.read, NOW);
    const second = await sharedScans("acc|tbl", since, 30, t.read, NOW + 10 * SEC);
    expect(t.reads).toEqual([since]);
    expect(first.scans).toHaveLength(2);
    expect(second.scans.map((s) => s.id)).toEqual(first.scans.map((s) => s.id));
    expect(second.pagesRead).toBe(0);
    expect(cacheStats().scanRows).toBe(2);
  });

  it("returns the scans newest first and only those from `since` on", async () => {
    const t = table([at(NOW - 3 * HOUR), at(NOW - HOUR), at(NOW - 2 * HOUR)]);
    await sharedScans("k", since, 30, t.read, NOW);
    const later = await sharedScans("k", NOW - 150 * MIN, 30, t.read, NOW);
    expect(later.scans.map((s) => NOW - s.time)).toEqual([HOUR, 2 * HOUR]);
    expect(t.reads).toHaveLength(1);
  });

  it("tops up with only the newest rows once the TTL has passed", async () => {
    const newest = NOW - HOUR;
    const t = table([at(newest), at(NOW - 5 * HOUR)]);
    await sharedScans("k", since, 30, t.read, NOW);
    t.rows.push(at(NOW + 20 * SEC));
    const result = await sharedScans("k", since, 30, t.read, NOW + 40 * SEC);
    // Read from a little before the newest row held, not from `since`.
    expect(t.reads).toEqual([since, newest - TOP_UP_OVERLAP_MS]);
    expect(result.scans).toHaveLength(3);
    expect(result.scans[0].time).toBe(NOW + 20 * SEC);
  });

  it("honours the TTL each caller asks for: a past-day read never makes today stale", async () => {
    const t = table([at(NOW - HOUR)]);
    // A past day is happy with five minutes.
    await sharedScans("k", since, 300, t.read, NOW);
    t.rows.push(at(NOW + 30 * SEC));
    // Today asks for 30 seconds, a minute later: it must see the new scan.
    const today = await sharedScans("k", since, 30, t.read, NOW + 60 * SEC);
    expect(today.scans).toHaveLength(2);
    // The past-day caller is then served from memory.
    await sharedScans("k", since, 300, t.read, NOW + 90 * SEC);
    expect(t.reads).toHaveLength(2);
  });

  it("reads the last 36 hours again every five minutes, to catch scans sent late", async () => {
    const t = table([at(NOW - HOUR)]);
    const deep = NOW - 10 * DAY;
    await sharedScans("k", deep, 30, t.read, NOW);
    // A station was offline: its scan arrives now with an older scan time.
    const late = at(NOW - 6 * HOUR);
    t.rows.push(late);
    const soon = await sharedScans("k", NOW - 12 * HOUR, 30, t.read, NOW + 40 * SEC);
    expect(soon.scans.map((s) => s.id)).not.toContain(late.id);
    const after = NOW + LATE_RECHECK_SECONDS * SEC;
    const result = await sharedScans("k", NOW - 12 * HOUR, 30, t.read, after);
    expect(t.reads[2]).toBe(after - LATE_WINDOW_MS);
    expect(result.scans.map((s) => s.id)).toContain(late.id);
  });

  it("reads everything again after an hour when the caller reaches further back", async () => {
    const deep = NOW - 10 * DAY;
    const t = table([at(NOW - 5 * DAY)]);
    await sharedScans("k", deep, 300, t.read, NOW);
    const veryLate = at(NOW - 4 * DAY);
    t.rows.push(veryLate);
    const after = NOW + WHOLE_RECHECK_SECONDS * SEC;
    const result = await sharedScans("k", deep, 300, t.read, after);
    expect(t.reads).toEqual([deep, deep]);
    expect(result.scans.map((s) => s.id)).toContain(veryLate.id);
  });

  it("keeps the weeks held when a shallow view does the hourly recheck", async () => {
    const deep = NOW - 30 * DAY;
    const old = at(NOW - 20 * DAY);
    const t = table([at(NOW - HOUR), at(NOW - 5 * DAY), old]);
    await sharedScans("k", deep, 300, t.read, NOW);
    expect(cacheStats().scanRows).toBe(3);

    // An hour on, the today view asks: from 36 hours before its midnight.
    const after = NOW + WHOLE_RECHECK_SECONDS * SEC;
    const shallow = after - 50 * HOUR;
    const late = at(after - 40 * HOUR);
    t.rows.push(late);
    const today = await sharedScans("k", shallow, 30, t.read, after);
    // It reads what it asks for, not the month, and sees the late scan.
    expect(t.reads).toEqual([deep, shallow]);
    expect(today.scans.map((s) => s.id)).toContain(late.id);
    expect(today.scans.map((s) => s.id)).not.toContain(old.id);
    // The month is still held.
    expect(cacheStats().scanRows).toBe(4);

    // The recheck is done for this hour: the next shallow read is a hit.
    await sharedScans("k", shallow, 30, t.read, after + 10 * SEC);
    expect(t.reads).toHaveLength(2);

    // A view that reaches further back has its own part read again (it is
    // over an hour old), added to what is held: nothing is read from scratch.
    const veryLate = at(NOW - 10 * DAY);
    t.rows.push(veryLate);
    const month = await sharedScans("k", deep, 300, t.read, after + 20 * SEC);
    expect(t.reads).toEqual([deep, shallow, deep]);
    expect(month.scans.map((s) => s.id)).toEqual(expect.arrayContaining([old.id, late.id, veryLate.id]));
    // And then both are answered from memory.
    await sharedScans("k", deep, 300, t.read, after + 30 * SEC);
    await sharedScans("k", shallow, 30, t.read, after + 35 * SEC);
    expect(t.reads).toHaveLength(3);
  });

  it("drops a row that is gone from OptiCloud when its part is read again", async () => {
    const gone = at(NOW - 2 * MIN);
    const t = table([at(NOW - MIN), gone]);
    await sharedScans("k", since, 30, t.read, NOW);
    t.rows.splice(t.rows.indexOf(gone), 1);
    const result = await sharedScans("k", since, 30, t.read, NOW + 40 * SEC);
    expect(result.scans).toHaveLength(1);
  });

  it("reads further back when a caller wants more than is held", async () => {
    const t = table([at(NOW - HOUR), at(NOW - 3 * DAY)]);
    await sharedScans("k", since, 30, t.read, NOW);
    const deeper = await sharedScans("k", NOW - 5 * DAY, 30, t.read, NOW + SEC);
    expect(t.reads).toEqual([since, NOW - 5 * DAY]);
    expect(deeper.scans).toHaveLength(2);
    // And the shorter read is then answered from the longer one.
    await sharedScans("k", since, 30, t.read, NOW + 2 * SEC);
    expect(t.reads).toHaveLength(2);
  });

  it("keeps tables apart", async () => {
    const a = table([at(NOW - HOUR)]);
    const b = table([]);
    await sharedScans("acc|a", since, 30, a.read, NOW);
    const other = await sharedScans("acc|b", since, 30, b.read, NOW);
    expect(other.scans).toEqual([]);
    expect(b.reads).toHaveLength(1);
  });

  it("makes callers that ask at the same time wait on one read", async () => {
    const t = table([at(NOW - HOUR)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async (from: number) => {
      await gate;
      return t.read(from);
    };
    const a = sharedScans("k", since, 30, slow, NOW);
    const b = sharedScans("k", since, 30, slow, NOW);
    const c = sharedScans("k", since, 30, slow, NOW);
    release();
    const results = await Promise.all([a, b, c]);
    expect(t.reads).toHaveLength(1);
    expect(results.map((r) => r.scans.length)).toEqual([1, 1, 1]);
  });

  it.each([
    ["401", () => new ApiAuthError("401")],
    ["403", () => new ApiAccessError("403")],
  ])("does not pass a refused token (%s) on to the others: each makes its own read", async (message, refusal) => {
    const t = table([at(NOW - HOUR)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first caller's token is refused. That says nothing about the next caller's.
    const refused = async () => {
      await gate;
      throw refusal();
    };
    const a = sharedScans("k", since, 30, refused, NOW);
    const b = sharedScans("k", since, 30, t.read, NOW);
    release();
    await expect(a).rejects.toThrow(message);
    expect((await b).scans).toHaveLength(1);
    // Nothing is left hanging: the next caller is answered from memory.
    await sharedScans("k", since, 30, t.read, NOW + SEC);
    expect(t.reads).toHaveLength(1);
  });

  it("hands any other failure on to the callers that waited, instead of one failed read each", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // OptiCloud is down: every read would time out.
    const down = async (): Promise<ReadResult> => {
      calls++;
      await gate;
      throw new Error("Optipeople API kunne ikke nås.");
    };
    const waiting = [1, 2, 3, 4].map(() => sharedScans("k", since, 30, down, NOW));
    release();
    const outcomes = await Promise.allSettled(waiting);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(calls).toBe(1);
    // The failure is not kept: the next caller reads again, and gets through.
    const t = table([at(NOW - HOUR)]);
    expect((await sharedScans("k", since, 30, t.read, NOW + SEC)).scans).toHaveLength(1);
  });

  it("hands on a truncated read as it is and keeps nothing of it", async () => {
    const truncated = async (): Promise<ReadResult> => ({
      scans: [at(NOW - HOUR)],
      pagesRead: MAX_PAGES,
      unordered: false,
      truncated: true,
    });
    const result = await sharedScans("k", since, 30, truncated, NOW);
    expect(result.truncated).toBe(true);
    expect(result.pagesRead).toBe(MAX_PAGES);
    expect(cacheStats().scanRows).toBe(0);
  });

  it("estimates a scan at a few hundred bytes", () => {
    const bytes = estimateScanBytes(at(NOW, { id: "0b9f6c1e-52a4-4d0e-9a57-3f1c2d4e5f60", device: "STATION-PC-01" }));
    expect(bytes).toBeGreaterThan(250);
    expect(bytes).toBeLessThan(600);
  });

  it("holds two months of scans in one copy", () => {
    // 62 days and the 36 hours before them, at 3 000 scans a day.
    const rows = 63.5 * 3000;
    const each = estimateScanBytes(at(NOW, { id: "0b9f6c1e-52a4-4d0e-9a57-3f1c2d4e5f60", device: "STATION-PC-01" }));
    expect(rows * each).toBeLessThan(MAX_SCAN_BYTES);
  });

  it("holds the most one read can bring back: every page up to the page ceiling", () => {
    const each = estimateScanBytes(at(NOW, { id: "0b9f6c1e-52a4-4d0e-9a57-3f1c2d4e5f60", device: "STATION-PC-01" }));
    expect(MAX_PAGES * PAGE_SIZE * each).toBeLessThan(MAX_SCAN_BYTES);
  });

  it("lets go of the oldest rows over the ceiling, and reads them again when asked", async () => {
    // Each scan is made to weigh a quarter of the ceiling, so only three fit.
    const heavy = "x".repeat(MAX_SCAN_BYTES / 8);
    const rows = [1, 2, 3, 4, 5].map((h) => at(NOW - h * HOUR, { device: heavy }));
    const t = table(rows);
    const first = await sharedScans("k", since, 30, t.read, NOW);
    // The caller still gets everything it asked for.
    expect(first.scans).toHaveLength(5);
    expect(cacheStats().scanRows).toBe(3);
    expect(cacheStats().scanBytes).toBeLessThanOrEqual(MAX_SCAN_BYTES);
    // What is held answers a read that it covers.
    const recent = await sharedScans("k", NOW - 150 * MIN, 30, t.read, NOW + SEC);
    expect(recent.scans).toHaveLength(2);
    expect(t.reads).toHaveLength(1);
    // A read that wants the rows let go goes back to OptiCloud: never a short answer.
    const again = await sharedScans("k", since, 30, t.read, NOW + 2 * SEC);
    expect(again.scans).toHaveLength(5);
    expect(t.reads).toHaveLength(2);
  });
});
