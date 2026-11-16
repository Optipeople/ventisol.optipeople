// The read model writer against a real Postgres (PGlite). The scans are a
// slice of the synthetic fixture history: the newest orders, some packed,
// some in progress.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { getValue, type MasterDataRow } from "@/lib/scans";
import { dayKey } from "@/lib/time";
import { loadFixtureHistory, type FixtureDocument, type FixtureHistory } from "./fixture-history";
import { insertFixtureDocuments, insertFixtureScans, seedFixtureConfig } from "./fixture-seed";
import {
  applyDocumentChanges,
  applyScanChanges,
  continueRebuild,
  onCalendarChanged,
  onElementTypesChanged,
  onSettingsChanged,
  READMODEL_STATE,
  REBUILD_STATE,
  rebuildAll,
  type ChangedScan,
} from "./index";

// A Friday, 13:30 in Copenhagen: the day shift is running.
const NOW = Date.UTC(2026, 10, 13, 12, 30);
const MINUTE = 60_000;

let db: TestDb;
let history: FixtureHistory;
/** Scans of the newest orders, oldest first. */
let rows: MasterDataRow[];
let documents: FixtureDocument[];
let orderNos: number[];

const orderOf = (row: MasterDataRow) => Number(getValue(row.values, "OrderNo"));
const timeOf = (row: MasterDataRow) => Date.parse(String(getValue(row.values, "ScanTime")));

function changedOf(list: MasterDataRow[]): ChangedScan[] {
  return list.map((row) => ({
    scanId: String(getValue(row.values, "ScanId")),
    orderNo: orderOf(row),
    stationNo: Number(getValue(row.values, "StationNo")),
    barcode: String(getValue(row.values, "Barcode")),
    scanTime: timeOf(row),
  }));
}

/** A copy of a fixture scan with other values, as a new scan. */
function variant(row: MasterDataRow, id: string, values: Record<string, unknown>): MasterDataRow {
  const copy = JSON.parse(JSON.stringify(row)) as MasterDataRow;
  copy.id = `row-${id}`;
  const set = (column: string, value: unknown) => {
    const bag = copy.values as unknown;
    if (Array.isArray(bag)) {
      const cell = bag.find((c: { name?: string; key?: string }) => (c.name ?? c.key) === column);
      if (cell) (cell as { value: unknown }).value = value;
    } else {
      (bag as Record<string, unknown>)[column] = value;
    }
  };
  set("ScanId", id);
  for (const [column, value] of Object.entries(values)) set(column, value);
  return copy;
}

/** Small deterministic generator, so a failure can be repeated. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const query = <T>(sql: string, params: unknown[] = []) => db.withService((q) => q.query<T>(sql, params));
const one = async <T>(sql: string, params: unknown[] = []) => (await query<T>(sql, params))[0];

const TABLES: [string, string][] = [
  ["core.orders", "order_no"],
  ["core.elements", "barcode"],
  ["core.station_intervals", "interval_id"],
  ["core.order_steps", "order_no, step"],
  ["core.station_day_facts", "station_no, local_day"],
];

/** Every row of core.*, without the time it was computed. */
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, key] of TABLES) {
    const list = await query<{ row: string }>(
      `select (to_jsonb(t) - 'computed_at')::text as row from ${table} t order by ${key}`
    );
    out[table] = list.map((r) => r.row);
  }
  return out;
}

function expectSame(actual: Record<string, string[]>, expected: Record<string, string[]>) {
  for (const [table] of TABLES) {
    expect(actual[table].length, `${table}: number of rows`).toBe(expected[table].length);
    for (let i = 0; i < expected[table].length; i++) {
      if (actual[table][i] !== expected[table][i]) {
        expect(JSON.parse(actual[table][i]), `${table}, row ${i}`).toEqual(JSON.parse(expected[table][i]));
      }
    }
  }
}

async function seedAll() {
  await insertFixtureDocuments(db, documents, NOW);
  await insertFixtureScans(db, rows, NOW);
}

