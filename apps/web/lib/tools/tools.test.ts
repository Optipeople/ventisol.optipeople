// The chat tools on PGlite: which role gets which tool, that every tool runs
// on real derived rows and returns compact JSON, and that the role rules of
// the report layer hold through the tools.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { REPORT_QUERY_NAMES, type ReportQueryName } from "@/lib/reports";
import { element, IN_PROGRESS_ORDERS, local, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { pass } from "@/lib/test-helpers";
import { estimateCostUsd } from "@/app/api/chat/pricing";
import {
  buildSystemPrompt,
  buildSystemPromptParts,
  chatToolsFor,
  compact,
  compactResult,
  MAX_LIST,
  runChatTool,
  TIMELINE_MAX_ROWS,
  type ToolContext,
} from "./index";
import { withMaxOpen } from "./report-tools";

const admin = testClaims("admin");
const ledelse = testClaims("ledelse");
const planner = testClaims("planner");
const viewer = testClaims("viewer");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

const ctx = (claims = admin): ToolContext => ({ claims, now: NOW });
const names = (claims = admin) => chatToolsFor(claims).map((t) => t.name);

/** What the model would send to every tool: no `now`, the tool adds it. */
const MODEL_INPUTS: Record<ReportQueryName | "station_timeline" | "search_documents", unknown> = {
  find_order: { query: "5000" },
  order_status: { orderNo: 50006 },
  order_route: { orderNo: 50002 },
  finished_orders: { from: "2026-10-01" },
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
  monthly_lead_time: { month: "2026-10", months: 3 },
  missing_scan_outs: {},
  incomplete_packed_orders: {},
  baseline_suggestion: { ...OCTOBER, minSamples: 1 },
  capacity_plan: { day: "2026-11-18" },
  staffing_analysis: OCTOBER,
  station_timeline: { stationNo: 1, from: "2026-10-21" },
  search_documents: { query: "terrassedør" },
};

describe("which tools a role gets", () => {
  it("admin gets one tool per report query plus station_timeline and search_documents", () => {
    expect(names(admin)).toEqual([...REPORT_QUERY_NAMES, "station_timeline", "search_documents"]);
  });

  it("every role that sees stations gets station_timeline", () => {
    for (const claims of [admin, ledelse, planner, viewer]) expect(names(claims)).toContain("station_timeline");
  });

  it("a viewer never gets calc_vs_measured or the Ledelse tools", () => {
    const tools = names(viewer);
    expect(tools).not.toContain("calc_vs_measured");
    expect(tools).not.toContain("management_kpis");
    expect(tools).not.toContain("monthly_lead_time");
    expect(tools).toContain("order_status");
    expect(tools).toContain("search_documents");
  });

  it("a planner gets calc_vs_measured but not the Ledelse tools", () => {
    expect(names(planner)).toContain("calc_vs_measured");
    expect(names(planner)).not.toContain("management_kpis");
    expect(names(ledelse)).toContain("management_kpis");
  });

  it("every tool has a Danish description and an input schema that converts to JSON schema", () => {
    for (const tool of chatToolsFor(admin)) {
      expect(tool.description.length, tool.name).toBeGreaterThan(30);
      const schema = z.toJSONSchema(tool.inputSchema) as { type?: string; properties?: object };
      expect(schema.type, tool.name).toBe("object");
      expect(Object.keys(schema.properties ?? {}), tool.name).not.toContain("now");
    }
  });

  it("there is a model input for every tool", () => {
    expect(Object.keys(MODEL_INPUTS).sort()).toEqual(names(admin).sort());
  });
});

describe("running the tools", () => {
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

  it.each(names(admin))("%s runs for admin and returns compact JSON", async (name) => {
    const result = await runChatTool(ctx(admin), name, MODEL_INPUTS[name as keyof typeof MODEL_INPUTS]);
    const json = JSON.stringify(result.data);
    expect(json).not.toContain('"error"');
    // Durations reach the model as one headline number in seconds.
    expect(json).not.toContain("wallSeconds");
    expect(json).not.toContain("workingSeconds");
    expect(json.length).toBeLessThan(40_000);
    expect(Array.isArray(result.views)).toBe(true);
  });

  it("a viewer calling calc_vs_measured anyway gets a refusal, never the figures", async () => {
    const result = await runChatTool(ctx(viewer), "calc_vs_measured", OCTOBER);
    expect(result.data).toMatchObject({ error: "forbidden" });
    expect(JSON.stringify(result)).not.toMatch(/calculated/i);
  });

  it("a viewer calling a Ledelse tool gets a refusal", async () => {
    const result = await runChatTool(ctx(viewer), "management_kpis", { month: "2026-10" });
    expect(result.data).toMatchObject({ error: "forbidden" });
  });

  it("nothing a viewer can reach through the tools carries a calculated time", async () => {
    for (const name of names(viewer)) {
      const result = await runChatTool(ctx(viewer), name, MODEL_INPUTS[name as keyof typeof MODEL_INPUTS]);
      expect(JSON.stringify(result), name).not.toMatch(/calculated/i);
    }
  });

  it("bad input comes back as an error the model can read", async () => {
    const result = await runChatTool(ctx(admin), "order_status", { orderNo: "abc" });
    expect(result.data).toMatchObject({ error: "invalid_input" });
    const period = await runChatTool(ctx(admin), "bottleneck", { from: "2026-10-31", to: "2026-10-01" });
    expect(period.data).toMatchObject({ error: "invalid_input" });
  });

  it("an unknown tool is refused", async () => {
    const result = await runChatTool(ctx(admin), "drop_tables", {});
    expect(result.data).toMatchObject({ error: "forbidden" });
  });

  it("order_status gives the order, a KPI view and a link to its page", async () => {
    const result = await runChatTool(ctx(admin), "order_status", { orderNo: 50006 });
    expect(result.data).toMatchObject({ orderNo: 50006 });
    expect(result.views[0]).toMatchObject({ kind: "kpis" });
    expect(result.href).toBe("/ordre/50006");
  });

  it("an unknown order is a note, not an error", async () => {
    const result = await runChatTool(ctx(admin), "order_status", { orderNo: 999999 });
    expect(result.data).toBeNull();
    expect(result.views[0]).toMatchObject({ kind: "note" });
  });

  it("lead_time_series draws its weeks as a line, from the same numbers the model reads", async () => {
    const result = await runChatTool(ctx(admin), "lead_time_series", { ...OCTOBER, bucket: "week" });
    expect(result.views).toHaveLength(1);
    const view = result.views[0];
    if (view?.kind !== "line") throw new Error("expected a line view");
    expect(view.unit).toBe("h");
    expect(view.points.length).toBeGreaterThan(1);
    expect(view.points.some((p) => p.value != null)).toBe(true);

    const rows = result.data as { bucketStart: string; isoWeek: number; leadSeconds: number | null }[];
    expect(view.points.map((p) => p.start)).toEqual(rows.map((r) => r.bucketStart));
    for (const [i, p] of view.points.entries()) {
      const row = rows[i]!;
      expect(p.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.label).toBe(`Uge ${row.isoWeek}`);
      expect(p.isoWeek).toBe(row.isoWeek);
      expect(typeof p.isoYear).toBe("number");
      if (row.leadSeconds == null) {
        expect(p.value).toBeNull();
      } else {
        // Hours with one decimal (data is rounded to whole seconds).
        expect(p.value).toBeCloseTo(row.leadSeconds / 3600, 1);
        expect(p.display).not.toBe("");
      }
    }
    // The view is stored as JSON with the conversation.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("monthly_lead_time draws its months as a line, without week fields", async () => {
    const result = await runChatTool(ctx(admin), "monthly_lead_time", { month: "2026-10", months: 3 });
    expect(result.views).toHaveLength(1);
    const view = result.views[0];
    if (view?.kind !== "line") throw new Error("expected a line view");
    expect(view.points.map((p) => p.start)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(view.points.map((p) => p.label)).toEqual(["aug. 2026", "sep. 2026", "okt. 2026"]);
    for (const p of view.points) {
      expect(p).not.toHaveProperty("isoWeek");
      expect(p).not.toHaveProperty("isoYear");
    }
    const october = view.points[2]!;
    expect(october.value).toBeGreaterThan(0);
    expect(october.display).toMatch(/\d/);
  });

  it("capacity_plan and staffing_analysis say there is no data yet", async () => {
    const capacity = await runChatTool(ctx(admin), "capacity_plan", { day: "2026-11-18" });
    expect(capacity.data).toMatchObject({ available: false, reason: "no_planned_orders" });
    const staffing = await runChatTool(ctx(admin), "staffing_analysis", OCTOBER);
    expect(staffing.data).toMatchObject({ available: false, reason: "no_staffing_data" });
  });
});

// Station 1 with "Max i gang" 3: order 50009 is on it 07:10-07:40 on
// 21 October, beside 50001 (07:00-07:30). The split is set by hand as the
// station-day rebuild would: 50001 gets 1200 s of its 1800, 50009 1500.
describe("parallel work at a station", () => {
  let db: TestDb;
  const DAY = "2026-10-21";

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    await db.reset();
    await seedConfig(db);
    await seedOctober(db, [
      { scans: pass(local(DAY, "08:10"), local(DAY, "08:40"), element(50009, 1)), info: null },
    ]);
    await db.withService(async (tx) => {
      await tx.query("update config.stations set max_open = 3 where station_no = 1");
      await tx.query(
        `update core.station_intervals set start_at = start_at - interval '1 hour', end_at = end_at - interval '1 hour',
           allocated_seconds = 1500, allocated_working_seconds = 1500
         where order_no = 50009 and station_no = 1`
      );
      await tx.query(
        `update core.station_intervals set allocated_seconds = 1200, allocated_working_seconds = 1200
         where order_no = 50001 and station_no = 1`
      );
    });
  });
  afterAll(() => db.close());

  type Timeline = {
    maxOpen: number;
    parallel: boolean;
    passes: number;
    maxConcurrent: number;
    passesSplit: number;
    rows: { orderNo: number; durationSeconds: number | null; splitSeconds: number | null; overlapping: number }[];
  };

  it("station_timeline gives each pass its wall-clock time and its split time", async () => {
    const result = await runChatTool(ctx(admin), "station_timeline", { stationNo: 1, from: DAY, clock: "wall" });
    const t = result.data as Timeline;
    expect(t).toMatchObject({ maxOpen: 3, parallel: true, passes: 2, maxConcurrent: 2, passesSplit: 2 });
    expect(t.rows.map((r) => [r.orderNo, r.durationSeconds, r.splitSeconds, r.overlapping])).toEqual([
      [50001, 1800, 1200, 1],
      [50009, 1800, 1500, 1],
    ]);
    const json = JSON.stringify(t);
    expect(json).not.toContain("wallSeconds");
    expect(json).not.toContain("intervalId");
    const table = result.views.find((v) => v.kind === "table");
    if (table?.kind !== "table") throw new Error("expected a table view");
    expect(table.columns.map((c) => c.label)).toEqual(["Ind", "Ud", "Element", "Type", "Tid", "Delt tid"]);
    expect(table.rows).toHaveLength(2);
    expect(result.views[0]).toMatchObject({ kind: "note" });
    expect(result.href).toBe(`/stationer/1?day=${DAY}&clock=wall`);
  });

  it("a station with one at a time is not parallel, and a range is cut at a week", async () => {
    const result = await runChatTool(ctx(viewer), "station_timeline", { stationNo: 7, from: "2026-10-01", to: "2026-10-31" });
    const t = result.data as Timeline & { period: { from: string; to: string }; daysOmitted: number };
    expect(t).toMatchObject({ maxOpen: 1, parallel: false, period: { from: "2026-10-01", to: "2026-10-07" }, daysOmitted: 24 });
    expect(result.views.some((v) => v.kind === "note")).toBe(false);
  });

  it("keeps at most TIMELINE_MAX_ROWS passes and counts the rest", () => {
    expect(TIMELINE_MAX_ROWS).toBeLessThanOrEqual(MAX_LIST);
  });

  it.each(["station_day", "station_performance", "calc_vs_measured", "bottleneck", "baseline_suggestion", "stations"])(
    "%s carries each station's maxOpen",
    async (name) => {
      const input = name === "station_day" ? { day: DAY } : name === "stations" ? {} : { ...OCTOBER, ...(name === "baseline_suggestion" ? { minSamples: 1 } : {}) };
      const result = await runChatTool(ctx(admin), name, input);
      const found: { stationNo: number; maxOpen: unknown }[] = [];
      JSON.stringify(result.data, (key, value) => {
        if (value && typeof value === "object" && typeof (value as { stationNo?: unknown }).stationNo === "number") {
          found.push(value as { stationNo: number; maxOpen: unknown });
        }
        return value;
      });
      expect(found.length, name).toBeGreaterThan(0);
      for (const s of found) expect(s.maxOpen, `${name} station ${s.stationNo}`).toBe(s.stationNo === 1 ? 3 : 1);
    }
  );
});

