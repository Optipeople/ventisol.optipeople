// Orchestration, the status file for pages, and the cron routes. The routes
// are tested here because vitest only collects lib/**/*.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import type { ServiceAccess } from "./opticloud-service";

const applyScanChanges = vi.fn(async () => ({ orders: 1, stationDays: 1 }));
const applyDocumentChanges = vi.fn(async () => ({ orders: 1, stationDays: 0 }));
const rebuildAll = vi.fn(async (now: number) => {
  void now;
  return { orders: 7, stationDays: 9 };
});
vi.mock("@/lib/readmodel", () => ({
  applyScanChanges: () => applyScanChanges(),
  applyDocumentChanges: () => applyDocumentChanges(),
  rebuildAll: (now: number) => rebuildAll(now),
  continueRebuild: async () => ({ orders: 0, stationDays: 0, complete: true }),
}));

// The run functions ask for the OptiCloud themselves: hand them the fake.
let access: ServiceAccess;
vi.mock("./opticloud-service", async (original) => ({
  ...(await original<typeof import("./opticloud-service")>()),
  getOptiCloud: async () => access,
}));

import { GET as reconcileRoute } from "@/app/api/cron/reconcile/route";
import { GET as syncRoute } from "@/app/api/cron/sync/route";
import { refuseUnlessCron } from "./cron-auth";
import { requestSync, resetRequestSync, runRebuild, runReconcile, runSync } from "./run";
import {
  acquireLease,
  appendPending,
  getPrivate,
  JOBS,
  PRIVATE,
  readPending,
  readState,
  type JobName,
} from "./state";
import { getSyncStatus, requestRebuildAsAdmin, requestSyncAsAdmin } from "./status";
import { FakeOptiCloud, HOUR, NOW, scanRows } from "./test-fakes";

let db: TestDb;
let cloud: FakeOptiCloud;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  resetRequestSync();
  applyScanChanges.mockClear();
  applyDocumentChanges.mockClear();
  rebuildAll.mockClear();
  cloud = new FakeOptiCloud();
  cloud.hasDocumentTable = false;
  cloud.scans = scanRows(12, NOW - HOUR);
  access = cloud.access;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

const scanCount = () =>
  db.withService(async (q) => Number((await q.query("select count(*) as n from raw.scans"))[0].n));
const job = (name: JobName) => db.withService((q) => readState(q, name));
const auditRows = () => db.withService((q) => q.query("select action, role, subject from app.audit_log"));

describe("runSync", () => {
  it("syncs the scans, then the documents, and files the run", async () => {
    const result = await runSync({ now: NOW });
    expect(result).toMatchObject({
      status: "done",
      scans: { status: "ok", inserted: 12 },
      documents: { status: "no_table" },
    });
    expect(await scanCount()).toBe(12);
    const row = await job(JOBS.sync);
    expect(row?.lastRunAt?.getTime()).toBe(NOW);
    expect(row?.lastSuccessAt?.getTime()).toBe(NOW);
    expect(row?.detail).toMatchObject({ status: "ok", what: "sync" });
    // The lease is given back.
    expect(await db.withService((q) => getPrivate(q, PRIVATE.lease))).toBeNull();
  });

  it("lets only one of two overlapping runs through", async () => {
    let open!: () => void;
    cloud.gate = new Promise<void>((resolve) => (open = resolve));
    const first = runSync({ now: NOW });
    // Give the first run time to take the lease and reach the gate.
    await vi.waitFor(async () => expect(await db.withService((q) => getPrivate(q, PRIVATE.lease))).not.toBeNull());

    const second = await runSync({ now: NOW + 1000 });
    expect(second).toEqual({ status: "busy" });

    open();
    cloud.gate = null;
    expect((await first).status).toBe("done");
    expect(await scanCount()).toBe(12);
    expect(applyScanChanges).toHaveBeenCalledTimes(1);

    // And the next one runs again.
    expect((await runSync({ now: NOW + 2000 })).status).toBe("done");
  });

  it("starts two runs at the same instant as one", async () => {
    const results = await Promise.all([runSync({ now: NOW }), runSync({ now: NOW })]);
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "done"]);
    expect(await scanCount()).toBe(12);
  });

  it("takes over the lease of a run that died once it has expired", async () => {
    await db.withService((q) => acquireLease(q, "dead-run", NOW, 60_000, "sync"));
    expect(await runSync({ now: NOW + 30_000 })).toEqual({ status: "busy" });
    expect((await runSync({ now: NOW + 61_000 })).status).toBe("done");
  });

  it("starts nothing when the last run began less than minIntervalMs ago", async () => {
    await runSync({ now: NOW });
    cloud.pageCalls = [];
    expect(await runSync({ now: NOW + 5000, minIntervalMs: 20_000 })).toEqual({ status: "recent" });
    expect(cloud.pageCalls).toEqual([]);
    expect((await runSync({ now: NOW + 21_000, minIntervalMs: 20_000 })).status).toBe("done");
  });

  it("returns cleanly when the service account is not configured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    access = { status: "not_configured", missing: ["OPTICLOUD_SERVICE_USER", "OPTICLOUD_SERVICE_PASSWORD"] };
    const result = await runSync({ now: NOW });
    expect(result).toMatchObject({
      status: "done",
      scans: { status: "not_configured" },
      documents: { status: "not_configured" },
    });
    expect((await job(JOBS.scans))?.detail).toMatchObject({ status: "not_configured", configured: false });
    expect((await job(JOBS.documents))?.detail).toMatchObject({ status: "not_configured", configured: false });
    expect(error).not.toHaveBeenCalled();
  });

  it("continues an unfinished reconcile pass with the time left", async () => {
    cloud.scans = scanRows(30, NOW - HOUR);
    const { runScanReconcile } = await import("./reconcile");
    await runScanReconcile({ now: NOW, access, full: true, maxPages: 2 });
    expect((await job(JOBS.reconcile))?.detail.cursor).not.toBeNull();

    const result = await runSync({ now: NOW + 60_000 });
    expect(result).toMatchObject({ status: "done", reconcile: { finished: true } });
    expect((await job(JOBS.reconcile))?.detail.cursor).toBeNull();
    expect(await scanCount()).toBe(30);
  });
});

