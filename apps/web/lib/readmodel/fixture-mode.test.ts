// Fixture mode as the dev server runs it (VENTISOL_FIXTURES=1, no connection
// string): importing what the pages import registers the seeds, and the first
// query waits for them. Proves that core.orders holds the history there, with
// the sync seed of lib/sync and this module's seed side by side.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("fixture mode", () => {
  beforeAll(() => {
    vi.stubEnv("VENTISOL_FIXTURES", "1");
    vi.stubEnv("NODE_ENV", "development");
    for (const key of ["DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL"]) vi.stubEnv(key, "");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("fills core.* before the first query is answered", async () => {
    const started = performance.now();
    // What a page pulls in: the sync status (registers the sync seed) and the fixtures (registers this one).
    await import("@/lib/sync/status");
    await import("@/lib/fixtures");
    const { withService } = await import("@/lib/db");
    const rows = await withService((db) =>
      db.query<Record<string, number | string>>(
        `select (select count(*) from raw.scans) as scans,
                (select count(*) from raw.order_documents where device = 'FIXTURES') as documents,
                (select count(*) from core.orders) as orders,
                (select count(*) from core.orders where status = 'in_progress') as in_progress,
                (select count(*) from core.orders where customer is not null) as with_customer,
                (select count(distinct order_no) from raw.scans) as raw_orders,
                (select count(distinct local_day) from core.station_day_facts) as days,
                (select count(*) from config.stations) as stations,
                (select count(*) from config.normal_times) as normal_times,
                (select string_agg(name, ',' order by name) from app.sync_state) as states`
      )
    );
    const c = rows[0];
    console.info(`fixture mode, first query after ${Math.round(performance.now() - started)} ms:`, JSON.stringify(c));
    expect(Number(c.scans)).toBeGreaterThan(25_000);
    expect(Number(c.orders)).toBeGreaterThan(300);
    expect(Number(c.orders)).toBe(Number(c.raw_orders));
    expect(Number(c.with_customer)).toBeGreaterThan(300);
    expect(Number(c.days)).toBeGreaterThanOrEqual(60);
    expect(Number(c.stations)).toBe(7);
    expect(Number(c.normal_times)).toBeGreaterThan(20);
    expect(String(c.states)).toContain("readmodel_rebuild");
  }, 600_000);
});
