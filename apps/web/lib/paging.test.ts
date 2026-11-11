import { describe, expect, it } from "vitest";
import { MAX_PAGES, PAGE_CONCURRENCY, PAGE_SIZE, readScansSince, STOP_MARGIN_MS, type RowsPage } from "@/lib/paging";
import type { MasterDataRow } from "@/lib/scans";

const T0 = Date.UTC(2026, 9, 21, 12);
const MIN = 60_000;
/** Minutes the read goes past the period before it stops. */
const MARGIN = STOP_MARGIN_MS / MIN;

function row(i: number, time: number): MasterDataRow {
  return {
    id: `r${i}`,
    values: {
      ScanId: `s${i}`,
      Barcode: "058556050103",
      Station: "Station 10",
      Direction: i % 2 ? "In" : "Out",
      ScanTime: new Date(time).toISOString(),
    },
  };
}

/** Serves `rows` `size` to a page and notes which pages were asked for. */
function pagedLoader(rows: MasterDataRow[], size = PAGE_SIZE, withTotal = true) {
  const calls: number[] = [];
  const load = async (page: number): Promise<RowsPage> => {
    calls.push(page);
    return {
      rows: rows.slice((page - 1) * size, page * size),
      totalPage: withTotal ? Math.ceil(rows.length / size) : null,
    };
  };
  return { load, calls };
}

/** `n` rows one minute apart, newest first. */
const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => row(i, T0 - i * MIN));