describe("runReconcile and runRebuild", () => {
  it("runs the reconcile under the same lease", async () => {
    await db.withService((q) => acquireLease(q, "other", NOW, 60_000, "sync"));
    expect(await runReconcile({ now: NOW + 1000 })).toEqual({ status: "busy" });
    const result = await runReconcile({ now: NOW + 120_000, days: 10 });
    expect(result).toMatchObject({ status: "done", scans: { mode: "window", finished: true, inserted: 12 } });
  });

  it("rebuilds through rebuildAll and drops what was queued for the writer", async () => {
    await db.withService((q) => appendPending(q, PRIVATE.pendingOrders, [58556]));
    const result = await runRebuild({ now: NOW });
    expect(result).toMatchObject({ status: "done", applied: { orders: 7, stationDays: 9 }, chunkedFiles: 0 });
    expect(rebuildAll).toHaveBeenCalledWith(NOW);
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingOrders))).toEqual([]);
    expect((await job(JOBS.rebuild))?.detail).toMatchObject({ status: "ok" });
  });

  it("reports a failed rebuild and keeps the queue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db.withService((q) => appendPending(q, PRIVATE.pendingOrders, [58556]));
    rebuildAll.mockRejectedValueOnce(new Error("no core tables"));
    const result = await runRebuild({ now: NOW });
    expect(result).toEqual({ status: "error", error: "no core tables" });
    expect((await job(JOBS.rebuild))?.lastError).toBe("no core tables");
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingOrders))).toEqual([58556]);
    expect(await db.withService((q) => getPrivate(q, PRIVATE.lease))).toBeNull();
  });
});

describe("requestSync", () => {
  it("starts one run and then nothing for the next 20 seconds", async () => {
    const first = await requestSync({ now: NOW, waitMs: 5000 });
    expect(first).toMatchObject({ started: true, finished: true, result: { status: "done" } });
    cloud.pageCalls = [];
    expect(await requestSync({ now: NOW + 1000 })).toEqual({ started: false });
    expect(await requestSync({ now: NOW + 19_000 })).toEqual({ started: false });
    expect(cloud.pageCalls).toEqual([]);
    expect((await requestSync({ now: NOW + 21_000, waitMs: 5000 })).started).toBe(true);
  });

  it("honours a run started on another instance", async () => {
    await runSync({ now: NOW });
    cloud.pageCalls = [];
    // This instance has no memory of it, the database has.
    expect(await requestSync({ now: NOW + 5000, waitMs: 5000 })).toEqual({ started: false });
    expect(cloud.pageCalls).toEqual([]);
  });

  it("does not keep the caller waiting for a slow run", async () => {
    let open!: () => void;
    cloud.gate = new Promise<void>((resolve) => (open = resolve));
    const started = Date.now();
    const result = await requestSync({ now: NOW, waitMs: 50 });
    expect(result).toEqual({ started: true, finished: false });
    expect(Date.now() - started).toBeLessThan(2000);
    // While it runs, a second request starts nothing.
    expect(await requestSync({ now: NOW + 60_000, waitMs: 50 })).toEqual({ started: false });
    open();
    cloud.gate = null;
    await vi.waitFor(async () => expect(await scanCount()).toBe(12), { timeout: 5000 });
    await vi.waitFor(async () => expect(await db.withService((q) => getPrivate(q, PRIVATE.lease))).toBeNull());
  });
});

