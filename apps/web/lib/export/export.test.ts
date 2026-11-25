// The export module: a column set for every query, an Excel file that reads
// back, a PDF with its title, and the route logic's refusals.

import { PDFDocument } from "pdf-lib";
import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { REPORT_QUERY_NAMES, type MissingScanOut, type ReportQueryName } from "@/lib/reports";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { cellText, formatHoursMinutes, xlsxCell } from "./cells";
import { REPORT_EXPORTS, type ExportColumn } from "./columns";
import { handleExport } from "./handler";
import { toPdf } from "./pdf";
import { buildExport, EXPORT_ROW_CAP, exportFileName, exportInput, periodText } from "./run";
import { safeSheetName, toXlsx } from "./xlsx";

const admin = testClaims("admin");
const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

/** URL parameters for every query, as the pages would put them in the link. */
const PARAMS: Record<ReportQueryName, Record<string, string>> = {
  find_order: { query: "5000" },
  order_status: { orderNo: "50006" },
  order_route: { orderNo: "50002" },
  finished_orders: {},
  orders_in_progress: {},
  bottleneck: OCTOBER,
  period_kpis: OCTOBER,
  lead_time_series: { ...OCTOBER, bucket: "week" },
  kpi_summary: OCTOBER,
  today: {},
  stations: {},
  station_day: { day: "2026-10-21" },
  station_performance: OCTOBER,
  calc_vs_measured: OCTOBER,
  management_kpis: { month: "2026-10" },
  monthly_lead_time: { month: "2026-10" },
  missing_scan_outs: {},
  incomplete_packed_orders: {},
  baseline_suggestion: { ...OCTOBER, minSamples: "1" },
  capacity_plan: { day: "2026-11-18" },
  staffing_analysis: OCTOBER,
};

function request(kind: "xlsx" | "pdf", report: string, params: Record<string, string> = {}): Request {
  const search = new URLSearchParams({ report, ...params });
  return new Request(`http://localhost/api/export/${kind}?${search}`, { headers: { "x-real-ip": "10.0.0.1" } });
}

const as = (claims: Claims | null) => ({
  getAccess: async () => (claims ? { claims } : null),
  now: () => NOW,
  allow: async () => true,
});

