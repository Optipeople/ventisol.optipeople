// The monthly snapshot cron route (app/api/cron/snapshot/route.ts). It lives
// here because vitest only collects lib/**/*.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as snapshotRoute } from "@/app/api/cron/snapshot/route";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { listSnapshots } from "@/lib/reports";
import { seedConfig, seedOctober } from "@/lib/reports/test-support";

const SECRET = "s3cret-for-the-test";
const request = (authorization?: string) =>
  new Request("https://ventisol.optipeople.dk/api/cron/snapshot", {
    headers: authorization === undefined ? {} : { authorization },
  });

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedOctober(db);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => db.close());

describe("the snapshot cron route", () => {
  it("refuses without CRON_SECRET and with a wrong secret, and freezes nothing", async () => {
    vi.setSystemTime(new Date("2026-11-01T02:15:00Z"));
    vi.stubEnv("CRON_SECRET", "");
    expect((await snapshotRoute(request(`Bearer ${SECRET}`))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const auth of [undefined, "", "Bearer wrong", SECRET]) {
      expect((await snapshotRoute(request(auth))).status).toBe(401);
    }
    expect(await listSnapshots(testClaims("admin"))).toEqual([]);
  });

  it("freezes the month that just ended, once", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.setSystemTime(new Date("2026-11-01T02:15:00Z"));
    const first = await snapshotRoute(request(`Bearer ${SECRET}`));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ month: "2026-10-01", written: true, frozenAt: "2026-11-01T02:15:00.000Z" });

    // A retry later the same day leaves the snapshot alone.
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const again = await snapshotRoute(request(`Bearer ${SECRET}`));
    expect(await again.json()).toEqual({ month: "2026-10-01", written: false, frozenAt: "2026-11-01T02:15:00.000Z" });

    const snapshots = await listSnapshots(testClaims("ledelse"));
    expect(snapshots.map((s) => s.month)).toEqual(["2026-10-01"]);
  });

  it("takes the month in Copenhagen time", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    // 23:30 UTC on 31 October is already 1 November in Copenhagen.
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    const res = await snapshotRoute(request(`Bearer ${SECRET}`));
    expect(await res.json()).toMatchObject({ month: "2026-10-01", written: true });
  });
});
