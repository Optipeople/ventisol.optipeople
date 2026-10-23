// Reading the scans for a period out of GetRowsPaged. Pure apart from the
// page loader it is handed, so the stopping rules are unit tested.
//
// GetRowsPaged has no date filter. Pages are asked for newest first
// (Orderby=ScanTime, IsAscending=false) and reading stops at the first row
// older than the period. If the server turns out to ignore the ordering, the
// early stop would lose rows, so as soon as a page is seen out of order every
// remaining page is read and the period is filtered in memory.

import { parseScanRow, type MasterDataRow, type Scan } from "@/lib/scans";

export const PAGE_SIZE = 500;

/** Hard ceiling, so a runaway table cannot keep a request busy forever. */
export const MAX_PAGES = 400;

export interface RowsPage {
  rows: MasterDataRow[];
  /** Total pages, when the API says. */
  totalPage?: number | null;
}

export interface ReadResult {
  scans: Scan[];
  pagesRead: number;
  /** The server did not return rows newest first, so every page was read. */
  unordered: boolean;
  /** Stopped at MAX_PAGES with pages left. */
  truncated: boolean;
}

export async function readScansSince(
  loadPage: (page: number) => Promise<RowsPage>,
  since: number,
  maxPages = MAX_PAGES
): Promise<ReadResult> {
  const scans: Scan[] = [];
  let unordered = false;
  let previousTime = Number.POSITIVE_INFINITY;
  let page = 1;

  for (; page <= maxPages; page++) {
    const { rows, totalPage } = await loadPage(page);
    if (rows.length === 0) break;

    let reachedOlder = false;
    for (const row of rows) {
      const scan = parseScanRow(row);
      if (!scan) continue;
      if (scan.time > previousTime) unordered = true;
      previousTime = scan.time;
      if (scan.time >= since) scans.push(scan);
      else reachedOlder = true;
    }

    // Trust totalPage when it is there; a short page only means "last" when it
    // is not (the server may cap pageSize below what was asked for).
    const lastPage =
      totalPage != null && totalPage > 0 ? page >= totalPage : rows.length < PAGE_SIZE;
    if (lastPage) return { scans, pagesRead: page, unordered, truncated: false };
    if (reachedOlder && !unordered) return { scans, pagesRead: page, unordered, truncated: false };
  }

  return {
    scans,
    pagesRead: Math.min(page, maxPages),
    unordered,
    truncated: page > maxPages,
  };
}