describe("column definitions", () => {
  it("cover every registered query with Danish headers", () => {
    expect(Object.keys(REPORT_EXPORTS).sort()).toEqual([...REPORT_QUERY_NAMES].sort());
    for (const name of REPORT_QUERY_NAMES) {
      const def = REPORT_EXPORTS[name];
      expect(def.columns.length, name).toBeGreaterThan(0);
      expect(def.title, name).toBeTruthy();
      expect(def.file, name).toMatch(/^[a-z0-9-]+$/);
      expect(safeSheetName(def.sheet), name).toBe(def.sheet);
      for (const c of def.columns) expect(c.header.trim(), name).not.toBe("");
      expect(new Set(def.columns.map((c) => c.header)).size, `${name}: unique headers`).toBe(def.columns.length);
    }
  });

  it("format cells: hours:minutes, Copenhagen time, unknown is not 0", () => {
    expect(formatHoursMinutes(3 * 3600 + 7 * 60 + 20)).toBe("3:07");
    expect(formatHoursMinutes(26 * 3600)).toBe("26:00");
    expect(cellText("duration", 4500)).toBe("1:15");
    expect(cellText("duration", null)).toBe("Ingen data endnu");
    expect(cellText("percent", 66.7)).toBe("67 %");
    expect(cellText("day", "2026-10-21")).toBe("21-10-2026");
    // 05:42 UTC is 07:42 in Copenhagen summer time, 06:42 in winter.
    expect(cellText("datetime", "2026-10-21T05:42:00Z")).toBe("21-10-2026 07:42");
    expect(cellText("datetime", "2026-11-16T05:42:00Z")).toBe("16-11-2026 06:42");
    expect(cellText("bool", false)).toBe("Nej");
    expect(xlsxCell("duration", 3600)).toMatchObject({ value: 1 / 24, format: "[h]:mm" });
    expect(xlsxCell("percent", 50)).toMatchObject({ value: 0.5 });
    expect(xlsxCell("int", null)).toBeNull();
    expect((xlsxCell("datetime", "2026-10-21T05:42:00Z")!.value as Date).toISOString()).toBe("2026-10-21T07:42:00.000Z");
  });

  it("missing scan-outs say which were stopped at shift end, and when", () => {
    const columns = REPORT_EXPORTS.missing_scan_outs.columns as ExportColumn<MissingScanOut>[];
    const cell = (row: MissingScanOut, header: string) => {
      const c = columns.find((x) => x.header === header);
      if (!c) throw new Error(header);
      return cellText(c.kind, c.value(row) ?? null);
    };
    const base = {
      intervalId: "i", orderNo: 50010, customer: null, barcode: "050010010101", position: 1, subPosition: 1, piece: 1,
      elementTypeId: null, stationNo: 1, stationName: "Station 10", stationKind: "assembly",
      startAt: "2026-11-13T12:20:00.000Z", localDay: "2026-11-13", orderStatus: "in_progress",
    } as const;
    const stopped: MissingScanOut = {
      ...base, endAt: "2026-11-13T13:00:00.000Z", kind: "auto_stopped", missingReason: null, reasonLabel: "Stoppet ved vagtskifte 14:00",
    };
    const missing: MissingScanOut = { ...base, endAt: null, kind: "missing", missingReason: "stale", reasonLabel: "Ingen ud-scanning i 36 timer" };
    expect([cell(stopped, "Auto-stop"), cell(stopped, "Stoppet"), cell(stopped, "Årsag")]).toEqual([
      "Ja", "13-11-2026 14:00", "Stoppet ved vagtskifte 14:00",
    ]);
    expect(cell(missing, "Auto-stop")).toBe("Nej");
    const stationAuto = REPORT_EXPORTS.station_day.columns.find((c) => c.header === "Auto-stop");
    expect(stationAuto).toBeDefined();
  });

  it("read URL parameters as the schema wants them", () => {
    const input = exportInput("finished_orders", new URLSearchParams({ from: "2026-10-01", page: "3", pageSize: "5", bogus: "x" }), NOW);
    expect(input).toEqual({ from: "2026-10-01" });
    expect(exportInput("order_status", new URLSearchParams({ orderNo: "50006" }), NOW)).toEqual({ orderNo: 50006, now: NOW });
    expect(exportInput("order_status", new URLSearchParams({ orderNo: "abc" }), NOW).orderNo).toBe("abc");
    expect(periodText({ from: "2026-10-01", to: "2026-10-31" })).toBe("Periode: 01-10-2026 til 31-10-2026");
    expect(periodText({ month: "2026-10-01" })).toBe("Måned: oktober 2026");
    expect(exportFileName("finished_orders", "xlsx", NOW)).toBe("afsluttede-ordrer-2026-11-16.xlsx");
  });
});

