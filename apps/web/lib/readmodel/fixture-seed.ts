// Fills the fixture database (VENTISOL_FIXTURES=1 under `next dev`) with what
// the portal's reports need: master data in config.*, the synthetic 3E lists
// in raw.order_documents, the scan history in raw.scans, and core.* built
// from them by the real writer.
//
// It is registered as the fixture seed "readmodel" at the bottom of this
// file. lib/fixtures.ts imports this file for that side effect, and
// lib/fixtures.ts is loaded by every page (lib/auth.ts, lib/opticloud.ts), so
// the seed runs before the first query of the dev server is answered.
//
// The sync seed of lib/sync puts the same scans in raw.scans through the real
// sync code (it reads them from fixturePageLoader in lib/fixtures.ts). The two
// seeds meet only in the database, and either may run first: the scans go in
// here with `on conflict (scan_id) do nothing`, and rebuildAll derives from
// whatever raw.scans holds.

import { onFixtureDbReady, type DbHandle } from "@/lib/db";
import { DEFAULT_ELEMENT_TYPE_RULES, ELEMENT_TYPES } from "@/lib/orderdoc/element-types";
import { getValue, type MasterDataRow } from "@/lib/scans";
import { loadFixtureHistory, type FixtureDocument, type FixtureHistory } from "./fixture-history";
import { rebuildAll, type RebuildResult } from "./index";

export interface FixtureSeedResult extends RebuildResult {
  scans: number;
  documents: number;
  /** Milliseconds: writing raw.* and config.*, then rebuildAll. */
  rawMs: number;
  rebuildMs: number;
}

/** Scans per insert statement. */
const SCAN_BATCH = 5000;

/**
 * Normal time against the generator's own pass time, per station. Station 20
 * is given a normal time it cannot keep, so "Langsommere" has a case.
 */
const NORMAL_FACTOR: Record<number, number> = { 2: 0.75 };

/** Calculated time against the normal time, per element type: some over, some under. */
const CALCULATED_FACTOR: Record<string, number> = {
  "vindue-1-fag": 0.95,
  "vindue-2-fag": 1.0,
  "vindue-3-fag": 0.8,
  doer: 1.25,
  terrassedoer: 0.9,
};

const roundTo10 = (seconds: number) => Math.max(10, Math.round(seconds / 10) * 10);

/** Stations, element types with their recognition rules, normal and calculated times. Rows that are there stay. */
export async function seedFixtureConfig(handle: DbHandle, history: FixtureHistory): Promise<void> {
  // Rules are read in sort order, so the types are sorted as the rules are.
  const types = ELEMENT_TYPES.map((type) => {
    const at = DEFAULT_ELEMENT_TYPE_RULES.findIndex((r) => r.type === type.id);
    const rule = at >= 0 ? { ...DEFAULT_ELEMENT_TYPE_RULES[at] } : null;
    if (rule) delete (rule as { type?: string }).type;
    return {
      id: type.id,
      name: type.name,
      recognition: rule,
      sort_order: (at >= 0 ? at + 1 : DEFAULT_ELEMENT_TYPE_RULES.length + 1) * 10,
    };
  });
  const stations = history.stations.map((s) => ({
    station_no: s.stationNo,
    name: s.name,
    kind: s.kind.toLowerCase() === "packing" ? "packing" : "assembly",
    sort_order: s.stationNo * 10,
  }));
  const normal: { station_no: number; element_type_id: string; seconds: number }[] = [];
  const calculated: typeof normal = [];
  for (const s of history.stations) {
    for (const [typeId, factor] of Object.entries(CALCULATED_FACTOR)) {
      const seconds = roundTo10(s.typicalSeconds * (history.typeFactors[typeId] ?? 1) * (NORMAL_FACTOR[s.stationNo] ?? 1));
      normal.push({ station_no: s.stationNo, element_type_id: typeId, seconds });
      // Packing is not part of a quotation.
      if (s.kind.toLowerCase() !== "packing") {
        calculated.push({ station_no: s.stationNo, element_type_id: typeId, seconds: roundTo10(seconds * factor) });
      }
    }
  }

  await handle.withService(async (db) => {
    await db.query(
      `insert into config.stations (station_no, name, kind, sort_order, active)
       select station_no, name, kind, sort_order, true
         from jsonb_to_recordset($1::jsonb) as s(station_no integer, name text, kind text, sort_order integer)
       on conflict (station_no) do nothing`,
      [JSON.stringify(stations)]
    );
    await db.query(
      `insert into config.element_types (id, name, recognition, sort_order, active)
       select id, name, nullif(recognition, 'null'::jsonb), sort_order, true
         from jsonb_to_recordset($1::jsonb) as t(id text, name text, recognition jsonb, sort_order integer)
       on conflict (id) do nothing`,
      [JSON.stringify(types)]
    );
    for (const [table, rows] of [
      ["config.normal_times", normal],
      ["config.calculated_times", calculated],
    ] as const) {
      await db.query(
        `insert into ${table} (station_no, element_type_id, seconds, source, updated_by)
         select station_no, element_type_id, seconds, 'manual', 'fixtures'
           from jsonb_to_recordset($1::jsonb) as t(station_no integer, element_type_id text, seconds integer)
          where exists (select 1 from config.element_types e where e.id = t.element_type_id)
         on conflict (station_no, element_type_id) do nothing`,
        [JSON.stringify(rows)]
      );
    }
  });
}