beforeAll(async () => {
  db = await createTestDb();
  history = await loadFixtureHistory(NOW);
  const all = [...new Set(history.rows.map(orderOf))].sort((a, b) => a - b);
  orderNos = all.slice(-40);
  const wanted = new Set(orderNos);
  rows = history.rows.filter((r) => wanted.has(orderOf(r))).sort((a, b) => timeOf(a) - timeOf(b));
  documents = history.documents.filter((d) => wanted.has(d.orderNo));
}, 120_000);

beforeEach(async () => {
  await db.reset();
  await seedFixtureConfig(db, history);
});

afterAll(() => db.close());

describe("incremental apply and full rebuild", () => {
  it("give the same core.*, whatever the batches and their order", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const full = await snapshot();
    expect(full["core.orders"].length).toBe(orderNos.length);

    for (const seed of [1, 2]) {
      await db.reset();
      await seedFixtureConfig(db, history);
      const random = rng(seed);

      // Every tenth scan is held back and arrives late, after newer ones.
      const late: MasterDataRow[] = [];
      const inOrder: MasterDataRow[] = [];
      for (const row of rows) (random() < 0.1 ? late : inOrder).push(row);
      // Half the documents are there from the start, the rest arrive on the way.
      const early = documents.filter(() => random() < 0.5);
      const laterDocs = documents.filter((d) => !early.includes(d));
      await insertFixtureDocuments(db, early, NOW);

      let at = 0;
      let batches = 0;
      while (at < inOrder.length || late.length > 0) {
        const size = 1 + Math.floor(random() * (seed === 1 ? 400 : 1500));
        const batch = inOrder.slice(at, at + size);
        at += size;
        // Late scans that are older than this batch come along with it.
        const batchEnd = batch.length > 0 ? timeOf(batch[batch.length - 1]) : NOW;
        while (late.length > 0 && (at >= inOrder.length || (timeOf(late[0]) < batchEnd - 3_600_000 && random() < 0.5))) {
          batch.push(late.shift()!);
        }
        if (batch.length === 0) continue;
        // The clock of the run: when its newest scan was made, as the minute sync would see it.
        const clock = Math.min(NOW, Math.max(...batch.map(timeOf)) + MINUTE);
        await insertFixtureScans(db, batch, clock);
        await applyScanChanges(changedOf(batch), clock);
        batches++;
        if (laterDocs.length > 0 && random() < 0.3) {
          const doc = laterDocs.shift()!;
          await insertFixtureDocuments(db, [doc], clock);
          await applyDocumentChanges([doc.orderNo], clock);
        }
      }
      await insertFixtureDocuments(db, laterDocs, NOW);
      await applyDocumentChanges(laterDocs.map((d) => d.orderNo), NOW);
      await applyScanChanges([], NOW);
      expect(batches).toBeGreaterThan(3);
      expectSame(await snapshot(), full);
    }
  }, 300_000);

  it("are idempotent", async () => {
    await seedAll();
    const changed = changedOf(rows);
    await applyScanChanges(changed, NOW);
    const first = await snapshot();
    const again = await applyScanChanges(changed, NOW);
    expect(again.orders).toBeGreaterThan(0);
    expectSame(await snapshot(), first);
    await applyDocumentChanges(orderNos, NOW);
    expectSame(await snapshot(), first);
    await rebuildAll(NOW, { restart: true });
    expectSame(await snapshot(), first);
    await rebuildAll(NOW, { restart: true });
    expectSame(await snapshot(), first);
  }, 120_000);

  it("measure one incremental apply", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    // The last minute of scans, as one sync run would deliver them.
    const last = rows.filter((r) => timeOf(r) > timeOf(rows[rows.length - 1]) - 5 * MINUTE);
    const started = performance.now();
    const result = await applyScanChanges(changedOf(last), NOW);
    console.info(
      `incremental apply of ${last.length} scans: ${Math.round(performance.now() - started)} ms, ` +
        `${result.orders} orders, ${result.stationDays} station days`
    );
    expect(result.orders).toBeGreaterThan(0);
  }, 120_000);
});