describe("withMaxOpen", () => {
  it("puts maxOpen beside every stationNo, 1 for an unknown station, and keeps one already there", () => {
    const map = new Map([[1, 6]]);
    expect(withMaxOpen({ rows: [{ stationNo: 1 }, { stationNo: 9 }], stationNo: null }, map)).toEqual({
      rows: [
        { stationNo: 1, maxOpen: 6 },
        { stationNo: 9, maxOpen: 1 },
      ],
      stationNo: null,
    });
    expect(withMaxOpen([{ stationNo: 1, maxOpen: 2 }], map)).toEqual([{ stationNo: 1, maxOpen: 2 }]);
  });
});

describe("compact", () => {
  it("turns a Duration into one headline number with the unit in the key", () => {
    expect(compact({ lead: { seconds: 61.4, wallSeconds: 70, workingSeconds: 61.4 } })).toEqual({ leadSeconds: 61 });
    expect(compact({ lead: { seconds: null, wallSeconds: null, workingSeconds: null } })).toEqual({ leadSeconds: null });
  });

  it("cuts long lists and says how many were left out", () => {
    const out = compact({ rows: Array.from({ length: 50 }, (_, i) => i) }, 10) as { rows: number[]; rowsOmitted: number };
    expect(out.rows).toHaveLength(10);
    expect(out.rowsOmitted).toBe(40);
  });

  it("drops storage references and rounds floats", () => {
    expect(compact({ blobReference: "x", gaps: [1], value: 1.234 })).toEqual({ value: 1.2 });
  });

  it("says so when a result that is itself a list is cut", () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ n: i }));
    expect(compactResult(list, 10)).toEqual({ rows: list.slice(0, 10), rowsOmitted: 40 });
    expect(compactResult(list.slice(0, 10), 10)).toEqual(list.slice(0, 10));
  });

  it("keeps a full page (50 rows) and a year of weeks (53) whole", () => {
    expect(MAX_LIST).toBeGreaterThanOrEqual(53);
  });
});

