import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import type { ChangedScan } from "@/lib/readmodel";

const applyScanChanges = vi.fn(async (changed: ChangedScan[], now: number) => {
  void changed;
  void now;
  return { orders: 1, stationDays: 1 };
});
vi.mock("@/lib/readmodel", () => ({
  applyScanChanges: (changed: ChangedScan[], now: number) => applyScanChanges(changed, now),
  applyDocumentChanges: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
  rebuildAll: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
}));

import { resetServiceMemory } from "./opticloud-service";
import { runScanSync } from "./scans";
import { JOBS, PRIVATE, readPending, readState } from "./state";
import { FakeOptiCloud, HOUR, NOW, scanRow, scanRows } from "./test-fakes";

let db: TestDb;
let cloud: FakeOptiCloud;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  resetServiceMemory();
  applyScanChanges.mockClear();
  cloud = new FakeOptiCloud();
});
afterAll(() => db.close());

const storedIds = () =>
  db.withService(async (q) =>
    (await q.query<{ scan_id: string }>("select scan_id from raw.scans order by scan_id")).map((r) => r.scan_id)
  );
const state = () => db.withService((q) => readState(q, JOBS.scans));
const appliedIds = (call = 0) => applyScanChanges.mock.calls[call][0].map((c) => c.scanId).sort();