describe("documents", () => {
  it("a document arriving after the scans flips packed detection and gives the element types", async () => {
    // A packed order with a document and at least two elements; one element's scans never arrive.
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const order = await one<{ order_no: number; barcode: string }>(
      `select o.order_no, (select min(barcode) from core.elements e where e.order_no = o.order_no) as barcode
         from core.orders o
        where o.status = 'packed' and o.packed_source = 'document' and o.elements_seen >= 2
          and o.elements_seen = o.elements_expected
        order by o.order_no limit 1`
    );
    expect(order).toBeDefined();

    await db.reset();
    await seedFixtureConfig(db, history);
    const mine = rows.filter(
      (r) => orderOf(r) === order.order_no && String(getValue(r.values, "Barcode")) !== order.barcode
    );
    await insertFixtureScans(db, mine, NOW);
    await applyScanChanges(changedOf(mine), NOW);

    const before = await one<Record<string, unknown>>("select * from core.orders where order_no = $1", [order.order_no]);
    expect(before.status).toBe("packed");
    expect(before.packed_source).toBe("scans");
    expect(before.expected_source).toBe("scans");
    expect(before.elements_expected).toBeNull();
    expect(before.customer).toBeNull();
    const typesBefore = await one<{ n: number }>(
      "select count(*) as n from core.elements where order_no = $1 and element_type_id is not null",
      [order.order_no]
    );
    expect(Number(typesBefore.n)).toBe(0);

    await insertFixtureDocuments(db, documents.filter((d) => d.orderNo === order.order_no), NOW);
    const result = await applyDocumentChanges([order.order_no], NOW);
    expect(result.orders).toBeGreaterThanOrEqual(1);

    const after = await one<Record<string, unknown>>("select * from core.orders where order_no = $1", [order.order_no]);
    expect(after.status).toBe("in_progress");
    expect(after.packed_at).toBeNull();
    expect(after.expected_source).toBe("document");
    expect(after.elements_expected).toBe(Number(before.elements_seen) + 1);
    expect(after.customer).toEqual(expect.any(String));
    expect(after.delivery_week).toEqual(expect.any(Number));
    expect((after.missing_elements as unknown[]).length).toBe(1);
    const types = await one<{ typed: number; total: number; in_document: number }>(
      `select count(element_type_id) as typed, count(*) as total, count(*) filter (where in_document) as in_document
         from core.elements where order_no = $1`,
      [order.order_no]
    );
    expect(Number(types.typed)).toBe(Number(types.total));
    expect(Number(types.in_document)).toBe(Number(types.total));
    const passes = await one<{ untyped: number }>(
      "select count(*) filter (where element_type_id is null) as untyped from core.station_intervals where order_no = $1",
      [order.order_no]
    );
    expect(Number(passes.untyped)).toBe(0);
  }, 120_000);

  it("the newest print wins, and a document that could not be parsed is ignored", async () => {
    const doc = documents[0];
    const mine = rows.filter((r) => orderOf(r) === doc.orderNo);
    await insertFixtureScans(db, mine, NOW);
    await insertFixtureDocuments(db, [doc], NOW);
    const newer: FixtureDocument = JSON.parse(JSON.stringify(doc));
    newer.fileName = `${doc.orderNo}_29990101.pdf`;
    newer.printDate = "2026-11-12";
    newer.parsed.header.customer = ["Nyeste Kunde A/S"];
    await insertFixtureDocuments(db, [newer], NOW);
    // Newer still, but not parsed.
    await query(
      `insert into raw.order_documents (file_name, order_no, prefix, print_date, content_type, device, synced_at)
       values ($1, $2, '', '2026-11-13', 'application/pdf', 'FIXTURES', now())`,
      [`${doc.orderNo}_29990102.pdf`, doc.orderNo]
    );
    await applyScanChanges(changedOf(mine), NOW);
    const order = await one<{ customer: string }>("select customer from core.orders where order_no = $1", [doc.orderNo]);
    expect(order.customer).toBe("Nyeste Kunde A/S");
  });

  it("onElementTypesChanged works the types out again", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const before = await query<{ element_type_id: string; n: number }>(
      "select element_type_id, count(*) as n from core.elements group by 1 order by 1"
    );
    expect(before.length).toBeGreaterThan(2);
    // Every rule off: nothing is recognised any more.
    await query("update config.element_types set active = false");
    const result = await onElementTypesChanged(NOW);
    expect(result.orders).toBeGreaterThan(0);
    const after = await query<{ element_type_id: string | null }>(
      "select distinct element_type_id from core.elements e join core.orders o using (order_no) where o.expected_source = 'document'"
    );
    expect(after.length).toBeLessThan(before.length);
  }, 120_000);
});

