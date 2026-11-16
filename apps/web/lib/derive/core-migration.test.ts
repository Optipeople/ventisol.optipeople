// Applies every migration (PGlite, through lib/db/testing) and writes one
// derived order into core.*, to prove that the row types of lib/derive and
// the columns of 20261116110000_core.sql are the same thing, and that the
// access rules hold: every role reads, nobody but service writes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import type { Scan } from "@/lib/scans";
import { at, pass, PACKING, scan } from "@/lib/test-helpers";
import { DEFAULT_CALENDAR } from "./calendar";
import { deriveOrder } from "./order";
import { CORE_TABLES, insertSql, toSnake, type CoreTable } from "./rows";
import { deriveStationDay, stationStatus } from "./station";
import type { DerivedOrder, OrderInfo, StationDayFactsRow } from "./types";

const el = (piece: number): Partial<Scan> => ({ barcode: `0585560501${String(piece).padStart(2, "0")}`, position: 5, piece });

const info: OrderInfo = {
  orderNo: 58556,
  customer: "Hansen Byg",
  caseName: "Skolevej 12",
  deliveryAddress: "Skolevej 12, 8000 Aarhus",
  deliveryWeek: 43,
  deliveryYear: 2026,
  expectedElements: [{ position: 5, quantity: 3, elementTypeId: "vindue_1_fag", system: "Rationel", widthMm: 1188, heightMm: 1188 }],
};

// Two elements packed, one never scanned out at assembly (listed), the third still missing.
const scans = [
  ...pass(at("07:00"), at("07:30"), el(1)),
  ...pass(at("07:10"), at("08:00"), { ...el(2), station: "Station 20", stationNo: 2 }),
  scan("In", at("07:00", "2026-10-19"), el(3)),
  ...pass(at("08:30"), at("08:40"), { ...el(1), ...PACKING }),
  ...pass(at("09:20"), at("09:30"), { ...el(2), ...PACKING }),
];
const now = at("12:00");
const ctx = {
  now,
  calendar: DEFAULT_CALENDAR,
  typical: {
    stations: [
      { stationNo: 1, kind: "assembly" as const, seconds: 600 },
      { stationNo: 7, kind: "packing" as const, seconds: 120 },
    ],
    waitBeforePackingSeconds: 300,
  },
};
const derived = deriveOrder(scans, info, ctx) as DerivedOrder;
const packingDay = deriveStationDay(7, "2026-10-21", derived.intervals, ctx) as StationDayFactsRow;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.withService(async (tx) => {
    const insert = async (table: CoreTable, row: object) => {
      const { sql, values } = insertSql(table, row);
      await tx.query(sql, values);
    };
    await insert("orders", derived.order);
    for (const row of derived.elements) await insert("elements", row);
    for (const row of derived.intervals) await insert("stationIntervals", row);
    for (const row of derived.steps) await insert("orderSteps", row);
    await insert("stationDayFacts", packingDay);
  });
});

afterAll(() => db.close());

