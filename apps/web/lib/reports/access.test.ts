// Who may read what. The wrapper checks the capability, the database checks
// the role again, and row level security keeps another account out.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import {
  findOrders,
  getBottleneck,
  getCalcVsMeasured,
  getManagementKpis,
  getManagementNotes,
  getMonthlyLeadTime,
  getMonthReport,
  getOrderDetail,
  getOrderDocuments,
  getPeriodKpis,
  getSnapshot,
  getStationDay,
  getStationDetail,
  isReportQueryName,
  listFinishedOrders,
  listInProgressOrders,
  listMissingScanOuts,
  listSnapshots,
  listStations,
  REPORT_QUERIES,
  REPORT_QUERY_NAMES,
  ReportAccessError,
  reportQueriesFor,
  runReportQuery,
  saveManagementNotes,
  type ReportQueryName,
} from "./index";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "./test-support";

const admin = testClaims("admin");
const ledelse = testClaims("ledelse");
const planner = testClaims("planner");
const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const OTHER_ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";

const LEDELSE_QUERIES: ReportQueryName[] = ["management_kpis", "monthly_lead_time"];

/** A valid input for every registered query. */
const INPUTS: Record<ReportQueryName, unknown> = {
  find_order: { query: "5000" },
  order_status: { orderNo: 50006, now: NOW },
  order_route: { orderNo: 50002, now: NOW },
  finished_orders: {},
  orders_in_progress: { now: NOW },
  bottleneck: OCTOBER,
  period_kpis: OCTOBER,
  lead_time_series: { ...OCTOBER, bucket: "week" },
  kpi_summary: { ...OCTOBER, now: NOW },
  today: { now: NOW },
  stations: {},
  station_day: { day: "2026-10-21" },
  station_performance: OCTOBER,
  calc_vs_measured: OCTOBER,
  management_kpis: { month: "2026-10" },
  monthly_lead_time: { month: "2026-10" },
  missing_scan_outs: {},
  incomplete_packed_orders: { now: NOW },
  baseline_suggestion: { ...OCTOBER, minSamples: 1 },
  capacity_plan: { day: "2026-11-18" },
  staffing_analysis: OCTOBER,
};

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

describe("Ledelse functions", () => {
  const calls: [string, (claims: Claims) => Promise<unknown>][] = [
    ["getManagementKpis", (c) => getManagementKpis(c, { month: "2026-10" })],
    ["getMonthlyLeadTime", (c) => getMonthlyLeadTime(c, { month: "2026-10" })],
    ["getMonthReport", (c) => getMonthReport(c, { month: "2026-10", now: NOW })],
    ["listSnapshots", (c) => listSnapshots(c)],
    ["getSnapshot", (c) => getSnapshot(c, { month: "2026-10" })],
    ["getManagementNotes", (c) => getManagementNotes(c, { month: "2026-10" })],
    ["saveManagementNotes", (c) => saveManagementNotes(c, { month: "2026-10", highlights: ["x"], decisions: [], now: NOW })],
  ];

  it.each(calls)("%s: admin and ledelse only", async (_name, call) => {
    await expect(call(viewer)).rejects.toBeInstanceOf(ReportAccessError);
    await expect(call(planner)).rejects.toBeInstanceOf(ReportAccessError);
    await expect(call(ledelse)).resolves.toBeDefined();
    await expect(call(admin)).resolves.toBeDefined();
  });

  it("a refused save writes neither notes nor an audit row", async () => {
    await expect(
      saveManagementNotes(viewer, { month: "2026-10", highlights: ["x"], decisions: [], now: NOW })
    ).rejects.toBeInstanceOf(ReportAccessError);
    const [counts] = await db.withService((tx) =>
      tx.query<{ notes: number; audit: number }>(
        `select (select count(*)::int from rpt.management_notes) as notes,
                (select count(*)::int from app.audit_log) as audit`
      )
    );
    expect(counts).toEqual({ notes: 0, audit: 0 });
  });
});

describe("calculated against measured", () => {
  it("admin, ledelse and planner, never viewer", async () => {
    await expect(getCalcVsMeasured(viewer, OCTOBER)).rejects.toBeInstanceOf(ReportAccessError);
    for (const claims of [admin, ledelse, planner]) {
      expect((await getCalcVsMeasured(claims, OCTOBER)).rows).toHaveLength(2);
    }
  });
});