describe("rebuildAll", () => {
  it("removes what raw.scans no longer holds", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const gone = orderNos[3];
    const kept = orderNos[5];
    const victim = await one<{ interval_id: string; out_scan_id: string; station_no: number; local_day: string }>(
      `select interval_id, out_scan_id, station_no, local_day::text as local_day from core.station_intervals
        where order_no = $1 and status = 'done' and out_scan_id is not null order by start_at limit 1`,
      [kept]
    );
    const dayBefore = await one<{ count_through: number }>(
      "select count_through from core.station_day_facts where station_no = $1 and local_day = $2::date",
      [victim.station_no, victim.local_day]
    );

    await query("delete from raw.scans where order_no = $1", [gone]);
    await query("delete from raw.scans where scan_id = $1", [victim.out_scan_id]);
    const result = await rebuildAll(NOW, { restart: true });
    expect(result.complete).toBe(true);

    for (const table of ["core.orders", "core.elements", "core.station_intervals", "core.order_steps"]) {
      const left = await one<{ n: number }>(`select count(*) as n from ${table} where order_no = $1`, [gone]);
      expect(Number(left.n), table).toBe(0);
    }
    const pass = await one<{ status: string }>("select status from core.station_intervals where interval_id = $1", [
      victim.interval_id,
    ]);
    expect(pass.status).not.toBe("done");
    const dayAfter = await one<{ count_through: number }>(
      "select count_through from core.station_day_facts where station_no = $1 and local_day = $2::date",
      [victim.station_no, victim.local_day]
    );
    expect(dayAfter.count_through).toBeLessThan(dayBefore.count_through);

    // The same as a database that never held those scans.
    const now = await snapshot();
    await db.reset();
    await seedFixtureConfig(db, history);
    await seedAll();
    await query("delete from raw.scans where order_no = $1 or scan_id = $2", [gone, victim.out_scan_id]);
    await rebuildAll(NOW, { restart: true });
    expectSame(now, await snapshot());
  }, 120_000);

  it("removes station days nothing touches any more", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    await query("delete from raw.scans");
    await rebuildAll(NOW, { restart: true });
    for (const [table] of TABLES) {
      expect(Number((await one<{ n: number }>(`select count(*) as n from ${table}`)).n), table).toBe(0);
    }
  }, 120_000);

  it("never shows readers an empty or half core.orders", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const total = orderNos.length;
    const counts: number[] = [];
    const phases = new Set<string>();
    await rebuildAll(NOW, {
      restart: true,
      chunkSize: 5,
      onChunk: async ({ phase }) => {
        phases.add(phase);
        const c = await one<{ orders: number; with_steps: number; days: number }>(
          `select (select count(*) from core.orders) as orders,
                  (select count(distinct order_no) from core.order_steps) as with_steps,
                  (select count(*) from core.station_day_facts) as days`
        );
        counts.push(Number(c.orders));
        expect(Number(c.with_steps)).toBe(total);
        expect(Number(c.days)).toBeGreaterThan(0);
      },
    });
    expect(counts.length).toBeGreaterThan(5);
    expect(new Set(counts)).toEqual(new Set([total]));
    expect(phases).toEqual(new Set(["orders", "days"]));
  }, 120_000);

  it("stops at its time budget and goes on where it stopped", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const full = await snapshot();

    // Something to repair, so that the result shows the rest was done.
    await query("update core.orders set customer = 'forkert'");
    const first = await rebuildAll(NOW, { restart: true, chunkSize: 5, budgetMs: 0 });
    expect(first.complete).toBe(false);
    expect(first.orders).toBe(5);
    const state = await one<{ detail: { status: string; orderCursor: number } }>(
      "select detail from app.sync_state where name = $1",
      [REBUILD_STATE]
    );
    expect(state.detail.status).toBe("running");
    expect(state.detail.orderCursor).toEqual(expect.any(Number));
    const wrong = await one<{ n: number }>("select count(*) as n from core.orders where customer = 'forkert'");
    expect(Number(wrong.n)).toBeGreaterThan(0);

    // A sync run in between is harmless.
    await applyScanChanges([], NOW);

    let calls = 0;
    let result = first;
    while (!result.complete && calls < 200) {
      result = await continueRebuild(NOW, { chunkSize: 5, budgetMs: 0 });
      calls++;
    }
    expect(result.complete).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expectSame(await snapshot(), full);
    // Nothing left to continue.
    expect(await continueRebuild(NOW)).toEqual({ orders: 0, stationDays: 0, complete: true });
  }, 120_000);

  it("keeps its state in its own rows of app.sync_state", async () => {
    await query(
      `insert into app.sync_state (name, watermark, detail) values
         ('scans', 'w1', '{"a":1}'::jsonb), ('documents', 'w2', null), ('rebuild', null, '{"b":2}'::jsonb)`
    );
    const theirs = await query("select * from app.sync_state where name in ('scans', 'documents', 'rebuild') order by name");
    await seedAll();
    await applyScanChanges(changedOf(rows), NOW);
    await rebuildAll(NOW, { restart: true });
    expect(
      await query("select * from app.sync_state where name in ('scans', 'documents', 'rebuild') order by name")
    ).toEqual(theirs);
    const mine = await query<{ name: string; last_error: string | null; last_success_at: Date; rows_total: number; detail: { status: string } }>(
      "select * from app.sync_state where name in ($1, $2) order by name",
      [READMODEL_STATE, REBUILD_STATE]
    );
    expect(mine.map((m) => m.name)).toEqual([READMODEL_STATE, REBUILD_STATE]);
    for (const row of mine) {
      expect(row.last_error).toBeNull();
      expect(row.last_success_at.getTime()).toBe(NOW);
      expect(Number(row.rows_total)).toBe(orderNos.length);
    }
    expect(mine[0].detail.status).toBe("ok");
    expect(mine[1].detail.status).toBe("done");
  }, 120_000);
});