describe("core migration", () => {
  const samples: Record<CoreTable, object> = {
    orders: derived.order,
    elements: derived.elements[0],
    stationIntervals: derived.intervals[0],
    orderSteps: derived.steps[0],
    stationDayFacts: packingDay,
  };

  it.each(Object.keys(samples) as CoreTable[])("the %s row type has exactly the table's columns", async (table) => {
    const [schema, name] = CORE_TABLES[table].split(".");
    const columns = await db.withService((tx) =>
      tx.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = $1 and table_name = $2",
        [schema, name]
      )
    );
    expect(Object.keys(samples[table]).map(toSnake).sort()).toEqual(columns.map((c) => c.column_name).sort());
  });

  it("stores the order as derived", async () => {
    const [row] = await db.withUser(testClaims("viewer"), (tx) =>
      tx.query<Record<string, unknown>>(
        `select order_no, customer, status, elements_expected, elements_packed, missing_scan_out_count,
                current_step, current_station_nos, missing_elements, forecast_basis,
                elapsed_seconds, lead_seconds, due_at, packed_at
           from core.orders where order_no = $1`,
        [58556]
      )
    );
    expect(row).toMatchObject({
      order_no: 58556,
      customer: "Hansen Byg",
      status: "in_progress",
      elements_expected: 3,
      elements_packed: 2,
      missing_scan_out_count: 1,
      current_step: "assembly",
      current_station_nos: [],
      missing_elements: [{ position: 5, subPosition: 1, expected: 3, seen: 3, packed: 2 }],
      forecast_basis: "document",
      elapsed_seconds: derived.order.elapsedSeconds,
      lead_seconds: null,
      packed_at: null,
    });
    expect(new Date(row.due_at as string).toISOString()).toBe(derived.order.dueAt);
  });

  it("the steps in the table add up to the order's elapsed time", async () => {
    const [row] = await db.withUser(testClaims("planner"), (tx) =>
      tx.query<{ steps: number; working: number; elapsed: number; elapsed_working: number; n: number }>(
        `select sum(s.duration_seconds)::int as steps, sum(s.duration_working_seconds)::int as working,
                max(o.elapsed_seconds) as elapsed, max(o.elapsed_working_seconds) as elapsed_working,
                (select count(*)::int from core.order_steps) as n
           from core.order_steps s join core.orders o using (order_no)
          where s.counts_in_lead`
      )
    );
    expect(row.n).toBe(7);
    expect(row.steps).toBe(row.elapsed);
    expect(row.working).toBe(row.elapsed_working);
  });

  it("stores elements, intervals and station day facts with arrays and jsonb intact", async () => {
    const result = await db.withUser(testClaims("ledelse"), async (tx) => ({
      elements: await tx.query<Record<string, unknown>>(
        "select barcode, station_path, element_type_id, width_mm, in_progress from core.elements order by barcode"
      ),
      intervals: await tx.query<Record<string, unknown>>(
        "select station_no, status, missing_reason, duration_seconds, local_day::text as local_day from core.station_intervals order by start_at"
      ),
      facts: await tx.query<Record<string, unknown>>(
        "select count_through, time_per_piece_seconds, gaps, by_element_type from core.station_day_facts where station_no = 7"
      ),
    }));
    expect(result.elements).toEqual([
      { barcode: "058556050101", station_path: [1, 7], element_type_id: "vindue_1_fag", width_mm: 1188, in_progress: false },
      { barcode: "058556050102", station_path: [2, 7], element_type_id: "vindue_1_fag", width_mm: 1188, in_progress: false },
      { barcode: "058556050103", station_path: [], element_type_id: "vindue_1_fag", width_mm: 1188, in_progress: false },
    ]);
    expect(result.intervals[0]).toEqual({ station_no: 1, status: "missing_out", missing_reason: "stale", duration_seconds: null, local_day: "2026-10-19" });
    expect(result.intervals).toHaveLength(5);
    expect(result.facts[0]).toMatchObject({ count_through: 2, time_per_piece_seconds: 600, gaps: packingDay.gaps, by_element_type: packingDay.byElementType });
    // The read-time status works straight off the stored row.
    const stored = result.facts[0] as unknown as StationDayFactsRow;
    expect(stationStatus({ ...packingDay, gaps: stored.gaps }, 600).status).toBe("stood_still");
  });

  it("every role reads, a user of another account reads nothing", async () => {
    for (const role of ["admin", "ledelse", "planner", "viewer"] as const) {
      const [{ n }] = await db.withUser(testClaims(role), (tx) => tx.query<{ n: number }>("select count(*)::int as n from core.orders"));
      expect(n).toBe(1);
    }
    const stranger = { ...testClaims("admin"), accountId: "00000000-0000-4000-8000-00000000ffff" };
    for (const table of [...Object.values(CORE_TABLES), "core.batches", "core.batch_elements", "core.machine_events"]) {
      const [{ n }] = await db.withUser(stranger, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`));
      expect(n).toBe(0);
    }
  });

  it("no user can write, not even an admin", async () => {
    const admin = testClaims("admin");
    await expect(db.withUser(admin, (tx) => tx.query("delete from core.orders"))).rejects.toThrow(/permission denied/i);
    await expect(db.withUser(admin, (tx) => tx.query("update core.station_intervals set station = 'x'"))).rejects.toThrow(/permission denied/i);
    await expect(
      db.withUser(admin, (tx) => tx.query("insert into core.machine_events (machine, event_type, event_at) values ('schirmer', 'start', now())"))
    ).rejects.toThrow(/permission denied/i);
  });

  it("every core table has row level security on and a select policy only", async () => {
    const tables = await db.withService((tx) =>
      tx.query<{ relname: string; relrowsecurity: boolean; policies: string[] }>(
        `select c.relname, c.relrowsecurity,
                array(select p.cmd::text from pg_policies p where p.schemaname = 'core' and p.tablename = c.relname) as policies
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'core' and c.relkind = 'r' order by 1`
      )
    );
    expect(tables.map((t) => t.relname)).toEqual([
      "batch_elements", "batches", "elements", "machine_events", "order_steps", "orders", "station_day_facts", "station_intervals",
    ]);
    for (const t of tables) {
      expect(t.relrowsecurity).toBe(true);
      expect(t.policies).toEqual(["SELECT"]);
    }
    const grants = await db.withService((tx) =>
      tx.query<{ grantee: string; privilege_type: string }>(
        "select distinct grantee, privilege_type from information_schema.role_table_grants where table_schema = 'core' and grantee in ('anon', 'authenticated')"
      )
    );
    expect(grants).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });

  it("deleting an order takes its elements, intervals and steps with it (the writer's replace)", async () => {
    await db.withService((tx) => tx.query("delete from core.orders where order_no = $1", [58556]));
    const [row] = await db.withService((tx) =>
      tx.query<{ e: number; i: number; s: number }>(
        `select (select count(*)::int from core.elements) as e,
                (select count(*)::int from core.station_intervals) as i,
                (select count(*)::int from core.order_steps) as s`
      )
    );
    expect(row).toEqual({ e: 0, i: 0, s: 0 });
  });
});
