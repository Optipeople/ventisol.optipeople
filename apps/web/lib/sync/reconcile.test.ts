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
import { runScanReconcile } from "./reconcile";
import { runScanSync } from "./scans";
import { JOBS, readState } from "./state";
import { DAY, FakeOptiCloud, HOUR, NOW, scanRow, scanRows } from "./test-fakes";

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
const state = () => db.withService((q) => readState(q, JOBS.reconcile));
const idOf = (row: { values: Record<string, unknown> }) => String(row.values.ScanId);

/** Twelve scans an hour apart, synced. */
async function seeded(count = 12) {
  cloud.scans = scanRows(count, NOW - HOUR);
  await runScanSync({ now: NOW, access: cloud.access });
  applyScanChanges.mockClear();
}

describe("the deletion rule", () => {
  it("only notes a row the first pass misses, and deletes it when a second pass misses it too", async () => {
    await seeded();
    const gone = idOf(cloud.scans[4]);
    cloud.scans.splice(4, 1);

    const first = await runScanReconcile({ now: NOW + DAY, access: cloud.access });
    expect(first).toMatchObject({ status: "ok", finished: true, deletionCheck: "done", noted: 1, deleted: 0 });
    expect(await storedIds()).toContain(gone);
    expect(applyScanChanges).not.toHaveBeenCalled();
    expect((await state())?.detail.missing).toEqual({ [gone]: NOW + DAY });

    const second = await runScanReconcile({ now: NOW + 2 * DAY, access: cloud.access });
    expect(second).toMatchObject({ status: "ok", noted: 0, deleted: 1 });
    expect(await storedIds()).not.toContain(gone);
    expect(await storedIds()).toHaveLength(11);
    // The deleted row is handed to the writer, so its order is worked out again.
    expect(applyScanChanges).toHaveBeenCalledTimes(1);
    expect(applyScanChanges.mock.calls[0][0]).toEqual([expect.objectContaining({ scanId: gone, orderNo: 58556 })]);
    expect((await state())?.detail.missing).toEqual({});
    expect((await state())?.rowsTotal).toBe(11);
  });

  it("drops the note when the row is there again on the next pass", async () => {
    await seeded();
    const row = cloud.scans[4];
    cloud.scans.splice(4, 1);
    await runScanReconcile({ now: NOW + DAY, access: cloud.access });

    cloud.scans.push(row);
    const second = await runScanReconcile({ now: NOW + 2 * DAY, access: cloud.access });
    expect(second.deleted).toBe(0);
    expect((await state())?.detail.missing).toEqual({});

    // Missing again later: that is a first miss again, not a second.
    cloud.scans = cloud.scans.filter((r) => r !== row);
    const third = await runScanReconcile({ now: NOW + 3 * DAY, access: cloud.access });
    expect(third).toMatchObject({ noted: 1, deleted: 0 });
    expect(await storedIds()).toHaveLength(12);
  });

  it("does not count two chunks of the same pass as two misses", async () => {
    await seeded();
    const gone = idOf(cloud.scans[10]);
    cloud.scans.splice(10, 1);

    // The pass is cut after two pages and resumes one page back, so the
    // stretch holding the row is compared twice within one pass.
    const part = await runScanReconcile({ now: NOW + DAY, access: cloud.access, maxPages: 2 });
    expect(part).toMatchObject({ finished: false, noted: 1, deleted: 0 });
    const rest = await runScanReconcile({ now: NOW + DAY + 60_000, access: cloud.access, resumeOnly: true });
    expect(rest).toMatchObject({ finished: true, deleted: 0 });
    expect(await storedIds()).toContain(gone);
  });

  it("deletes nothing when a large share of the stored rows looks missing", async () => {
    await seeded(40);
    cloud.scans = cloud.scans.slice(0, 10);
    for (const day of [1, 2, 3]) {
      const result = await runScanReconcile({ now: NOW + day * DAY, access: cloud.access });
      expect(result).toMatchObject({ deletionCheck: "too_many_missing", noted: 0, deleted: 0 });
    }
    expect(await storedIds()).toHaveLength(40);
  });

  it("deletes nothing when the API ignores the ordering", async () => {
    cloud.honoursOrder = false;
    cloud.scans = scanRows(12, NOW - HOUR, 60_000);
    await runScanSync({ now: NOW, access: cloud.access });
    cloud.scans.splice(4, 1);
    for (const day of [1, 2]) {
      const result = await runScanReconcile({ now: NOW + day * DAY, access: cloud.access, full: true });
      expect(result).toMatchObject({ unordered: true, deletionCheck: "unordered", deleted: 0 });
    }
    expect(await storedIds()).toHaveLength(12);
  });

  it("leaves rows outside the window alone", async () => {
    // One scan a week, 20 weeks back. The window is 45 days.
    cloud.scans = scanRows(20, NOW - HOUR, 7 * DAY);
    await runScanSync({ now: NOW, access: cloud.access });
    const old = idOf(cloud.scans[0]);
    const recent = idOf(cloud.scans[18]);
    cloud.scans = cloud.scans.filter((r) => idOf(r) !== old && idOf(r) !== recent);

    for (const day of [1, 2]) {
      await runScanReconcile({ now: NOW + day * 60_000, access: cloud.access });
    }
    const ids = await storedIds();
    expect(ids).toContain(old);
    expect(ids).not.toContain(recent);
  });

  it("never deletes a row without a scan time", async () => {
    await seeded();
    await db.withService((q) =>
      q.query("insert into raw.scans (scan_id, barcode, order_no) values ('timeless', '0585560501', 58556)")
    );
    for (const day of [1, 2]) await runScanReconcile({ now: NOW + day * DAY, access: cloud.access });
    expect(await storedIds()).toContain("timeless");
  });
});