describe("the system prompt in parts", () => {
  it("has a fixed part that is the same for every role and day", () => {
    const a = buildSystemPromptParts({ now: NOW, role: "admin" });
    const b = buildSystemPromptParts({ now: NOW + 86_400_000 * 40, role: "viewer" });
    expect(a.fixed).toBe(b.fixed);
    expect(a.current).not.toBe(b.current);
    expect(buildSystemPrompt({ now: NOW, role: "admin" })).toBe(`${a.fixed}

${a.current}`);
  });
});

describe("estimateCostUsd", () => {
  it("prices cache writes at 1.25 times the input price and cache reads at the read price", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 400_000, cacheWriteTokens: 200_000 };
    // 400k uncached at 2, 200k written at 2.5, 400k read at 0.2 (USD per million).
    expect(estimateCostUsd("claude-sonnet-5-5", tokens)).toBeCloseTo(0.8 + 0.5 + 0.08, 6);
  });
});

describe("system prompt", () => {
  it("states the date, the week and that numbers only come from tools", () => {
    const prompt = buildSystemPrompt({ now: NOW, role: "viewer" });
    expect(prompt).toContain("2026-11-16");
    expect(prompt).toContain("mandag");
    expect(prompt).toContain("Denne uge: 2026-11-16 til 2026-11-22");
    expect(prompt).toContain("Alle tal skal komme fra værktøjerne");
    expect(prompt).toContain("Max i gang");
    expect(prompt).toContain("delt tid");
    expect(prompt).toContain("ur-tid");
    expect(prompt).toContain("Læser");
    expect(prompt).not.toMatch(/[–—]/);
  });

  it("keeps the fixed part identical between users and days", () => {
    const a = buildSystemPrompt({ now: NOW, role: "admin" });
    const b = buildSystemPrompt({ now: NOW + 86_400_000 * 40, role: "viewer" });
    const fixed = (p: string) => p.slice(0, p.indexOf("## Nu"));
    expect(fixed(a)).toBe(fixed(b));
  });
});