describe("files", () => {
  interface Row {
    name: string;
    seconds: number | null;
    day: string;
  }
  const columns: ExportColumn<Row>[] = [
    { header: "Navn", kind: "text", value: (r) => r.name },
    { header: "Tid", kind: "duration", value: (r) => r.seconds },
    { header: "Dag", kind: "day", value: (r) => r.day },
  ];
  const rows: Row[] = [
    { name: "Vindue 1 fag", seconds: 5400, day: "2026-10-21" },
    { name: "Dør på ø", seconds: null, day: "2026-10-22" },
  ];

  it("xlsx reads back with headers and values", async () => {
    const buffer = await toXlsx("Ordrer", columns, rows, { title: "Afsluttede ordrer", notes: ["En note"] });
    const sheet = await readSheet(buffer);
    expect(sheet[0]).toEqual(["Navn", "Tid", "Dag"]);
    expect(sheet[1][0]).toBe("Vindue 1 fag");
    // A duration is Excel time (days) with [h]:mm. read-excel-file sees a
    // time format and returns it as a time on Excel's day zero.
    expect((sheet[1][1] as unknown as Date).getTime()).toBe(Date.UTC(1899, 11, 30, 1, 30));
    expect((sheet[1][2] as unknown as Date).toISOString().slice(0, 10)).toBe("2026-10-21");
    expect(sheet[2][0]).toBe("Dør på ø");
    expect(sheet[2][1]).toBeNull();
    const info = await readSheet(buffer, 2);
    expect(info.flat()).toContain("En note");
  });

  it("pdf is a document with the title and every row", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ name: `Række ${i} − æøå`, seconds: i * 60, day: "2026-10-21" }));
    const bytes = await toPdf({ title: "Afsluttede ordrer", period: "Periode: 01-10-2026 til 31-10-2026", generated: "Dannet 16-11-2026 12:00", columns, rows: many });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("Afsluttede ordrer");
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("pdf with no rows still renders", async () => {
    const bytes = await toPdf({ title: "Tom", generated: "Dannet nu", columns, rows: [] });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("against the report layer", () => {
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

  it.each(REPORT_QUERY_NAMES)("%s exports to xlsx and pdf as admin", async (name) => {
    const input = exportInput(name, new URLSearchParams(PARAMS[name]), NOW);
    const xlsx = await buildExport(admin, name, "xlsx", input, NOW);
    const sheet = await readSheet(Buffer.from(xlsx.body));
    expect(sheet[0]).toEqual(REPORT_EXPORTS[name].columns.map((c) => c.header));
    expect(sheet.length - 1).toBe(xlsx.rows);
    const pdf = await buildExport(admin, name, "pdf", input, NOW);
    expect((await PDFDocument.load(pdf.body)).getTitle()).toBe(REPORT_EXPORTS[name].title);
  });

  it("a paged query exports every page", async () => {
    const file = await buildExport(admin, "finished_orders", "xlsx", {}, NOW);
    expect(file.rows).toBeGreaterThan(0);
    expect(file.capped).toBe(false);
    expect(EXPORT_ROW_CAP).toBe(10_000);
  });

  it("the handler streams a file with a Danish name and leaves an audit row", async () => {
    const res = await handleExport(request("xlsx", "finished_orders", OCTOBER), "xlsx", as(admin));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="afsluttede-ordrer-2026-11-16.xlsx"');
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const sheet = await readSheet(Buffer.from(await res.arrayBuffer()));
    expect(sheet[0][0]).toBe("Ordre");

    const pdf = await handleExport(request("pdf", "station_day", { day: "2026-10-21" }), "pdf", as(admin));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");

    const log = await db.withService((tx) =>
      tx.query<{ action: string; subject: string; opti_user_id: string }>(
        "select action, subject, opti_user_id from app.audit_log order by id"
      )
    );
    expect(log).toEqual([
      { action: "export.xlsx", subject: "finished_orders", opti_user_id: admin.optiUserId },
      { action: "export.pdf", subject: "station_day", opti_user_id: admin.optiUserId },
    ]);
  });

  it("refuses: 401 signed out, 403 viewer on calc_vs_measured, 400 bad input, 429 over the limit", async () => {
    expect((await handleExport(request("xlsx", "stations"), "xlsx", as(null))).status).toBe(401);
    expect((await handleExport(request("xlsx", "calc_vs_measured", OCTOBER), "xlsx", as(viewer))).status).toBe(403);
    expect((await handleExport(request("pdf", "management_kpis", { month: "2026-10" }), "pdf", as(viewer))).status).toBe(403);
    expect((await handleExport(request("xlsx", "no_such_report"), "xlsx", as(admin))).status).toBe(400);
    expect((await handleExport(request("xlsx", "station_day", { day: "21-10-2026" }), "xlsx", as(admin))).status).toBe(400);
    expect((await handleExport(request("xlsx", "station_performance", { from: "2026-10-31", to: "2026-10-01" }), "xlsx", as(admin))).status).toBe(400);
    const limited = await handleExport(request("xlsx", "stations"), "xlsx", { ...as(admin), allow: async () => false });
    expect(limited.status).toBe(429);
    // The viewer can export what it may see.
    expect((await handleExport(request("xlsx", "stations"), "xlsx", as(viewer))).status).toBe(200);

    const log = await db.withService((tx) => tx.query<{ action: string }>("select action from app.audit_log"));
    expect(log).toHaveLength(1);
  });

  it("the default rate limit counts per user and IP", async () => {
    const deps = { getAccess: async () => ({ claims: admin }), now: () => NOW };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await handleExport(request("xlsx", "stations"), "xlsx", deps)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