describe("the database checks the role itself", () => {
  const refused: [string, string][] = [
    ["rpt.calc_vs_measured", "select * from rpt.calc_vs_measured(date '2026-10-01', date '2026-10-31')"],
    ["rpt.month_report", "select rpt.month_report(date '2026-10-01', timestamptz '2026-11-16 12:00:00+01')"],
    ["rpt.require_role", "select rpt.require_role('admin', 'ledelse')"],
  ];

  it.each(refused)("%s called directly as viewer raises insufficient_privilege", async (_name, sql) => {
    await expect(db.withUser(viewer, (tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
  });

  it("planner may run calc_vs_measured and not month_report", async () => {
    await expect(db.withUser(planner, (tx) => tx.query(refused[0][1]))).resolves.toHaveLength(2);
    await expect(db.withUser(planner, (tx) => tx.query(refused[1][1]))).rejects.toMatchObject({ code: "42501" });
  });

  it("viewer cannot read the calculated times from the table either", async () => {
    const read = db.withUser(viewer, (tx) => tx.query("select * from config.calculated_times"));
    await expect(read.catch(() => [])).resolves.toEqual([]);
  });
});

describe("viewer never receives calculated times", () => {
  it("no result a viewer can reach carries a calculated field", async () => {
    const results: Record<string, unknown> = {};
    for (const name of reportQueriesFor(viewer)) results[name] = await runReportQuery(viewer, name, INPUTS[name]);
    results.orderDetail = await getOrderDetail(viewer, { orderNo: 50002, now: NOW });
    results.stationDetail = await getStationDetail(viewer, { stationNo: 1, day: "2026-10-21" });
    results.stationList = await listStations(viewer);
    results.documents = await getOrderDocuments(viewer, { orderNo: 50002 });

    for (const [name, result] of Object.entries(results)) {
      expect(result, name).toBeDefined();
      expect(JSON.stringify(result), name).not.toMatch(/calculated/i);
    }
    // The same scan does find them where they belong.
    expect(JSON.stringify(await getCalcVsMeasured(planner, OCTOBER))).toMatch(/calculatedSeconds/);
  });
});

describe("another account", () => {
  const foreign = (role: Claims["role"]): Claims => ({ accountId: OTHER_ACCOUNT_ID, optiUserId: `u-${role}`, role });

  it("gets nothing from the functions open to every role", async () => {
    const claims = foreign("admin");
    expect((await getPeriodKpis(claims, OCTOBER)).current.ordersPacked).toBe(0);
    expect((await getBottleneck(claims, OCTOBER)).bottleneck).toBeNull();
    expect((await listFinishedOrders(claims)).total).toBe(0);
    expect((await listInProgressOrders(claims, { now: NOW })).total).toBe(0);
    expect(await findOrders(claims, { query: "5000" })).toEqual([]);
    expect(await getOrderDetail(claims, { orderNo: 50001, now: NOW })).toBeNull();
    expect(await listStations(claims)).toEqual([]);
    expect((await getStationDay(claims, { day: "2026-10-21" })).rows).toEqual([]);
    expect((await listMissingScanOuts(claims)).total).toBe(0);
  });

  it("is refused where the function checks the role", async () => {
    for (const role of ["admin", "ledelse", "planner", "viewer"] as const) {
      const claims = foreign(role);
      await expect(getCalcVsMeasured(claims, OCTOBER), role).rejects.toBeInstanceOf(ReportAccessError);
      await expect(getManagementKpis(claims, { month: "2026-10" }), role).rejects.toBeInstanceOf(ReportAccessError);
      // The documents function runs as definer, so it must check for itself.
      await expect(getOrderDocuments(claims, { orderNo: 50001 }), role).rejects.toBeInstanceOf(ReportAccessError);
    }
  });
});

describe("the query registry", () => {
  it("offers each role the queries it may run", () => {
    const all = [...REPORT_QUERY_NAMES].sort();
    const withoutLedelse = all.filter((n) => !LEDELSE_QUERIES.includes(n));
    expect([...reportQueriesFor(admin)].sort()).toEqual(all);
    expect([...reportQueriesFor(ledelse)].sort()).toEqual(all);
    expect([...reportQueriesFor(planner)].sort()).toEqual(withoutLedelse);
    expect([...reportQueriesFor(viewer)].sort()).toEqual(withoutLedelse.filter((n) => n !== "calc_vs_measured"));
    expect(REPORT_QUERIES.calc_vs_measured.capability).toBe("costs.view");
  });

  it("every query runs for admin with a valid input", async () => {
    for (const name of REPORT_QUERY_NAMES) {
      expect(await runReportQuery(admin, name, INPUTS[name]), name).toBeDefined();
    }
  });

  it("refuses by role before it reads the input, and validates the input", async () => {
    await expect(runReportQuery(viewer, "calc_vs_measured", OCTOBER)).rejects.toBeInstanceOf(ReportAccessError);
    await expect(runReportQuery(viewer, "management_kpis", { nonsense: true })).rejects.toBeInstanceOf(ReportAccessError);
    await expect(runReportQuery(planner, "monthly_lead_time", { month: "2026-10" })).rejects.toBeInstanceOf(ReportAccessError);
    await expect(runReportQuery(viewer, "period_kpis", { from: "1 October", to: "2026-10-31" })).rejects.toThrow();
    await expect(runReportQuery(viewer, "finished_orders", { sort: "packed_at desc; drop table core.orders" })).rejects.toThrow();
    await expect(runReportQuery(viewer, "order_status", { orderNo: "50001 or 1=1", now: NOW })).rejects.toThrow();
    await expect(runReportQuery(viewer, "today", undefined)).rejects.toThrow();
  });

  it("knows only its own names", async () => {
    expect(isReportQueryName("period_kpis")).toBe(true);
    expect(isReportQueryName("toString")).toBe(false);
    expect(isReportQueryName("select * from core.orders")).toBe(false);
    await expect(runReportQuery(admin, "constructor", {})).rejects.toThrow("Unknown report query");
  });
});