describe("readScansSince", () => {
  it("reads only the first page when it reaches back past the period", async () => {
    const { load, calls } = pagedLoader(newestFirst(3 * PAGE_SIZE));
    const result = await readScansSince(load, T0 - 100 * MIN);
    expect(calls).toEqual([1]);
    expect(result.scans).toHaveLength(101);
    expect(result).toMatchObject({ pagesRead: 1, unordered: false, truncated: false });
  });

  it("stops at the page that reaches back past the period", async () => {
    const { load, calls } = pagedLoader(newestFirst(20 * PAGE_SIZE));
    const since = T0 - (PAGE_SIZE + 10) * MIN;
    const result = await readScansSince(load, since);
    // Page 1 alone, then one batch: page 2 already ends before the period.
    expect(calls).toEqual([1, ...Array.from({ length: PAGE_CONCURRENCY }, (_, i) => i + 2)]);
    expect(result.scans).toHaveLength(PAGE_SIZE + 11);
    expect(result.unordered).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("reads on until a page ends a margin before the period", async () => {
    // Page 1 ends 1 minute before the period: inside the margin, so page 2 is read too.
    const { load, calls } = pagedLoader(newestFirst(2 * PAGE_SIZE));
    const result = await readScansSince(load, T0 - (PAGE_SIZE - 2) * MIN);
    expect(MARGIN).toBeGreaterThan(1);
    expect(calls).toEqual([1, 2]);
    expect(result.scans).toHaveLength(PAGE_SIZE - 1);
  });

  it("reads to the last page when nothing is older than the period", async () => {
    const { load, calls } = pagedLoader(newestFirst(2 * PAGE_SIZE + 3));
    const result = await readScansSince(load, 0);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.scans).toHaveLength(2 * PAGE_SIZE + 3);
  });

  it("fetches the pages after the first a few at a time, and keeps them in page order", async () => {
    const rows = newestFirst(10 * PAGE_SIZE);
    let running = 0;
    let most = 0;
    const load = async (page: number): Promise<RowsPage> => {
      running++;
      most = Math.max(most, running);
      // Later pages answer first, so the order has to come from the page number.
      await new Promise((r) => setTimeout(r, 12 - page));
      running--;
      return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPage: 10 };
    };
    const result = await readScansSince(load, 0);
    expect(most).toBe(PAGE_CONCURRENCY);
    expect(result.pagesRead).toBe(10);
    expect(result.unordered).toBe(false);
    expect(result.scans.map((s) => s.id)).toEqual(rows.map((_, i) => `s${i}`));
  });

  it("reads every page when the server ignores the ordering", async () => {
    const shuffled = newestFirst(3 * PAGE_SIZE).reverse();
    const { load, calls } = pagedLoader(shuffled);
    const since = T0 - 100 * MIN;
    const result = await readScansSince(load, since);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.unordered).toBe(true);
    expect(result.scans).toHaveLength(101);
  });

  it("puts up with a row or two out of place without reading the whole table", async () => {
    const rows = newestFirst(20 * PAGE_SIZE);
    // Two neighbours swapped on page 1, as two scans in the same second can be.
    [rows[40], rows[41]] = [rows[41], rows[40]];
    const { load, calls } = pagedLoader(rows);
    const result = await readScansSince(load, T0 - 100 * MIN);
    expect(result.unordered).toBe(false);
    expect(calls).toEqual([1]);
    expect(result.scans).toHaveLength(101);
  });

  it("takes each scan once when rows move between pages while they are read", async () => {
    // A new scan arrives after every page read, pushing every row one place
    // down, so each page starts with rows the page before ended with.
    const all = newestFirst(3 * PAGE_SIZE);
    let extra = 0;
    const calls: number[] = [];
    const load = async (page: number): Promise<RowsPage> => {
      calls.push(page);
      const rows = [...Array.from({ length: extra }, (_, i) => row(10_000 + i, T0 + (i + 1) * MIN)).reverse(), ...all];
      extra += 3;
      return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPage: Math.ceil(rows.length / PAGE_SIZE) };
    };
    // One page at a time, so each page sees more new rows than the one before.
    const result = await readScansSince(load, 0, undefined, 1);
    expect(result.unordered).toBe(false);
    const ids = result.scans.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every row that was there from the start is read, none twice.
    expect(ids.filter((id) => Number(id.slice(1)) < 10_000)).toHaveLength(3 * PAGE_SIZE);
    // The table grew to a fourth page under the read, and that page was read.
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  it("trusts totalPage over a short page", async () => {
    // A server that caps pages at 100 rows even when 500 are asked for.
    const { load, calls } = pagedLoader(newestFirst(250), 100);
    const result = await readScansSince(load, 0);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.scans).toHaveLength(250);
  });

  describe("without totalPage", () => {
    it("reads one page at a time until a short page", async () => {
      const { load, calls } = pagedLoader(newestFirst(2 * PAGE_SIZE + 3), PAGE_SIZE, false);
      const result = await readScansSince(load, 0);
      expect(calls).toEqual([1, 2, 3]);
      expect(result.scans).toHaveLength(2 * PAGE_SIZE + 3);
      expect(result.truncated).toBe(false);
    });

    it("reads one more, empty page when the last page is full", async () => {
      const { load, calls } = pagedLoader(newestFirst(2 * PAGE_SIZE), PAGE_SIZE, false);
      const result = await readScansSince(load, 0);
      expect(calls).toEqual([1, 2, 3]);
      expect(result.scans).toHaveLength(2 * PAGE_SIZE);
      expect(result.truncated).toBe(false);
    });

    it("does not take a page the server capped below the page size for the last one", async () => {
      // A server that caps pages at 100 rows even when 500 are asked for.
      const { load, calls } = pagedLoader(newestFirst(250), 100, false);
      const result = await readScansSince(load, 0);
      expect(calls).toEqual([1, 2, 3]);
      expect(result.scans).toHaveLength(250);
      expect(result.truncated).toBe(false);
    });

    it("reads one more, empty page when the first page is short: it cannot tell a cap from the end", async () => {
      const { load, calls } = pagedLoader(newestFirst(3), PAGE_SIZE, false);
      const result = await readScansSince(load, 0);
      expect(calls).toEqual([1, 2]);
      expect(result.scans).toHaveLength(3);
      expect(result.truncated).toBe(false);
    });

    it("stops at a short first page that already reaches back past the period", async () => {
      const { load, calls } = pagedLoader(newestFirst(250), 100, false);
      const result = await readScansSince(load, T0 - 50 * MIN);
      expect(calls).toEqual([1]);
      expect(result.scans).toHaveLength(51);
    });

    it("still stops at the page that reaches back past the period", async () => {
      const { load, calls } = pagedLoader(newestFirst(5 * PAGE_SIZE), PAGE_SIZE, false);
      const result = await readScansSince(load, T0 - (PAGE_SIZE + 10) * MIN);
      expect(calls).toEqual([1, 2]);
      expect(result.scans).toHaveLength(PAGE_SIZE + 11);
    });

    it("gives up at the page ceiling and says so", async () => {
      const { load, calls } = pagedLoader(newestFirst(5 * PAGE_SIZE), PAGE_SIZE, false);
      const result = await readScansSince(load, 0, 2);
      expect(calls).toEqual([1, 2]);
      expect(result.truncated).toBe(true);
    });
  });

  it("has a page ceiling with room over the longest read the site makes", () => {
    // 62 days and the 36 hours before them at 3 000 scans a day, and half as much again.
    expect(MAX_PAGES).toBe(600);
    expect(MAX_PAGES * PAGE_SIZE).toBeGreaterThanOrEqual(63.5 * 3000 * 1.5);
  });

  it("stops at an empty page", async () => {
    const result = await readScansSince(async () => ({ rows: [], totalPage: 0 }), 0);
    expect(result.scans).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("gives up at the page ceiling and says so", async () => {
    const { load, calls } = pagedLoader(newestFirst(5 * PAGE_SIZE));
    const result = await readScansSince(load, 0, 2);
    expect(calls).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
    expect(result.scans).toHaveLength(2 * PAGE_SIZE);
  });

  it("is not truncated when the period ends inside the page ceiling", async () => {
    const { load } = pagedLoader(newestFirst(5 * PAGE_SIZE));
    const result = await readScansSince(load, T0 - 100 * MIN, 2);
    expect(result.truncated).toBe(false);
    expect(result.scans).toHaveLength(101);
  });

  it("fails as a whole when one page of a batch fails", async () => {
    const { load } = pagedLoader(newestFirst(5 * PAGE_SIZE));
    const failing = async (page: number) => {
      if (page === 3) throw new Error("page 3 is gone");
      return load(page);
    };
    await expect(readScansSince(failing, 0)).rejects.toThrow("page 3 is gone");
  });
});