describe("runScanReconcile", () => {
  it("finds an edit and a late row the minute sync did not look at", async () => {
    await seeded(30);
    const edited = cloud.scans[2];
    edited.values = { ...edited.values, Direction: "In", StationNo: 4 };
    cloud.scans.push(scanRow(NOW - 20 * HOUR - 1000, {}, "late"));

    const result = await runScanReconcile({ now: NOW + DAY, access: cloud.access });
    expect(result).toMatchObject({ status: "ok", mode: "window", inserted: 1, changed: 1, finished: true });
    expect(applyScanChanges.mock.calls[0][0].map((c) => c.scanId).sort()).toEqual([idOf(edited), "late"].sort());
  });

  it("stops at the window in window mode and reads everything in full mode", async () => {
    cloud.scans = scanRows(40, NOW - HOUR, 7 * DAY);
    await runScanSync({ now: NOW, access: cloud.access });
    cloud.pageCalls = [];

    const windowed = await runScanReconcile({ now: NOW, access: cloud.access, days: 30 });
    expect(windowed).toMatchObject({ mode: "window", finished: true });
    expect(windowed.pagesRead).toBeLessThan(8);

    const full = await runScanReconcile({ now: NOW + 1000, access: cloud.access, full: true });
    expect(full).toMatchObject({ mode: "full", finished: true, pagesRead: 8, rowsRead: 40 });
    expect((await state())?.detail.lastPass).toMatchObject({ mode: "full", pagesRead: 8 });
  });

  it("works through the whole list in chunks, with the cursor kept between invocations", async () => {
    cloud.scans = scanRows(30, NOW - HOUR);
    const first = await runScanReconcile({ now: NOW, access: cloud.access, full: true, maxPages: 2 });
    expect(first).toMatchObject({ finished: false, inserted: 10, pagesRead: 2 });
    expect((await state())?.detail.cursor).toMatchObject({ mode: "full", nextPage: 3, passId: NOW, inserted: 10 });
    expect((await state())?.lastSuccessAt).toBeNull();

    let rounds = 0;
    let last = first;
    while (!last.finished && rounds < 10) {
      rounds++;
      last = await runScanReconcile({
        now: NOW + rounds * 60_000,
        access: cloud.access,
        resumeOnly: true,
        maxPages: 2,
      });
    }
    expect(last.finished).toBe(true);
    expect(await storedIds()).toHaveLength(30);
    const row = await state();
    expect(row?.detail.cursor).toBeNull();
    expect(row?.lastSuccessAt).not.toBeNull();
    expect(row?.rowsTotal).toBe(30);
    // The pass is reported as one.
    expect(row?.detail.lastPass).toMatchObject({ inserted: 30, startedAt: new Date(NOW).toISOString() });
  });

  it("does nothing with resumeOnly when no pass is under way", async () => {
    const result = await runScanReconcile({ now: NOW, access: cloud.access, resumeOnly: true });
    expect(result).toMatchObject({ status: "idle", finished: true, pagesRead: 0 });
    expect(cloud.pageCalls).toEqual([]);
  });

  it("starts anew with restart", async () => {
    cloud.scans = scanRows(30, NOW - HOUR);
    await runScanReconcile({ now: NOW, access: cloud.access, full: true, maxPages: 2 });
    const again = await runScanReconcile({ now: NOW + 5000, access: cloud.access, full: true, restart: true });
    expect(again).toMatchObject({ finished: true, pagesRead: 6 });
    expect((await state())?.detail.lastPass).toMatchObject({ startedAt: new Date(NOW + 5000).toISOString() });
  });

  it("records a missing service account as a state", async () => {
    const result = await runScanReconcile({
      now: NOW,
      access: { status: "not_configured", missing: ["OPTICLOUD_SERVICE_USER"] },
    });
    expect(result.status).toBe("not_configured");
    expect((await state())?.detail).toMatchObject({ status: "not_configured", configured: false });
  });
});
