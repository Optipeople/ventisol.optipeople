// Ordrer: the two lists, search, the order page and the documents. The
// packed orders are the October scenario (figures in overview.test.ts), the
// orders in progress are IN_PROGRESS_ORDERS in test-support.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import {
  findOrders,
  getOrderDetail,
  getOrderDocuments,
  getOrderRoute,
  getOrderStatus,
  listFinishedOrders,
  listInProgressOrders,
} from "./index";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "./test-support";

const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
  await seedOctober(db, IN_PROGRESS_ORDERS);
});
afterAll(() => db.close());

const numbers = (rows: { orderNo: number }[]) => rows.map((r) => r.orderNo);

describe("listFinishedOrders", () => {
  it("a period is on the local day the order was packed, newest first", async () => {
    const october = await listFinishedOrders(viewer, OCTOBER);
    expect(october.total).toBe(3);
    // 50002 was packed 23:30 on the 31st. 50003, packed 00:10 on 1 November, is not in.
    expect(numbers(october.rows)).toEqual([50002, 50004, 50001]);
    expect(october.rows[0]).toMatchObject({
      orderNo: 50002,
      customer: "Kunde 50002",
      elements: 1,
      packedLocalDay: "2026-10-31",
      packedAt: "2026-10-31T22:30:00.000Z",
      lead: { seconds: 7200, wallSeconds: 127800, workingSeconds: 7200 },
      wait: { seconds: 3600, wallSeconds: 123600, workingSeconds: 3600 },
      onTime: false,
      status: "late",
      statusLabel: "Forsinket",
    });

    const all = await listFinishedOrders(viewer);
    expect(numbers(all.rows)).toEqual([50003, 50002, 50004, 50001, 50005]);
    expect(all.rows[0].statusLabel).toBe("Ingen leveringsuge");
  });

  it("searches order number, customer and case name", async () => {
    expect(numbers((await listFinishedOrders(viewer, { search: "50004" })).rows)).toEqual([50004]);
    expect(numbers((await listFinishedOrders(viewer, { search: "kunde 50001" })).rows)).toEqual([50001]);
    expect(numbers((await listFinishedOrders(viewer, { search: "SAG 50005" })).rows)).toEqual([50005]);
    // A wildcard in the search text is a plain character.
    expect((await listFinishedOrders(viewer, { search: "%" })).total).toBe(0);
    expect((await listFinishedOrders(viewer, { search: "_____ 50001" })).total).toBe(0);
  });

  it("filters on status", async () => {
    expect(numbers((await listFinishedOrders(viewer, { ...OCTOBER, status: "late" })).rows)).toEqual([50002]);
    expect(numbers((await listFinishedOrders(viewer, { ...OCTOBER, status: "on_time" })).rows)).toEqual([50004, 50001]);
    expect(numbers((await listFinishedOrders(viewer, { status: "unknown" })).rows)).toEqual([50003, 50005]);
  });

  it("sorts by a whitelisted column on the headline clock", async () => {
    const wall = await listFinishedOrders(viewer, { ...OCTOBER, sort: "lead", dir: "asc", clock: "wall" });
    expect(numbers(wall.rows)).toEqual([50001, 50002, 50004]);
    // Working time: 6000, then two of 7200 (the higher order number first).
    const working = await listFinishedOrders(viewer, { ...OCTOBER, sort: "lead", dir: "asc" });
    expect(numbers(working.rows)).toEqual([50001, 50004, 50002]);
    expect(numbers((await listFinishedOrders(viewer, { ...OCTOBER, sort: "order", dir: "asc" })).rows)).toEqual([
      50001, 50002, 50004,
    ]);
    // @ts-expect-error anything else is refused before it reaches the database
    await expect(listFinishedOrders(viewer, { sort: "order_no; drop table core.orders" })).rejects.toThrow();
  });

  it("pages, and a page past the end still knows the total", async () => {
    const first = await listFinishedOrders(viewer, { ...OCTOBER, pageSize: 2 });
    expect(numbers(first.rows)).toEqual([50002, 50004]);
    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    const second = await listFinishedOrders(viewer, { ...OCTOBER, pageSize: 2, page: 2 });
    expect(numbers(second.rows)).toEqual([50001]);
    expect(second.total).toBe(3);
    const fifth = await listFinishedOrders(viewer, { ...OCTOBER, pageSize: 2, page: 5 });
    expect(fifth.rows).toEqual([]);
    expect(fifth.total).toBe(3);
  });

  it("an empty period is an empty page", async () => {
    expect(await listFinishedOrders(viewer, { from: "2026-07-01", to: "2026-07-31" })).toEqual({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
  });
});

describe("listInProgressOrders", () => {
  it("lists what is not packed, newest started first, with time so far and status", async () => {
    const list = await listInProgressOrders(viewer, { now: NOW });
    expect(list.total).toBe(3);
    expect(numbers(list.rows)).toEqual([50007, 50006, 50008]);

    // 50006: 07:00 to 12:00 is 18000 s; at a station 07:00-07:40 and 11:00-12:00.
    expect(list.rows[1]).toMatchObject({
      orderNo: 50006,
      elements: 2,
      elementsAssembled: 1,
      currentStep: "assembly",
      currentStationNos: [2],
      currentLabel: "Station 20",
      elapsed: { seconds: 18000, wallSeconds: 18000, workingSeconds: 18000 },
      work: { seconds: 6000 },
      wait: { seconds: 12000 },
      status: "late",
      statusLabel: "Forsinket",
      openCount: 1,
    });
    expect(list.rows[0]).toMatchObject({
      orderNo: 50007,
      currentLabel: "Venter før pakning",
      elapsed: { seconds: 14400 },
      status: "unknown",
      statusLabel: "Ukendt",
    });
    // 50008: Tuesday 10/11 07:00 to Monday 16/11 12:00. Wall 6 d 5 h; in shifts 7 + 3 * 8 + 6 = 37 h.
    expect(list.rows[2]).toMatchObject({
      orderNo: 50008,
      customer: null,
      expectedSource: "scans",
      currentLabel: "Montage, venter",
      elapsed: { seconds: 133200, wallSeconds: 536400, workingSeconds: 133200 },
      missingScanOutCount: 1,
    });
  });

  it("searches, filters and limits to recently active orders", async () => {
    expect(numbers((await listInProgressOrders(viewer, { now: NOW, search: "hansen" })).rows)).toEqual([50006]);
    expect(numbers((await listInProgressOrders(viewer, { now: NOW, status: "late" })).rows)).toEqual([50006]);
    expect(numbers((await listInProgressOrders(viewer, { now: NOW, status: "unknown" })).rows)).toEqual([50007, 50008]);
    expect(numbers((await listInProgressOrders(viewer, { now: NOW, activeDays: 3 })).rows)).toEqual([50007, 50006]);
    expect(numbers((await listInProgressOrders(viewer, { now: NOW, sort: "elapsed", dir: "desc" })).rows)).toEqual([
      50008, 50006, 50007,
    ]);
  });
});

describe("findOrders", () => {
  it("finds by number, start of number, customer and case name", async () => {
    expect((await findOrders(viewer, { query: "50004" })).map((f) => [f.orderNo, f.match])).toEqual([[50004, "order_no"]]);
    const prefix = await findOrders(viewer, { query: "5000" });
    expect(prefix).toHaveLength(8);
    expect(new Set(prefix.map((f) => f.match))).toEqual(new Set(["order_no_prefix"]));
    expect((await findOrders(viewer, { query: "hansen" })).map((f) => [f.orderNo, f.match, f.status])).toEqual([
      [50006, "customer", "in_progress"],
    ]);
    expect((await findOrders(viewer, { query: "havnegade" })).map((f) => [f.orderNo, f.match])).toEqual([
      [50007, "case_name"],
    ]);
  });

  it("limits, and finds nothing for an empty or wildcard query", async () => {
    expect(await findOrders(viewer, { query: "5000", limit: 3 })).toHaveLength(3);
    expect(await findOrders(viewer, { query: "   " })).toEqual([]);
    expect(await findOrders(viewer, { query: "%" })).toEqual([]);
    expect(await findOrders(viewer, { query: "findes ikke" })).toEqual([]);
  });
});

describe("getOrderDetail", () => {
  it("a packed order: seven steps, both clocks, what went wrong", async () => {
    const d = await getOrderDetail(viewer, { orderNo: 50002, now: NOW });
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.order).toMatchObject({
      orderNo: 50002,
      status: "packed",
      currentLabel: "Pakket",
      deliveryStatus: "late",
      deliveryStatusLabel: "Forsinket",
      lead: { seconds: 7200, wallSeconds: 127800, workingSeconds: 7200 },
    });
    expect(d.steps.map((s) => [s.step, s.source])).toEqual([
      ["schirmer", "none"],
      ["wait_kmw", "none"],
      ["kmw", "none"],
      ["buffer", "none"],
      ["assembly", "scans"],
      ["wait_packing", "scans"],
      ["packing", "scans"],
    ]);
    // Working time: assembly 3600, waiting Friday 13:00 to 14:00, packing outside the shifts.
    expect(d.steps.slice(4).map((s) => s.duration.seconds)).toEqual([3600, 3600, 0]);
    expect(d.steps.slice(4).map((s) => s.duration.wallSeconds)).toEqual([3600, 123600, 600]);

    expect(d.elements).toHaveLength(1);
    expect(d.elements[0]).toMatchObject({ elementTypeName: "Vindue 1 fag", pathLabels: ["Station 10", "Pakning"] });

    expect(d.intervals.map((i) => [i.stationName, i.normalSeconds, i.duration.wallSeconds, i.deviationPercent])).toEqual([
      // 3600 against a normal time of 1500: +140 %.
      ["Station 10", 1500, 3600, 140],
      // Packed on a Saturday night: no working time, so no comparison.
      ["Pakning", 600, 600, null],
    ]);

    expect(d.notes.map((n) => [n.severity, n.code, n.step])).toEqual([
      ["problem", "packed_late", "packing"],
      ["watch", "slow_pass", "assembly"],
    ]);
    expect(d.notes[1].text).toBe("Station 10: pos. 1, stk. 1 tog 1 t 00 min mod normalt 25 min.");
    expect(d.notesHeadline).toBe("Her gik det galt");
    expect(d.steps.find((s) => s.step === "assembly")?.deviation).toBe(true);
    expect(d.documents).toEqual([]);
  });

  it("an order without deviations says so", async () => {
    const route = await getOrderRoute(viewer, { orderNo: 50004, now: NOW });
    expect(route).toMatchObject({
      orderNo: 50004,
      status: "packed",
      lead: { seconds: 7200, wallSeconds: 241200, workingSeconds: 7200 },
      notesHeadline: "Hold øje med",
    });
    // 50001: 1800 s at Station 10 against 1500 is +20 %, not over the threshold of 20.
    const clean = await getOrderRoute(viewer, { orderNo: 50001, now: NOW });
    expect(clean?.notes).toEqual([]);
    expect(clean?.notesHeadline).toBe("Ingen afvigelser");
    expect(clean?.steps).toHaveLength(7);
  });

  it("an order in progress: where it is and that the deadline has passed", async () => {
    const s = await getOrderStatus(viewer, { orderNo: 50006, now: NOW });
    expect(s).toMatchObject({
      orderNo: 50006,
      customer: "Hansen Byg",
      status: "in_progress",
      currentLabel: "Station 20",
      currentStep: "assembly",
      elements: 2,
      elementsAssembled: 1,
      elementsPacked: 0,
      packedAt: null,
      elapsed: { seconds: 18000 },
      deliveryStatus: "late",
      deliveryStatusLabel: "Forsinket",
    });
    const d = await getOrderDetail(viewer, { orderNo: 50006, now: NOW });
    expect(d?.notes.map((n) => n.code)).toEqual(["deadline_passed", "slow_pass"]);
    expect(d?.order.lead.seconds).toBeNull();

    const stale = await getOrderDetail(viewer, { orderNo: 50008, now: NOW });
    expect(stale?.notes.map((n) => [n.severity, n.code])).toEqual([["problem", "missing_scan_out"]]);
  });

  it("an unknown order is null", async () => {
    expect(await getOrderDetail(viewer, { orderNo: 12345, now: NOW })).toBeNull();
    expect(await getOrderStatus(viewer, { orderNo: 12345, now: NOW })).toBeNull();
    expect(await getOrderRoute(viewer, { orderNo: 12345, now: NOW })).toBeNull();
  });
});

describe("getOrderDocuments", () => {
  beforeEach(async () => {
    await db.withService((tx) =>
      tx.query(
        `insert into raw.order_documents
           (file_name, order_no, prefix, print_date, blob_reference, blob_name, content_type, size_bytes,
            sha256, device, synced_at, parsed, parsed_at, parser_version)
         values ('P_50001_20261019.pdf', 50001, 'P', date '2026-10-19', 'blob-ref-1', 'P_50001_20261019.pdf',
                 'application/pdf', 12345, 'abc', 'PC-1', timestamptz '2026-10-19 08:00:00+02',
                 $1::jsonb, timestamptz '2026-10-19 08:01:00+02', '1'),
                ('P_50002_20261028.pdf', 50002, 'P', null, 'blob-ref-2', null, null, null, null, null,
                 timestamptz '2026-10-28 08:00:00+01', null, null, null)`,
        [
          JSON.stringify({
            pageCount: 2,
            header: { orderNo: 50001, customer: "Kunde 50001", deliveryWeek: 43 },
            positions: [{ position: 1, quantity: 1, elementTypeId: "vindue_1_fag" }],
            problems: ["Linje 14 kunne ikke læses"],
          }),
        ]
      )
    );
  });

  it("every role reads the documents of one order through the function", async () => {
    const docs = await getOrderDocuments(viewer, { orderNo: 50001 });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      fileName: "P_50001_20261019.pdf",
      orderNo: 50001,
      prefix: "P",
      printDate: "2026-10-19",
      blobReference: "blob-ref-1",
      contentType: "application/pdf",
      sizeBytes: 12345,
      syncedAt: "2026-10-19T06:00:00.000Z",
      parsedAt: "2026-10-19T06:01:00.000Z",
      pageCount: 2,
      header: { orderNo: 50001, customer: "Kunde 50001", deliveryWeek: 43 },
      positions: [{ position: 1, quantity: 1, elementTypeId: "vindue_1_fag" }],
      problems: ["Linje 14 kunne ikke læses"],
    });
    // Nothing of the raw row beyond the listed columns.
    expect(Object.keys(docs[0])).not.toContain("sha256");
    expect(Object.keys(docs[0])).not.toContain("device");

    const unparsed = await getOrderDocuments(viewer, { orderNo: 50002 });
    expect(unparsed[0]).toMatchObject({ parsedAt: null, pageCount: null, header: null, positions: [], problems: [] });
    expect((await getOrderDetail(viewer, { orderNo: 50001, now: NOW }))?.documents).toHaveLength(1);
  });

  it("the table itself stays closed to users", async () => {
    await expect(
      db.withUser(testClaims("admin"), (tx) => tx.query("select file_name from raw.order_documents"))
    ).rejects.toThrow();
  });
});