describe("stations", () => {
  it("a station number never seen gets a row, and an edited row is never overwritten", async () => {
    const base = rows[rows.length - 1];
    const scanAt = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
    const first = variant(base, "new-station-1", {
      StationNo: 42,
      Station: "Ny station",
      StationKind: "Packing",
      Direction: "In",
      ScanTime: scanAt(30),
    });
    await insertFixtureScans(db, [first], NOW);
    await applyScanChanges(changedOf([first]), NOW);
    const row = await one<Record<string, unknown>>("select * from config.stations where station_no = 42");
    expect(row).toMatchObject({ station_no: 42, name: "Ny station", kind: "packing", active: true });
    expect(row.sort_order).toBe(42);

    // An admin renames it and switches it off; the next scans carry another name.
    await query("update config.stations set name = 'Pakkebord B', kind = 'assembly', active = false, sort_order = 5 where station_no = 42");
    const edited = await one<Record<string, unknown>>("select * from config.stations where station_no = 42");
    const second = variant(base, "new-station-2", {
      StationNo: 42,
      Station: "Andet navn",
      StationKind: "Packing",
      Direction: "Out",
      ScanTime: scanAt(20),
    });
    await insertFixtureScans(db, [second], NOW);
    await applyScanChanges(changedOf([second]), NOW);
    await rebuildAll(NOW, { restart: true });
    expect(await one("select * from config.stations where station_no = 42")).toEqual(edited);

    // A rebuild finds stations too, here one that no incremental run was told about.
    const third = variant(base, "new-station-3", { StationNo: 43, Station: "Kun i raw", ScanTime: scanAt(10) });
    await insertFixtureScans(db, [third], NOW);
    await rebuildAll(NOW, { restart: true });
    expect(await one("select name, kind from config.stations where station_no = 43")).toEqual({
      name: "Kun i raw",
      kind: "assembly",
    });
  });
});

