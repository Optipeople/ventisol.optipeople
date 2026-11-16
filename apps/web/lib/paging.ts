// Reading the scans for a period out of GetRowsPaged. Pure apart from the
// page loader it is handed, so the stopping rules are unit tested.
//
// GetRowsPaged has no date filter. Pages are asked for newest first
// (Orderby=ScanTime, IsAscending=false) and reading stops at the first page
// that ends before the period. Page 1 is read alone (it says how many pages
// there are, and is all a small read needs); the rest are fetched a few at a
// time and taken in page order, so a long period is not one request after
// another.
//
// If the server turns out to ignore the ordering, the early stop would lose
// rows, so as soon as the rows are seen out of order every remaining page is
// read and the period is filtered in memory. A stray row or two out of place
// is not that: it is tolerated (see INVERSIONS_ALLOWED and STOP_MARGIN_MS).
//
// Rows can move between pages while they are read (a new scan pushes every
// row one place down), so the same row can come back on the next page. Each
// ScanId is taken once, and a repeat never counts as out of order.

import { parseScanRow, type MasterDataRow, type Scan } from "@/lib/scans";

export const PAGE_SIZE = 500;

/**
 * Hard ceiling, so a runaway table cannot keep a request busy forever. 600
 * pages are 300 000 rows, about 100 days at 3 000 scans a day.
 */
export const MAX_PAGES = 600;

/** Pages fetched at once after the first. */
export const PAGE_CONCURRENCY = 6;

/**
 * Reading goes on until a page ends this long before the period, so a row a
 * little out of place near the boundary (two scans in the same second, a scan
 * written while the pages were read) is still picked up.
 */
export const STOP_MARGIN_MS = 10 * 60_000;

/**
 * Rows newer than the row before them that are put up with before the server
 * is taken to ignore the ordering: this many, plus one per hundred rows read.
 * A server that really ignores it passes that within the first page.
 */
export const INVERSIONS_ALLOWED = 2;

export interface RowsPage {
  rows: MasterDataRow[];
  /** Total pages, when the API says. */
  totalPage?: number | null;
}

export interface ReadResult {
  scans: Scan[];
  /** Pages asked for. */
  pagesRead: number;
  /** The server did not return rows newest first, so every page was read. */
  unordered: boolean;
  /**
   * Stopped at MAX_PAGES with pages left: the read never got back to `since`,
   * so the oldest part of the period is missing. Callers must not show numbers
   * from it as if they were whole.
   */
  truncated: boolean;
}

export async function readScansSince(
  loadPage: (page: number) => Promise<RowsPage>,
  since: number,
  maxPages = MAX_PAGES,
  concurrency = PAGE_CONCURRENCY
): Promise<ReadResult> {
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let parsed = 0;
  let inversions = 0;
  let unordered = false;
  let previousTime = Number.POSITIVE_INFINITY;
  let pagesRead = 0;

  const result = (truncated: boolean): ReadResult => ({ scans, pagesRead, unordered, truncated });

  /** Takes one page's rows. True when the page ends before the period. */
  const take = (rows: MasterDataRow[]): boolean => {
    let lastTime: number | null = null;
    for (const row of rows) {
      const scan = parseScanRow(row);
      if (!scan || seen.has(scan.id)) continue;
      seen.add(scan.id);
      parsed++;
      if (scan.time > previousTime) inversions++;
      previousTime = scan.time;
      lastTime = scan.time;
      if (scan.time >= since) scans.push(scan);
    }
    if (inversions > INVERSIONS_ALLOWED + Math.floor(parsed / 100)) unordered = true;
    return lastTime != null && lastTime < since - STOP_MARGIN_MS;
  };

  if (maxPages < 1) return result(false);

  const first = await loadPage(1);
  pagesRead = 1;
  if (first.rows.length === 0) return result(false);
  let endsBefore = take(first.rows);
  let total = first.totalPage != null && first.totalPage > 0 ? first.totalPage : null;

  if (total == null) {
    // No page count: one page at a time, and a page shorter than the first is
    // the last. Not shorter than PAGE_SIZE: the server may cap pageSize below
    // what was asked for, and every page would then look like the last one.
    const fullPage = first.rows.length;
    let rows = first.rows;
    for (let page = 2; ; page++) {
      if (rows.length < fullPage) return result(false);
      if (endsBefore && !unordered) return result(false);
      if (page > maxPages) return result(true);
      rows = (await loadPage(page)).rows;
      pagesRead = page;
      if (rows.length === 0) return result(false);
      endsBefore = take(rows);
    }
  }

  // Trust totalPage when it is there: a short page does not mean "last" (the
  // server may cap pageSize below what was asked for).
  if (total <= 1 || (endsBefore && !unordered)) return result(false);

  const batchSize = Math.max(1, concurrency);
  let next = 2;
  while (next <= Math.min(total, maxPages)) {
    const last = Math.min(total, maxPages, next + batchSize - 1);
    const pages = Array.from({ length: last - next + 1 }, (_, i) => next + i);
    const loaded = await Promise.all(pages.map((page) => loadPage(page)));
    pagesRead = last;
    for (const { rows, totalPage } of loaded) {
      if (rows.length === 0) return result(false);
      // The table may have grown while it was read.
      if (totalPage != null && totalPage > total) total = totalPage;
      if (take(rows) && !unordered) return result(false);
    }
    next = last + 1;
  }

  return result(total > maxPages);
}
