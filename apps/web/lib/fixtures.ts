// Dev-only fixture data (see lib/fixtures-flag.ts). Serves the sample rows in
// fixtures/scans.json through the same paging and parsing as the real API,
// moved in time so the file's reference day lands on today. Rows later than
// now are left out, so today's last elements show as in progress.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import { PAGE_SIZE, type RowsPage } from "@/lib/paging";
import { getValue, parseScanTime, type MasterDataRow } from "@/lib/scans";
import { dayKey, daysBetween, MS_PER_DAY } from "@/lib/time";

interface FixtureFile {
  referenceDay: string;
  rows: MasterDataRow[];
}

let cached: { day: string; rows: MasterDataRow[] } | null = null;

async function fixtureRows(now: number): Promise<MasterDataRow[]> {
  if (!fixturesEnabled()) throw new Error("Fixture mode is off.");
  const today = dayKey(now);
  if (!cached || cached.day !== today) {
    const text = await readFile(join(process.cwd(), "fixtures", "scans.json"), "utf8");
    const file = JSON.parse(text) as FixtureFile;
    const shift = daysBetween(file.referenceDay, today) * MS_PER_DAY;
    const rows = file.rows.map((row) => {
      const values = { ...row.values };
      for (const key of Object.keys(values)) {
        if (key.toLowerCase() === "scantime") {
          const t = parseScanTime(values[key]);
          if (t != null) values[key] = new Date(t + shift).toISOString();
        }
      }
      return { ...row, values };
    });
    cached = { day: today, rows };
  }
  return cached.rows
    .filter((row) => (parseScanTime(getValue(row.values, "ScanTime")) ?? 0) <= now)
    .sort(
      (a, b) =>
        (parseScanTime(getValue(b.values, "ScanTime")) ?? 0) -
        (parseScanTime(getValue(a.values, "ScanTime")) ?? 0)
    );
}

/** A page loader with the same shape as GetRowsPaged, newest first. */
export function fixturePageLoader(now: number): (page: number) => Promise<RowsPage> {
  return async (page) => {
    const rows = await fixtureRows(now);
    const totalPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPage };
  };
}