describe("the clock", () => {
  it("moves the orders in progress and today's station days, and nothing else", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const before = await query<{ order_no: number; status: string; elapsed_seconds: number; computed_at: Date }>(
      "select order_no, status, elapsed_seconds, computed_at from core.orders order by order_no"
    );
    const open = before.filter((o) => o.status === "in_progress");
    expect(open.length).toBeGreaterThan(0);
    const dayBefore = await query<{ station_no: number; observed_seconds: number }>(
      "select station_no, observed_seconds from core.station_day_facts where local_day = $1::date order by station_no",
      [dayKey(NOW)]
    );
    expect(dayBefore.length).toBeGreaterThan(0);

    const later = NOW + 10 * MINUTE;
    const result = await applyScanChanges([], later);
    expect(result.orders).toBe(open.length);
    expect(result.stationDays).toBeGreaterThanOrEqual(dayBefore.length);

    const after = await query<{ order_no: number; status: string; elapsed_seconds: number; computed_at: Date }>(
      "select order_no, status, elapsed_seconds, computed_at from core.orders order by order_no"
    );
    for (let i = 0; i < before.length; i++) {
      if (before[i].status === "in_progress") {
        expect(after[i].elapsed_seconds).toBe(before[i].elapsed_seconds + 600);
        expect(after[i].computed_at.getTime()).toBe(later);
      } else {
        expect(after[i]).toEqual(before[i]);
      }
    }
    const dayAfter = await query<{ station_no: number; observed_seconds: number; computed_at: Date }>(
      "select station_no, observed_seconds, computed_at from core.station_day_facts where local_day = $1::date order by station_no",
      [dayKey(NOW)]
    );
    for (let i = 0; i < dayBefore.length; i++) {
      expect(dayAfter[i].observed_seconds).toBe(dayBefore[i].observed_seconds + 600);
      expect(dayAfter[i].computed_at.getTime()).toBe(later);
    }
    // And it is what a rebuild at that time gives.
    const applied = await snapshot();
    await rebuildAll(later, { restart: true });
    expectSame(applied, await snapshot());
  }, 120_000);

  it("closes yesterday's station days on the first run of a new day", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const open = await one<{ n: number }>(
      "select count(*) as n from core.station_day_facts where local_day = $1::date and not is_complete",
      [dayKey(NOW)]
    );
    expect(Number(open.n)).toBeGreaterThan(0);
    // Monday morning, before the shift.
    const monday = Date.UTC(2026, 10, 16, 4, 0);
    await applyScanChanges([], monday);
    const left = await one<{ n: number }>(
      "select count(*) as n from core.station_day_facts where local_day < $1::date and not is_complete",
      [dayKey(monday)]
    );
    expect(Number(left.n)).toBe(0);
    const applied = await snapshot();
    await rebuildAll(monday, { restart: true });
    expectSame(applied, await snapshot());
  }, 120_000);
});

