// The fixture seed: 13 weeks of synthetic production through the real writer.
// One seed for the whole file (it is the slow part), read by every test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { dayKey } from "@/lib/time";
import { loadFixtureHistory } from "./fixture-history";
import { seedFixtureReadModel, type FixtureSeedResult } from "./fixture-seed";
import { applyScanChanges, rebuildAll } from "./index";

// A Friday, 13:30 in Copenhagen: the day shift is running.
const NOW = Date.UTC(2026, 10, 13, 12, 30);

let db: TestDb;
let seeded: FixtureSeedResult;

beforeAll(async () => {
  db = await createTestDb();
  await db.reset();
  seeded = await seedFixtureReadModel(db, NOW);
}, 300_000);

afterAll(() => db.close());

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.withService((q) => q.query<T>(sql, params)))[0];

describe("seedFixtureReadModel", () => {
  it("writes the history to raw.* and builds core.* from it", async () => {
    const history = await loadFixtureHistory(NOW);
    const counts = await one<{ scans: number; documents: number; orders: number; raw_orders: number }>(
      `select (select count(*) from raw.scans) as scans,
              (select count(*) from raw.order_documents) as documents,
              (select count(*) from core.orders) as orders,
              (select count(distinct order_no) from raw.scans) as raw_orders`
    );
    expect(Number(counts.scans)).toBe(history.rows.length);
    expect(Number(counts.documents)).toBe(history.documents.length);
    expect(Number(counts.orders)).toBe(Number(counts.raw_orders));
    expect(seeded.complete).toBe(true);
    expect(seeded.orders).toBe(Number(counts.orders));
    console.info(
      `fixture seed: ${seeded.scans} scans, ${seeded.documents} documents, ${seeded.orders} orders, ` +
        `${seeded.stationDays} station days, raw ${seeded.rawMs} ms, rebuild ${seeded.rebuildMs} ms`
    );
  });

  it("covers about 13 weeks, ending today", async () => {
    const span = await one<{ first_day: string; last_day: string; days: number }>(
      `select min(start_local_day)::text as first_day,
              (select max(local_day)::text from core.station_day_facts) as last_day,
              (select count(distinct local_day) from core.station_day_facts where count_through > 0) as days
         from core.orders`
    );
    expect(span.last_day).toBe(dayKey(NOW));
    expect(Number(span.days)).toBeGreaterThanOrEqual(60);
    const weeks = (Date.parse(span.last_day) - Date.parse(span.first_day)) / (7 * 86_400_000);
    expect(weeks).toBeGreaterThan(12);
    expect(weeks).toBeLessThan(14);
  });

  it("holds every state the reports show", async () => {
    const s = await one<Record<string, number>>(
      `select count(*) filter (where status = 'packed') as packed,
              count(*) filter (where status = 'in_progress') as in_progress,
              count(*) filter (where on_time is false) as late,
              count(*) filter (where on_time is true) as on_time,
              count(*) filter (where customer is null) as no_document,
              count(*) filter (where packed_source = 'document') as packed_by_document,
              count(*) filter (where packed_source = 'scans') as packed_by_scans,
              count(*) filter (where status = 'in_progress' and jsonb_array_length(coalesce(missing_elements, '[]'::jsonb)) > 0
                                 and last_scan_at < $1::timestamptz) as forgotten,
              count(*) filter (where rework_count > 0) as rework,
              count(*) filter (where missing_scan_out_count > 0) as missing_out,
              count(*) filter (where forecast_ready_at is not null) as forecast,
              count(*) filter (where at_risk) as at_risk
         from core.orders`,
      [new Date(NOW - 7 * 86_400_000).toISOString()]
    );
    const n = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]));
    console.info("fixture seed, orders by state:", JSON.stringify(n));
    expect(n.packed).toBeGreaterThan(300);
    expect(n.in_progress).toBeGreaterThanOrEqual(5);
    expect(n.late).toBeGreaterThan(0);
    expect(n.on_time).toBeGreaterThan(n.late);
    expect(n.no_document).toBeGreaterThan(0);
    expect(n.packed_by_document).toBeGreaterThan(0);
    expect(n.packed_by_scans).toBeGreaterThan(0);
    expect(n.forgotten).toBeGreaterThan(0);
    expect(n.rework).toBeGreaterThan(0);
    expect(n.missing_out).toBeGreaterThan(0);
    expect(n.forecast).toBeGreaterThan(0);

    const i = await one<Record<string, number>>(
      `select count(*) filter (where status = 'open') as open,
              count(*) filter (where status = 'missing_out') as missing_out,
              count(*) filter (where status = 'missing_out' and local_day = $1::date) as missing_out_today,
              count(*) filter (where is_rework) as rework,
              count(distinct element_type_id) as types
         from core.station_intervals`,
      [dayKey(NOW)]
    );
    console.info("fixture seed, passes by state:", JSON.stringify(i));
    expect(Number(i.open)).toBeGreaterThan(0);
    expect(Number(i.missing_out)).toBeGreaterThan(0);
    expect(Number(i.missing_out_today)).toBeGreaterThan(0);
    expect(Number(i.rework)).toBeGreaterThan(0);
    expect(Number(i.types)).toBeGreaterThanOrEqual(5);

    // A standstill: a gap of an hour or more inside the shift, one of them today.
    const g = await one<{ long_gaps: number; today: number }>(
      `select count(*) filter (where longest_gap_seconds >= 3600) as long_gaps,
              count(*) filter (where longest_gap_seconds >= 3600 and local_day = $1::date) as today
         from core.station_day_facts`,
      [dayKey(NOW)]
    );
    expect(Number(g.long_gaps)).toBeGreaterThan(0);
    expect(Number(g.today)).toBeGreaterThan(0);
  });

  it("fills the order facts from the synthetic documents", async () => {
    const o = await one<{ customer: string; delivery_address: string; delivery_week: number; due_at: Date; elements_expected: number }>(
      `select customer, delivery_address, delivery_week, due_at, elements_expected
         from core.orders where customer is not null and status = 'packed' order by order_no limit 1`
    );
    expect(o.customer.length).toBeGreaterThan(2);
    expect(o.delivery_address).toContain(",");
    expect(o.delivery_week).toBeGreaterThanOrEqual(1);
    expect(o.due_at).toBeInstanceOf(Date);
    expect(o.elements_expected).toBeGreaterThan(0);
  });

  it("seeds the master data and leaves an edited station alone", async () => {
    const c = await one<Record<string, number>>(
      `select (select count(*) from config.stations) as stations,
              (select count(*) from config.element_types where recognition is not null) as types,
              (select count(*) from config.normal_times) as normal,
              (select count(*) from config.calculated_times) as calculated`
    );
    expect(Number(c.stations)).toBe(7);
    expect(Number(c.types)).toBeGreaterThanOrEqual(5);
    expect(Number(c.normal)).toBeGreaterThan(20);
    expect(Number(c.calculated)).toBeGreaterThan(20);
  });

  it("is idempotent, and an incremental run on top changes nothing", async () => {
    await db.withService((q) => q.query("update config.stations set name = 'Omdøbt' where station_no = 3"));
    const before = await snapshot();
    const again = await seedFixtureReadModel(db, NOW);
    expect(again.complete).toBe(true);
    expect(await snapshot()).toEqual(before);

    const started = performance.now();
    const applied = await applyScanChanges([], NOW);
    console.info(
      `empty incremental apply on the full history: ${Math.round(performance.now() - started)} ms, ` +
        `${applied.orders} orders, ${applied.stationDays} station days`
    );
    expect(await snapshot()).toEqual(before);
    const name = await one<{ name: string }>("select name from config.stations where station_no = 3");
    expect(name.name).toBe("Omdøbt");
  }, 300_000);

  it("stays full while it is rebuilt", async () => {
    const total = Number((await one<{ n: number }>("select count(*) as n from core.orders")).n);
    const seen: number[] = [];
    const started = performance.now();
    const marks: number[] = [];
    await rebuildAll(NOW, {
      restart: true,
      chunkSize: 60,
      onChunk: async () => {
        marks.push(Math.round(performance.now() - started));
        seen.push(Number((await one<{ n: number }>("select count(*) as n from core.orders")).n));
      },
    });
    console.info(`rebuildAll in chunks of 60: marks at ${marks.join(", ")} ms`);
    expect(seen.length).toBeGreaterThan(5);
    expect(Math.min(...seen)).toBe(total);
  }, 300_000);
});

async function snapshot(): Promise<string[]> {
  const tables: [string, string][] = [
    ["core.orders", "order_no"],
    ["core.elements", "barcode"],
    ["core.station_intervals", "interval_id"],
    ["core.order_steps", "order_no, step"],
    ["core.station_day_facts", "station_no, local_day"],
  ];
  const out: string[] = [];
  for (const [table, key] of tables) {
    const rows = await db.withService((q) =>
      q.query<{ row: string }>(`select (to_jsonb(t) - 'computed_at')::text as row from ${table} t order by ${key}`)
    );
    out.push(`${table}: ${rows.length}`, ...rows.map((r) => r.row));
  }
  return out;
}