describe("runScanSync", () => {
  it("copies every row on the first sync and hands them all to the read model writer", async () => {
    cloud.scans = scanRows(12, NOW - HOUR);
    const result = await runScanSync({ now: NOW, access: cloud.access });

    expect(result).toMatchObject({ status: "ok", inserted: 12, changed: 0, pagesRead: 3, truncated: false });
    expect(await storedIds()).toHaveLength(12);
    expect(applyScanChanges).toHaveBeenCalledTimes(1);
    expect(applyScanChanges.mock.calls[0][0]).toHaveLength(12);
    expect(applyScanChanges.mock.calls[0][1]).toBe(NOW);

    const row = await state();
    expect(row?.rowsTotal).toBe(12);
    expect(row?.watermark).toBe(new Date(NOW - HOUR).toISOString());
    expect(row?.lastSuccessAt?.getTime()).toBe(NOW);
    expect(row?.lastError).toBeNull();
    expect(row?.detail).toMatchObject({ status: "ok", configured: true, inserted: 12, pagesRead: 3 });
    // Handed over, so nothing is left queued.
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingScans))).toEqual([]);
  });

  it("stores the row as OptiCloud holds it, with the direction normalised", async () => {
    cloud.scans = [scanRow(NOW - HOUR, { Direction: "out", DurationSec: 75, MachineId: "" }, "s-1")];
    await runScanSync({ now: NOW, access: cloud.access });
    const rows = await db.withService((q) => q.query("select * from raw.scans"));
    expect(rows[0]).toMatchObject({
      scan_id: "s-1",
      order_no: 58556,
      position: 5,
      direction: "Out",
      duration_sec: 75,
      machine_id: null,
      row_id: "row-s-1",
      station_no: 1,
    });
    expect((rows[0].scan_time as Date).getTime()).toBe(NOW - HOUR);
    expect(applyScanChanges.mock.calls[0][0][0]).toMatchObject({
      scanId: "s-1",
      orderNo: 58556,
      stationNo: 1,
      scanTime: NOW - HOUR,
    });
  });

  it("stops early on an incremental sync: the first settled page below the floor ends it", async () => {
    cloud.scans = scanRows(20, NOW - HOUR);
    await runScanSync({ now: NOW, access: cloud.access });
    cloud.pageCalls = [];
    applyScanChanges.mockClear();

    const fresh = scanRow(NOW + 5 * 60_000, {}, "fresh");
    cloud.scans.push(fresh);
    const result = await runScanSync({ now: NOW + 6 * 60_000, access: cloud.access, deep: false });

    // Page 1 holds the new row, page 2 is known and hours below the floor.
    expect(cloud.scanPagesRead()).toEqual([1, 2]);
    expect(result).toMatchObject({ inserted: 1, changed: 0, pagesRead: 2 });
    expect(appliedIds()).toEqual(["fresh"]);
  });

  it("finds a late scan with an old scan time on a deep run, which an ordinary run walks past", async () => {
    cloud.scans = scanRows(20, NOW - HOUR);
    await runScanSync({ now: NOW, access: cloud.access });
    applyScanChanges.mockClear();

    // Scanned 15 hours ago by a station that was offline until now.
    cloud.scans.push(scanRow(NOW - 15 * HOUR - 60_000, {}, "late"));

    const ordinary = await runScanSync({ now: NOW + 60_000, access: cloud.access, deep: false });
    expect(ordinary.inserted).toBe(0);
    expect(applyScanChanges).not.toHaveBeenCalled();

    const deep = await runScanSync({ now: NOW + 120_000, access: cloud.access, deep: true });
    expect(deep).toMatchObject({ inserted: 1, deep: true });
    expect(appliedIds()).toEqual(["late"]);
  });

  it("runs deep by itself when the last deep run is five minutes old", async () => {
    cloud.scans = scanRows(20, NOW - HOUR);
    expect((await runScanSync({ now: NOW, access: cloud.access })).deep).toBe(true);
    expect((await runScanSync({ now: NOW + 60_000, access: cloud.access })).deep).toBe(false);
    expect((await runScanSync({ now: NOW + 5 * 60_000, access: cloud.access })).deep).toBe(true);
  });

  it("keeps reading past the floor while pages still bring new rows", async () => {
    cloud.scans = scanRows(5, NOW - HOUR, 60_000);
    await runScanSync({ now: NOW, access: cloud.access });
    // A station sends two days of old scans at once: every page holds some.
    for (let i = 0; i < 30; i++) cloud.scans.push(scanRow(NOW - 2 * HOUR - i * HOUR));
    const result = await runScanSync({ now: NOW + 60_000, access: cloud.access, deep: false });
    expect(result.inserted).toBe(30);
  });

  it("changes nothing and does not call the writer when run again", async () => {
    cloud.scans = scanRows(12, NOW - HOUR);
    await runScanSync({ now: NOW, access: cloud.access });
    applyScanChanges.mockClear();
    const synced = await db.withService((q) => q.query("select scan_id, synced_at from raw.scans order by scan_id"));

    const again = await runScanSync({ now: NOW + 60_000, access: cloud.access, deep: true });
    expect(again).toMatchObject({ status: "ok", inserted: 0, changed: 0 });
    expect(applyScanChanges).not.toHaveBeenCalled();
    // Not even rewritten.
    expect(
      await db.withService((q) => q.query("select scan_id, synced_at from raw.scans order by scan_id"))
    ).toEqual(synced);
  });

  it("updates a stored row whose values differ and reports exactly that row", async () => {
    cloud.scans = scanRows(8, NOW - HOUR);
    await runScanSync({ now: NOW, access: cloud.access });
    applyScanChanges.mockClear();

    const edited = cloud.scans[6];
    edited.values = { ...edited.values, Station: "Station 12", StationNo: 3 };
    const result = await runScanSync({ now: NOW + 60_000, access: cloud.access, deep: true });

    expect(result).toMatchObject({ inserted: 0, changed: 1 });
    expect(applyScanChanges).toHaveBeenCalledTimes(1);
    expect(applyScanChanges.mock.calls[0][0]).toEqual([
      expect.objectContaining({ scanId: edited.values.ScanId, stationNo: 3 }),
    ]);
    const rows = await db.withService((q) =>
      q.query("select station, station_no from raw.scans where scan_id = $1", [edited.values.ScanId])
    );
    expect(rows[0]).toEqual({ station: "Station 12", station_no: 3 });
  });

  it("reads from the last page backwards when the API ignores the ordering", async () => {
    cloud.honoursOrder = false;
    cloud.scans = scanRows(30, NOW - HOUR, 60_000);
    const first = await runScanSync({ now: NOW, access: cloud.access });
    expect(first).toMatchObject({ unordered: true, inserted: 30, pagesRead: 6 });

    cloud.pageCalls = [];
    applyScanChanges.mockClear();
    // New rows are stored last, a late one among them.
    cloud.scans.push(scanRow(NOW, {}, "new-1"), scanRow(NOW - 20 * HOUR, {}, "late-1"));
    const next = await runScanSync({ now: NOW + 60_000, access: cloud.access });

    expect(next).toMatchObject({ unordered: true, inserted: 2 });
    // Page 1, then the tail: 7 (the new rows), 6 (nothing new: stop).
    expect(cloud.scanPagesRead()).toEqual([1, 7, 6]);
    expect(appliedIds()).toEqual(["late-1", "new-1"]);
    expect((await state())?.detail.unordered).toBe(true);
  });

  it("reads every page when the API gives neither an order nor a page count", async () => {
    cloud.honoursOrder = false;
    cloud.reportsTotal = false;
    cloud.scans = scanRows(23, NOW - HOUR, 60_000);
    const result = await runScanSync({ now: NOW, access: cloud.access });
    expect(result).toMatchObject({ unordered: true, inserted: 23, pagesRead: 5 });
  });

  it("hands what it could not read within its limits to the reconcile cursor", async () => {
    cloud.scans = scanRows(20, NOW - HOUR);
    const result = await runScanSync({ now: NOW, access: cloud.access, maxPages: 2 });
    expect(result).toMatchObject({ truncated: true, inserted: 10, pagesRead: 2 });
    const reconcile = await db.withService((q) => readState(q, JOBS.reconcile));
    expect(reconcile?.detail.cursor).toMatchObject({ mode: "full", nextPage: 3 });
  });

  it("files a missing list without an error", async () => {
    cloud.hasScanTable = false;
    const result = await runScanSync({ now: NOW, access: cloud.access });
    expect(result.status).toBe("no_table");
    expect((await state())?.detail.status).toBe("no_table");
    expect((await state())?.lastError).toBeNull();
  });

  it("keeps the stored rows and the queue when a page fails, and says so", async () => {
    cloud.scans = scanRows(12, NOW - HOUR);
    const load = cloud.loadRowsPage.bind(cloud);
    cloud.loadRowsPage = async (tableId, page, query) => {
      if (page === 2) throw new Error("boom");
      return load(tableId, page, query);
    };
    const result = await runScanSync({ now: NOW, access: cloud.access });
    expect(result).toMatchObject({ status: "error", inserted: 5, error: "boom" });
    // Exactly the five rows that were committed were handed over.
    expect(applyScanChanges.mock.calls[0][0]).toHaveLength(5);
    const row = await state();
    expect(row?.lastError).toBe("boom");
    expect(row?.lastSuccessAt).toBeNull();
  });

  it("hands over next time what the writer refused this time", async () => {
    cloud.scans = scanRows(3, NOW - HOUR);
    applyScanChanges.mockRejectedValueOnce(new Error("writer down"));
    const first = await runScanSync({ now: NOW, access: cloud.access });
    expect(first).toMatchObject({ status: "error", inserted: 3 });
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingScans))).toHaveLength(3);

    const second = await runScanSync({ now: NOW + 60_000, access: cloud.access });
    expect(second).toMatchObject({ status: "ok", inserted: 0 });
    expect(applyScanChanges).toHaveBeenCalledTimes(2);
    expect(applyScanChanges.mock.calls[1][0]).toHaveLength(3);
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingScans))).toEqual([]);
  });
});