describe("configuration changes", () => {
  it("onCalendarChanged recomputes the working seconds", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    // A packed order that started on one day and was packed on a later one.
    const order = await one<{ order_no: number; day: string; lead_seconds: number; lead_working_seconds: number }>(
      `select order_no, start_local_day::text as day, lead_seconds, lead_working_seconds from core.orders
        where status = 'packed' and packed_local_day > start_local_day order by order_no limit 1`
    );
    expect(order).toBeDefined();
    const sum = async () =>
      one<{ lead: number; working: number; available: number }>(
        `select (select sum(lead_seconds) from core.orders) as lead,
                (select sum(lead_working_seconds) from core.orders) as working,
                (select sum(available_seconds) from core.station_day_facts) as available`
      );
    const before = await sum();

    // The shifts get two hours longer.
    await query("update config.calendar_shifts set end_time = time '16:00'");
    const result = await onCalendarChanged(NOW);
    expect(result.complete).toBe(true);
    expect(result.orders).toBe(orderNos.length);
    const longer = await sum();
    expect(Number(longer.lead)).toBe(Number(before.lead));
    expect(Number(longer.working)).toBeGreaterThan(Number(before.working));
    expect(Number(longer.available)).toBeGreaterThan(Number(before.available));

    // The order's first day is closed: its working time shrinks.
    const mid = await one<{ w: number }>("select lead_working_seconds as w from core.orders where order_no = $1", [
      order.order_no,
    ]);
    await query("insert into config.calendar_closed_days (day, name) values ($1::date, 'Lukket')", [order.day]);
    await onCalendarChanged(NOW);
    const after = await one<{ w: number; lead_seconds: number }>(
      "select lead_working_seconds as w, lead_seconds from core.orders where order_no = $1",
      [order.order_no]
    );
    expect(after.w).toBeLessThan(mid.w);
    expect(after.lead_seconds).toBe(order.lead_seconds);
  }, 120_000);

  it("onSettingsChanged rebuilds for the settings stored in core.*, and only for them", async () => {
    await seedAll();
    await rebuildAll(NOW, { restart: true });
    const before = await one<{ late: number; computed: Date }>(
      "select count(*) filter (where on_time is false) as late, min(computed_at) as computed from core.orders"
    );
    expect(Number(before.late)).toBeGreaterThan(0);

    // Read-time settings: nothing is done.
    const later = NOW + MINUTE;
    await query("update config.settings set value = '25' where key = 'slow_threshold_percent'");
    expect(await onSettingsChanged(["slow_threshold_percent", "deduct_off_shift", "buffer_capacity"], later)).toEqual({
      orders: 0,
      stationDays: 0,
      complete: true,
    });
    const untouched = await one<{ computed: Date }>("select max(computed_at) as computed from core.orders where status = 'packed'");
    expect(untouched.computed.getTime()).toBe(NOW);

    // A year of grace: no order is late any more.
    await query("update config.settings set value = '365' where key = 'late_threshold'");
    const result = await onSettingsChanged(["late_threshold"], later);
    expect(result.complete).toBe(true);
    expect(result.orders).toBe(orderNos.length);
    const after = await one<{ late: number }>("select count(*) filter (where on_time is false) as late from core.orders");
    expect(Number(after.late)).toBe(0);

    // The assumed Schirmer time is stored in the route.
    const assumed = async () =>
      one<{ seconds: number | null }>(
        "select max(duration_seconds) as seconds from core.order_steps where step = 'schirmer' and source = 'assumed'"
      );
    expect((await assumed()).seconds).toBe(3600);
    await query("update config.settings set value = '90' where key = 'schirmer_assumed_minutes_per_batch'");
    await onSettingsChanged(["schirmer_assumed_minutes_per_batch"], later);
    expect((await assumed()).seconds).toBe(5400);
  }, 120_000);

  it("a failure is recorded and thrown, and the next run clears it", async () => {
    await seedAll();
    await applyScanChanges(changedOf(rows), NOW);
    // A row the writer cannot store: a core.orders check fails on a week outside 1 to 53.
    await query("alter table core.orders add constraint test_block check (order_no <> $1) not valid".replace("$1", String(orderNos[0])));
    try {
      await expect(applyScanChanges(changedOf(rows.slice(0, 50)), NOW)).rejects.toThrow();
      await expect(rebuildAll(NOW, { restart: true })).rejects.toThrow();
      const failed = await query<{ name: string; last_error: string | null; detail: { status: string } }>(
        "select name, last_error, detail from app.sync_state where name in ($1, $2) order by name",
        [READMODEL_STATE, REBUILD_STATE]
      );
      expect(failed.every((f) => f.last_error && f.detail.status === "error")).toBe(true);
      // Nothing was lost: the failed transaction rolled back.
      expect(Number((await one<{ n: number }>("select count(*) as n from core.orders")).n)).toBe(orderNos.length);
    } finally {
      await query("alter table core.orders drop constraint test_block");
    }
    const result = await rebuildAll(NOW);
    expect(result.complete).toBe(true);
    const state = await one<{ last_error: string | null }>("select last_error from app.sync_state where name = $1", [REBUILD_STATE]);
    expect(state.last_error).toBeNull();
  }, 120_000);
});
