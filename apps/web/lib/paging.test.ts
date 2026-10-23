import { describe, expect, it } from "vitest";
import { PAGE_SIZE, readScansSince, type RowsPage } from "@/lib/paging";
import type { MasterDataRow } from "@/lib/scans";

const T0 = Date.UTC(2026, 9, 21, 12);
const MIN = 60_000;

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

/** `n` rows one minute apart, newest first, served `size` to a page. */
function pagedLoader(rows: MasterDataRow[], size = PAGE_SIZE) {
  const calls: number[] = [];
  const load = async (page: number): Promise<RowsPage> => {
    calls.push(page);
    return {
      rows: rows.slice((page - 1) * size, page * size),
      totalPage: Math.ceil(rows.length / size),
    };
  };
  return { load, calls };
}

const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => row(i, T0 - i * MIN));

describe("readScansSince", () => {
  it("stops at the first page that reaches back past the period", async () => {
    const { load, calls } = pagedLoader(newestFirst(3 * PAGE_SIZE));
    const since = T0 - (PAGE_SIZE + 10) * MIN;
    const result = await readScansSince(load, since);
    expect(calls).toEqual([1, 2]);
    expect(result.scans).toHaveLength(PAGE_SIZE + 11);
    expect(result.unordered).toBe(false);
  });

  it("reads to the last page when nothing is older than the period", async () => {
    const { load, calls } = pagedLoader(newestFirst(2 * PAGE_SIZE + 3));
    const result = await readScansSince(load, 0);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.scans).toHaveLength(2 * PAGE_SIZE + 3);
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

  it("trusts totalPage over a short page", async () => {
    // A server that caps pages at 100 rows even when 500 are asked for.
    const { load, calls } = pagedLoader(newestFirst(250), 100);
    const result = await readScansSince(load, 0);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.scans).toHaveLength(250);
  });

  it("stops at an empty page", async () => {
    const result = await readScansSince(async () => ({ rows: [], totalPage: 0 }), 0);
    expect(result.scans).toEqual([]);
  });

  it("gives up at the page ceiling and says so", async () => {
    const { load } = pagedLoader(newestFirst(5 * PAGE_SIZE));
    const result = await readScansSince(load, 0, 2);
    expect(result.truncated).toBe(true);
    expect(result.scans).toHaveLength(2 * PAGE_SIZE);
  });
});
