// Dev-only fixture data (see lib/fixtures-flag.ts). Serves the synthetic
// production history (fixtures/history.json, about 13 weeks ending today,
// see lib/readmodel/fixture-history.ts) through the same paging and parsing
// as the real API. Rows later than now are left out, so today's last
// elements show as in progress.
//
// fixtures/scans.json, the five sample days this file used to serve, is
// still there for the tests that read it directly (lib/derive).

import { fixturesEnabled } from "@/lib/fixtures-flag";
import { PAGE_SIZE, type RowsPage } from "@/lib/paging";
import { loadFixtureHistory } from "@/lib/readmodel/fixture-history";
// For its side effect: registers the fixture seed that fills config.*,
// raw.order_documents and core.* of the in-process fixture database.
import "@/lib/readmodel/fixture-seed";

/** A page loader with the same shape as GetRowsPaged, newest first. */
export function fixturePageLoader(now: number): (page: number) => Promise<RowsPage> {
  return async (page) => {
    if (!fixturesEnabled()) throw new Error("Fixture mode is off.");
    const { rows } = await loadFixtureHistory(now);
    const totalPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPage };
  };
}