describe("getSyncStatus", () => {
  beforeEach(async () => {
    vi.stubEnv("VENTISOL_FIXTURES", "");
    vi.stubEnv("OPTICLOUD_SERVICE_USER", "sync@ventisol.dk");
    vi.stubEnv("OPTICLOUD_SERVICE_PASSWORD", "");
    vi.stubEnv("VENTISOL_ACCOUNT_ID", "acc");
    await runSync({ now: NOW });
  });

  it("gives an admin one typed row per job", async () => {
    const status = await getSyncStatus(testClaims("admin"), NOW + 90_000);
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["OPTICLOUD_SERVICE_PASSWORD"]);
    const scans = status.jobs.find((j) => j.name === "scans");
    expect(scans).toMatchObject({
      status: "ok",
      configured: true,
      lagSeconds: 90,
      error: null,
      rowsTotal: 12,
      watermark: new Date(NOW - HOUR).toISOString(),
      passRunning: false,
      unordered: false,
      retryAt: null,
    });
    expect(scans?.lastSuccessAt?.getTime()).toBe(NOW);
    expect(scans?.totals).toMatchObject({ inserted: 12, pagesRead: 3 });
    expect(status.jobs.map((j) => j.name)).toEqual(expect.arrayContaining(["sync", "scans", "documents"]));
  });

  it("passes on only the named fields, never the raw detail", async () => {
    const status = await getSyncStatus(testClaims("admin"), NOW);
    const keys = new Set(status.jobs.flatMap((j) => Object.keys(j)));
    expect([...keys].sort()).toEqual(
      [
        "configured",
        "error",
        "lagSeconds",
        "lastRunAt",
        "lastSuccessAt",
        "name",
        "passRunning",
        "retryAt",
        "rowsTotal",
        "status",
        "totals",
        "unordered",
        "watermark",
      ].sort()
    );
  });

  it("gives everyone else no rows", async () => {
    for (const role of ["ledelse", "planner", "viewer"] as const) {
      expect((await getSyncStatus(testClaims(role), NOW)).jobs).toEqual([]);
    }
  });
});

describe("the admin actions", () => {
  it("refuses anyone but an admin, starts nothing and logs nothing", async () => {
    for (const role of ["ledelse", "planner", "viewer"] as const) {
      expect(await requestSyncAsAdmin(testClaims(role), { now: NOW })).toEqual({ ok: false, reason: "forbidden" });
      expect(await requestRebuildAsAdmin(testClaims(role), { now: NOW })).toEqual({
        ok: false,
        reason: "forbidden",
      });
    }
    expect(cloud.pageCalls).toEqual([]);
    expect(rebuildAll).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
  });

  it("goes by the role in the database, not by a role the caller claims without the account", async () => {
    const forged = { ...testClaims("admin"), accountId: "00000000-0000-4000-8000-00000000dead" };
    expect(await requestSyncAsAdmin(forged, { now: NOW })).toEqual({ ok: false, reason: "forbidden" });
    expect(cloud.pageCalls).toEqual([]);
  });

  it("audits and runs a sync for an admin", async () => {
    const result = await requestSyncAsAdmin(testClaims("admin"), { now: NOW });
    expect(result).toMatchObject({ ok: true, finished: true, result: { status: "done" } });
    expect(await scanCount()).toBe(12);
    expect(await auditRows()).toEqual([{ action: "sync.requested", role: "admin", subject: "sync" }]);
  });

  it("audits and runs a rebuild for an admin", async () => {
    const result = await requestRebuildAsAdmin(testClaims("admin"), { now: NOW });
    expect(result).toMatchObject({ ok: true, finished: true, result: { status: "done" } });
    expect(rebuildAll).toHaveBeenCalledWith(NOW);
    expect(await auditRows()).toEqual([{ action: "sync.rebuild_requested", role: "admin", subject: "rebuild" }]);
  });
});

describe("the cron routes", () => {
  const SECRET = "s3cret-for-the-test";
  const request = (path: string, authorization?: string) =>
    new Request(`https://ventisol.optipeople.dk${path}`, {
      headers: authorization === undefined ? {} : { authorization },
    });

  it("refuse every request while CRON_SECRET is not set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const auth of [undefined, "Bearer ", "Bearer undefined", `Bearer ${SECRET}`]) {
      const res = await syncRoute(request("/api/cron/sync", auth));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "cron_not_configured" });
    }
    expect((await reconcileRoute(request("/api/cron/reconcile", "Bearer "))).status).toBe(503);
    expect(cloud.pageCalls).toEqual([]);
  });

  it("refuse a missing or wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const auth of [undefined, "", SECRET, "Bearer wrong", `Bearer ${SECRET}x`, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      for (const [route, path] of [
        [syncRoute, "/api/cron/sync"],
        [reconcileRoute, "/api/cron/reconcile"],
      ] as const) {
        const res = await route(request(path, auth));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
    expect(cloud.pageCalls).toEqual([]);
    expect(await scanCount()).toBe(0);
    expect(refuseUnlessCron(request("/x", `Bearer ${SECRET}`))).toBeNull();
  });

  it("run the sync with the right secret and answer with a small summary", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await syncRoute(request("/api/cron/sync", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", scans: { status: "ok", inserted: 12 } });
    expect(await scanCount()).toBe(12);
  });

  it("run the reconcile with the right secret and its query", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await reconcileRoute(request("/api/cron/reconcile?full=1", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", scans: { mode: "full", finished: true } });
  });
});