/** Writes fixture documents to raw.order_documents as parsed 3E lists. Rows that are there stay. */
export async function insertFixtureDocuments(handle: DbHandle, list: FixtureDocument[], now: number): Promise<void> {
  if (list.length === 0) return;
  const documents = list.map((d) => ({
    file_name: d.fileName,
    order_no: d.orderNo,
    print_date: d.printDate,
    parsed: d.parsed,
    parser_version: d.parsed.parserVersion,
  }));
  await handle.withService(async (db) => {
    await db.query(
      `insert into raw.order_documents
         (file_name, order_no, prefix, print_date, content_type, device, synced_at, parsed, parsed_at, parser_version, parse_problems)
       select file_name, order_no, '', print_date, 'application/pdf', 'FIXTURES', $2::timestamptz,
              parsed, $2::timestamptz, parser_version, '[]'::jsonb
         from jsonb_to_recordset($1::jsonb) as d(
                file_name text, order_no integer, print_date date, parsed jsonb, parser_version text)
       on conflict (file_name) do nothing`,
      [JSON.stringify(documents), new Date(now).toISOString()]
    );
  });
}

/**
 * Writes master-data rows to raw.scans, as the scan sync would. Rows that are
 * there stay (on conflict on scan_id), so it can run before or after the sync.
 */
export async function insertFixtureScans(handle: DbHandle, rows: MasterDataRow[], now: number): Promise<void> {
  const scans = rows.map((row) => {
    const v = (column: string) => getValue(row.values, column);
    return {
      scan_id: v("ScanId"),
      barcode: v("Barcode"),
      order_no: v("OrderNo"),
      position: v("Position"),
      sub_position: v("SubPosition"),
      piece: v("Piece"),
      station: v("Station"),
      station_no: v("StationNo"),
      station_kind: v("StationKind"),
      machine_id: v("MachineId"),
      direction: v("Direction"),
      scan_time: v("ScanTime"),
      duration_sec: v("DurationSec"),
      device: v("Device"),
      row_id: row.id,
      created_date: row.createdDate ?? null,
    };
  });
  const at = new Date(now).toISOString();
  // A batch per transaction: one statement each, and nothing held for long.
  for (let i = 0; i < scans.length; i += SCAN_BATCH) {
    await handle.withService((db) =>
      db.query(
        `insert into raw.scans
           (scan_id, barcode, order_no, position, sub_position, piece, station, station_no, station_kind,
            machine_id, direction, scan_time, duration_sec, device, row_id, created_date, synced_at)
         select scan_id, barcode, order_no, position, sub_position, piece, station, station_no, station_kind,
                machine_id, direction, scan_time, duration_sec, device, row_id, created_date, $2::timestamptz
           from jsonb_to_recordset($1::jsonb) as r(
                  scan_id text, barcode text, order_no integer, position integer, sub_position integer,
                  piece integer, station text, station_no integer, station_kind text, machine_id text,
                  direction text, scan_time timestamptz, duration_sec integer, device text, row_id text,
                  created_date timestamptz)
         on conflict (scan_id) do nothing`,
        [JSON.stringify(scans.slice(i, i + SCAN_BATCH)), at]
      )
    );
  }
}

/**
 * Seeds the database behind "@/lib/db" with the fixture history as it stands
 * at `now` and builds core.* from it. Idempotent: rows that are there stay
 * (an admin's edit of a station survives), and rebuildAll gives the same
 * core.* each time.
 *
 * `handle` writes config.* and raw.*; rebuildAll goes through the module's
 * own withService. In a fixture seed and in a test database (createTestDb)
 * the two are the same database.
 */
export async function seedFixtureReadModel(handle: DbHandle, now: number = Date.now()): Promise<FixtureSeedResult> {
  const started = performance.now();
  const history = await loadFixtureHistory(now);
  await seedFixtureConfig(handle, history);
  await insertFixtureDocuments(handle, history.documents, now);
  await insertFixtureScans(handle, history.rows, now);
  const rawDone = performance.now();
  const rebuilt = await rebuildAll(now, { restart: true });
  return {
    ...rebuilt,
    scans: history.rows.length,
    documents: history.documents.length,
    rawMs: Math.round(rawDone - started),
    rebuildMs: Math.round(performance.now() - rawDone),
  };
}

onFixtureDbReady("readmodel", async (handle) => {
  const result = await seedFixtureReadModel(handle);
  console.info(
    `Fixture read model: ${result.scans} scans, ${result.documents} documents, ${result.orders} orders, ` +
      `${result.stationDays} station days (raw ${result.rawMs} ms, rebuild ${result.rebuildMs} ms).`
  );
});
