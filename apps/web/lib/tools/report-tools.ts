// One chat tool per report query in lib/reports (REPORT_QUERIES). Each tool
// has its own input schema for the model (Danish descriptions, no `now`, no
// refinements, so it converts to plain JSON schema) and runs through
// runReportQuery, which checks the capability and validates the real
// parameters. So the role rules of the report layer hold in the chat too.
//
// A tool that returns stations also says each station's "Max i gang"
// (maxOpen, from listStations): where it is above 1, time per piece is split
// time, and the model has to know that to explain the figures.

import { z } from "zod";
import {
  formatDayTime,
  formatDuration,
  formatForecast,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSignedPercent,
  listStations,
  monthTitle,
  NO_DATA,
  runReportQuery,
  type Bottleneck,
  type CalcVsMeasured,
  type CapacityPlan,
  type FinishedOrderRow,
  type FoundOrder,
  type InProgressOrderRow,
  type IncompletePackedOrder,
  type KpiSummary,
  type LeadTimePoint,
  type MissingScanOut,
  type OrderRoute,
  type OrderStatusSummary,
  type Paged,
  type PeriodKpis,
  type ReportQueryName,
  type StaffingAnalysis,
  type StationDayReport,
  type StationInfo,
  type StationPeriodReport,
  type StationRow,
  type TodayStrip,
  type BaselineSuggestion,
} from "@/lib/reports";
import { compactResult } from "./compact";
import type { ChatTool, ToolResult, ToolView, ViewColumn } from "./types";

// ---------------------------------------------------------------------------
// Input pieces for the model
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (what: string) => z.string().regex(DAY_RE).describe(`${what} som yyyy-MM-dd (dansk tid).`);

const period = {
  from: day("Første dag i perioden"),
  to: day("Sidste dag i perioden, med"),
  clock: z
    .enum(["working", "wall"])
    .optional()
    .describe("Ur: 'working' tæller kun tid i skift, 'wall' er almindelig tid. Udelad for portalens indstilling."),
};

const orderNo = z.number().int().min(1).describe("Ordrenummeret, fx 1042.");
const stationNo = z.number().int().min(0).describe("Stationsnummeret (se værktøjet stations).");
const page = z.number().int().min(1).optional().describe("Side, fra 1.");
const pageSize = z.number().int().min(1).max(50).optional().describe("Rækker pr. side, højst 50. Standard 20.");
const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe("Måned som yyyy-MM.");

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/** The first rows of a table: the screen gets a short table, the page has the rest. */
const VIEW_ROWS = 12;

function table(title: string, columns: ViewColumn[], rows: Record<string, string>[], total?: number): ToolView {
  return {
    kind: "table",
    title,
    columns,
    rows: rows.slice(0, VIEW_ROWS),
    total: total ?? rows.length,
  };
}

const text = (v: string | number | null | undefined): string => (v == null || v === "" ? "" : String(v));
const deliveryWeek = (week: number | null): string => (week == null ? NO_DATA : `uge ${week}`);

function kpiViews(k: PeriodKpis): ToolView {
  return {
    kind: "kpis",
    title: `${k.period.from} til ${k.period.to}`,
    items: [
      {
        label: "Gennemløbstid pr. ordre",
        value: formatDuration(k.current.lead.seconds),
        note: `${formatSignedPercent(k.change.leadPercent)} mod forrige periode`,
      },
      {
        label: "Leveret til tiden",
        value: formatPercent(k.current.onTimePercent),
        note: `${formatPoints(k.change.onTimePoints)} mod forrige periode`,
      },
      {
        label: "Ventetid pr. ordre",
        value: formatDuration(k.current.wait.seconds),
        note: `${formatSignedPercent(k.change.waitPercent)} mod forrige periode`,
      },
      { label: "Pakkede ordrer", value: formatNumber(k.current.ordersPacked) },
    ],
  };
}

/**
 * Lead time per order over time as a line, in hours with one decimal. A
 * bucket with no packed orders has no value, so the line breaks there.
 */
function leadTimeLine(title: string, points: LeadTimePoint[]): ToolView {
  return {
    kind: "line",
    title,
    unit: "h",
    points: points.map((p) => {
      const seconds = p.lead.seconds;
      const week = p.bucket === "week";
      return {
        label: week ? `Uge ${p.label}` : `${p.label} ${p.bucketStart.slice(0, 4)}`,
        value: seconds == null ? null : Math.round(seconds / 360) / 10,
        display: formatDuration(seconds),
        start: p.bucketStart,
        ...(week ? { isoYear: p.isoYear, isoWeek: p.isoWeek } : {}),
      };
    }),
  };
}

function bottleneckViews(b: Bottleneck): ToolView[] {
  return [
    { kind: "note", text: b.sentence },
    {
      kind: "bars",
      title: "Ventetid pr. ordre, trin for trin",
      items: b.steps
        .filter((s) => s.wait.seconds != null && s.source !== "none")
        .map((s) => ({ label: s.label, value: s.wait.seconds ?? 0, display: formatDuration(s.wait.seconds) })),
    },
  ];
}

/** Said in every station tool: what time per piece is where several elements are in progress at once. */
const SPLIT_NOTE =
  "Hver station har maxOpen (Max i gang). Over 1 arbejder én person på flere elementer ad gangen: der er tid pr. stk. og mod normalt delt tid (hvert elements andel af stationens tid), mens udnyttelse, stilstand og ventetid er ur-tid. Se station_timeline for passagerne.";

const stationColumns: ViewColumn[] = [
  { key: "name", label: "Station" },
  { key: "count", label: "Gennem", align: "right" },
  { key: "time", label: "Tid pr. stk.", align: "right" },
  { key: "normal", label: "Mod normalt", align: "right" },
  { key: "standstill", label: "Stod stille", align: "right" },
  { key: "status", label: "Status" },
];

function stationRows(rows: StationRow[]): Record<string, string>[] {
  return rows.map((r) => ({
    name: r.name,
    count: formatNumber(r.countThrough),
    time: formatMinutes(r.timePerPiece.seconds),
    normal: formatSignedPercent(r.deviationPercent),
    standstill: r.standstillSeconds === 0 ? "Ingen" : formatDuration(r.standstillSeconds),
    status: r.statusLabel,
  }));
}

const orderColumns: ViewColumn[] = [
  { key: "order", label: "Ordre" },
  { key: "customer", label: "Kunde" },
  { key: "where", label: "Er nu ved" },
  { key: "elapsed", label: "Tid indtil nu", align: "right" },
  { key: "forecast", label: "Forventet klar" },
  { key: "status", label: "Status" },
];

function inProgressRows(rows: InProgressOrderRow[]): Record<string, string>[] {
  return rows.map((r) => ({
    order: String(r.orderNo),
    customer: text(r.customer),
    where: r.currentLabel,
    elapsed: formatDuration(r.elapsed.seconds),
    forecast: formatForecast(r.forecastReadyAt),
    status: r.statusLabel,
  }));
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

interface ReportToolDef<S extends z.ZodObject> {
  description: string;
  inputSchema: S;
  views?: (result: unknown, input: z.output<S>) => ToolView[];
  href?: (input: z.output<S>) => string;
  /** The result has stations (objects with a stationNo): give each its maxOpen. */
  stations?: boolean;
}

/** `def<ResultType>()({ ... })`: the result type is named, the input type is inferred from the schema. */
const def =
  <R>() =>
  <S extends z.ZodObject>(d: {
    description: string;
    inputSchema: S;
    views?: (result: R, input: z.output<S>) => ToolView[];
    href?: (input: z.output<S>) => string;
    stations?: boolean;
  }): ReportToolDef<z.ZodObject> =>
    d as unknown as ReportToolDef<z.ZodObject>;

/** Every report query as a tool. A Record, so a new query in lib/reports fails the typecheck here until it has a tool. */
export const REPORT_TOOL_DEFS: Record<ReportQueryName, ReportToolDef<z.ZodObject>> = {
  find_order: def<FoundOrder[]>()({
    description:
      "Find ordrer ud fra ordrenummer (helt eller begyndelsen), kundenavn eller sagsnavn. Brug den når brugeren nævner en kunde eller en sag, eller når et ordrenummer ikke findes direkte.",
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Ordrenummer, kunde eller sagsnavn."),
      limit: z.number().int().min(1).max(20).optional().describe("Højst så mange hits. Standard 10."),
    }),
    views: (rows) => [
      table(
        "Fundne ordrer",
        [
          { key: "order", label: "Ordre" },
          { key: "customer", label: "Kunde" },
          { key: "case", label: "Sag" },
          { key: "status", label: "Status" },
          { key: "week", label: "Lev. uge" },
        ],
        rows.map((r) => ({
          order: String(r.orderNo),
          customer: text(r.customer),
          case: text(r.caseName),
          status: r.status === "packed" ? "Pakket" : "I gang",
          week: deliveryWeek(r.deliveryWeek),
        }))
      ),
    ],
    href: () => "/ordrer",
  }),

  order_status: def<OrderStatusSummary | null>()({
    description:
      "Status for én ordre: hvor den er nu, hvilke trin der er færdige, leveringsuge, leveringsstatus og forventet klar-tidspunkt (forecast). Brug den til 'hvor er ordre X' og 'hvornår er den klar'.",
    inputSchema: z.object({ orderNo }),
    views: (s) =>
      s == null
        ? [{ kind: "note", text: "Ordren findes ikke i data." }]
        : [
            {
              kind: "kpis",
              title: `Ordre ${s.orderNo}${s.customer ? `, ${s.customer}` : ""}`,
              items: [
                { label: "Er nu ved", value: s.currentLabel },
                {
                  label: "Forventet klar",
                  value: s.status === "packed" ? `Pakket ${formatDayTime(s.packedAt)}` : formatForecast(s.forecastReadyAt),
                },
                { label: "Leveringsuge", value: deliveryWeek(s.deliveryWeek), note: s.deliveryStatusLabel },
                {
                  label: "Elementer pakket",
                  value: `${formatNumber(s.elementsPacked)} af ${formatNumber(s.elements)}`,
                },
              ],
            },
          ],
    href: (i) => `/ordre/${i.orderNo}`,
  }),

  order_route: def<OrderRoute | null>()({
    description:
      "En ordres rute: de syv trin med tid, arbejde og ventetid, samt afvigelser (omarbejde, lange ventetider, manglende scanninger). Brug den til 'hvorfor tog ordren så lang tid' og 'hvor ventede den'.",
    inputSchema: z.object({ orderNo }),
    views: (r) =>
      r == null
        ? [{ kind: "note", text: "Ordren findes ikke i data." }]
        : [
            {
              kind: "bars",
              title: `Ordre ${r.orderNo}: tid pr. trin`,
              items: r.steps
                .filter((s) => s.duration.seconds != null)
                .map((s) => ({ label: s.label, value: s.duration.seconds ?? 0, display: formatDuration(s.duration.seconds) })),
            },
            ...(r.notes.length > 0
              ? [table(r.notesHeadline, [{ key: "note", label: "Afvigelse" }], r.notes.map((n) => ({ note: n.text })))]
              : []),
          ],
    href: (i) => `/ordre/${i.orderNo}`,
  }),

  finished_orders: def<Paged<FinishedOrderRow>>()({
    description:
      "Pakkede (afsluttede) ordrer i en periode med gennemløbstid, ventetid og om de blev leveret til tiden. Kan søges, filtreres på status og sorteres.",
    inputSchema: z.object({
      search: z.string().max(200).optional().describe("Begyndelsen af et ordrenummer eller en del af kunde- eller sagsnavn."),
      from: day("Første pakkedag").optional(),
      to: day("Sidste pakkedag").optional(),
      status: z.enum(["on_time", "late", "unknown"]).optional().describe("on_time, late eller unknown (ingen leveringsuge)."),
      sort: z.enum(["order", "customer", "elements", "start", "packed", "lead", "wait", "status"]).optional(),
      dir: z.enum(["asc", "desc"]).optional(),
      page,
      pageSize,
      clock: period.clock,
    }),
    views: (p) => [
      table(
        "Afsluttede ordrer",
        [
          { key: "order", label: "Ordre" },
          { key: "customer", label: "Kunde" },
          { key: "packed", label: "Pakket" },
          { key: "lead", label: "Gennemløbstid", align: "right" },
          { key: "wait", label: "Ventetid", align: "right" },
          { key: "status", label: "Status" },
        ],
        p.rows.map((r) => ({
          order: String(r.orderNo),
          customer: text(r.customer),
          packed: formatDayTime(r.packedAt),
          lead: formatDuration(r.lead.seconds),
          wait: formatDuration(r.wait.seconds),
          status: r.statusLabel,
        })),
        p.total
      ),
    ],
    href: () => "/ordrer",
  }),

  orders_in_progress: def<Paged<InProgressOrderRow>>()({
    description:
      "Ordrer i gang lige nu: hvor de er, tid indtil nu, forventet klar og leveringsstatus (til tiden, risiko for forsinkelse, forsinket). Filtrér på status for at finde ordrer i risiko.",
    inputSchema: z.object({
      search: z.string().max(200).optional().describe("Begyndelsen af et ordrenummer eller en del af kunde- eller sagsnavn."),
      status: z.enum(["late", "at_risk", "on_time", "unknown"]).optional(),
      sort: z.enum(["order", "customer", "elements", "start", "elapsed", "forecast", "due", "last_scan"]).optional(),
      dir: z.enum(["asc", "desc"]).optional(),
      activeDays: z.number().int().min(1).max(365).optional().describe("Kun ordrer scannet inden for så mange dage."),
      page,
      pageSize,
      clock: period.clock,
    }),
    views: (p) => [table("Ordrer i gang", orderColumns, inProgressRows(p.rows), p.total)],
    href: () => "/ordrer",
  }),

  bottleneck: def<Bottleneck>()({
    description:
      "Flaskehalsen i en periode: hvor ordrerne venter mest, med ventetid og tid pr. trin for alle syv trin og ventetid foran hver station (med stationens maxOpen, Max i gang). Ventetid er ur-tid. Brug den til 'hvor venter ordrerne mest'.",
    inputSchema: z.object(period),
    views: (b) => bottleneckViews(b),
    stations: true,
    href: () => "/",
  }),

  period_kpis: def<PeriodKpis>()({
    description:
      "Nøgletal for en periode mod perioden før: gennemløbstid pr. ordre, leveret til tiden, ventetid pr. ordre og antal pakkede ordrer.",
    inputSchema: z.object(period),
    views: (k) => [kpiViews(k)],
    href: () => "/periode",
  }),

  lead_time_series: def<LeadTimePoint[]>()({
    description: "Gennemløbstid pr. ordre uge for uge eller måned for måned over en periode, delt i arbejde og ventetid.",
    inputSchema: z.object({
      ...period,
      bucket: z.enum(["week", "month"]).optional().describe("week (standard) eller month."),
    }),
    views: (points) => [leadTimeLine("Gennemløbstid pr. ordre", points)],
    href: () => "/periode",
  }),

  kpi_summary: def<KpiSummary>()({
    description:
      "Overblikket i ét svar: nøgletal mod forrige periode, flaskehalsen, dagens tal, stationer der skal kigges på og ordrer i risiko. Det bedste første værktøj til 'hvad skal ledelsen vide' og 'hvordan går det'.",
    inputSchema: z.object(period),
    views: (s) => [
      kpiViews(s.kpis),
      { kind: "note", text: `${s.bottleneck.sentence} ${s.stationsToday.sentence}.` },
      ...(s.ordersToWatch.length > 0
        ? [table("Ordrer at holde øje med", orderColumns, inProgressRows(s.ordersToWatch), s.ordersToWatchTotal)]
        : []),
    ],
    href: () => "/",
  }),

  today: def<TodayStrip>()({
    description: "Dagens tal lige nu: ordrer i gang, i risiko, pakket i dag, elementer gennem i dag og stationer i gang.",
    inputSchema: z.object({}),
    views: (t) => [
      {
        kind: "kpis",
        title: `I dag, ${t.day}`,
        items: [
          { label: "Ordrer i gang", value: formatNumber(t.ordersInProgress) },
          { label: "I risiko", value: formatNumber(t.ordersAtRisk) },
          { label: "Pakket i dag", value: formatNumber(t.ordersPackedToday) },
          { label: "Stationer i gang", value: `${formatNumber(t.stationsRunning)} af ${formatNumber(t.stationsTotal)}` },
        ],
      },
    ],
    href: () => "/",
  }),

  stations: def<StationInfo[]>()({
    description: "Listen over stationer med nummer, navn, type, normaltider pr. elementtype og maxOpen (Max i gang: hvor mange elementer der må være i gang på stationen på én gang; over 1 betyder at stationens tid deles mellem dem). Brug den til at finde et stationsnummer.",
    inputSchema: z.object({}),
    views: (rows) => [
      table(
        "Stationer",
        [
          { key: "no", label: "Nr." },
          { key: "name", label: "Navn" },
          { key: "kind", label: "Type" },
          { key: "maxOpen", label: "Max i gang", align: "right" },
        ],
        rows.map((r) => ({ no: String(r.stationNo), name: r.name, kind: r.kindLabel, maxOpen: formatNumber(r.maxOpen) }))
      ),
    ],
    href: () => "/stationer",
  }),

  station_day: def<StationDayReport>()({
    description: `Alle stationer på én dag: antal gennem, tid pr. stk., mod normalt, stilstand, udnyttelse og status. ${SPLIT_NOTE}`,
    inputSchema: z.object({ day: day("Dagen"), clock: period.clock }),
    views: (r) => [table(`Stationer ${r.day}`, stationColumns, stationRows(r.rows))],
    stations: true,
    href: () => "/stationer",
  }),

  station_performance: def<StationPeriodReport>()({
    description:
      `Stationernes ydelse over en periode, alle eller én: antal gennem, tid pr. stk. (median), mod normaltid, stilstand, udnyttelse, ventetid foran og status. ${SPLIT_NOTE}`,
    inputSchema: z.object({ ...period, stationNo: stationNo.optional() }),
    views: (r) => [table(`Stationer ${r.period.from} til ${r.period.to}`, stationColumns, stationRows(r.rows))],
    stations: true,
    href: () => "/stationer",
  }),

  calc_vs_measured: def<CalcVsMeasured>()({
    description:
      "Kalkule mod målt: den kalkulerede tid mod den målte tid pr. elementtype og station, med afvigelse i procent. Den målte tid er delt tid ved stationer med maxOpen over 1 (hvert elements andel af stationens tid). Brug den til 'holder kalkulen'.",
    inputSchema: z.object({
      ...period,
      elementTypeId: z.string().min(1).max(100).optional().describe("Kun denne elementtype (id)."),
      stationNo: stationNo.optional(),
    }),
    views: (c) => [
      table(
        "Kalkule mod målt pr. elementtype",
        [
          { key: "type", label: "Elementtype" },
          { key: "calc", label: "Kalkule", align: "right" },
          { key: "measured", label: "Målt", align: "right" },
          { key: "dev", label: "Afvigelse", align: "right" },
        ],
        c.byElementType.map((t) => ({
          type: t.elementTypeName,
          calc: formatMinutes(t.calculatedSeconds),
          measured: formatMinutes(t.measuredSeconds),
          dev: formatSignedPercent(t.deviationPercent),
        }))
      ),
    ],
    href: () => "/ledelse",
    stations: true,
  }),

  management_kpis: def<PeriodKpis>()({
    description: "Ledelsens nøgletal for en kalendermåned mod måneden før: gennemløbstid, leveret til tiden og ventetid.",
    inputSchema: z.object({ month, clock: period.clock }),
    views: (k, i) => [{ ...(kpiViews(k) as Extract<ToolView, { kind: "kpis" }>), title: monthTitle(`${i.month}-01`) }],
    href: () => "/ledelse",
  }),

  monthly_lead_time: def<LeadTimePoint[]>()({
    description: "Gennemløbstid pr. ordre måned for måned, slutter med den valgte måned.",
    inputSchema: z.object({
      month,
      months: z.number().int().min(1).max(36).optional().describe("Antal måneder, standard 12."),
      clock: period.clock,
    }),
    views: (points) => [leadTimeLine("Gennemløbstid pr. ordre, måned for måned", points)],
    href: () => "/ledelse",
  }),

  missing_scan_outs: def<Paged<MissingScanOut>>()({
    description: "Elementer scannet ind på en station og aldrig scannet ud, nyeste først.",
    inputSchema: z.object({ from: day("Første dag").optional(), to: day("Sidste dag").optional(), page, pageSize }),
    views: (p) => [
      table(
        "Manglende ud-scanninger",
        [
          { key: "order", label: "Ordre" },
          { key: "station", label: "Station" },
          { key: "at", label: "Scannet ind" },
          { key: "reason", label: "Årsag" },
        ],
        p.rows.map((r) => ({
          order: String(r.orderNo),
          station: r.stationName,
          at: formatDayTime(r.startAt),
          reason: r.reasonLabel,
        })),
        p.total
      ),
    ],
    href: () => "/",
  }),

  incomplete_packed_orders: def<Paged<IncompletePackedOrder>>()({
    description: "Ordrer hvor noget er pakket, men elementer stadig mangler.",
    inputSchema: z.object({
      quietHours: z.number().int().min(0).max(8760).optional().describe("Timer uden scanning før ordren tæller. Standard 12."),
      page,
      pageSize,
    }),
    views: (p) => [
      table(
        "Pakkede ordrer med manglende elementer",
        [
          { key: "order", label: "Ordre" },
          { key: "customer", label: "Kunde" },
          { key: "packed", label: "Pakket", align: "right" },
          { key: "expected", label: "Forventet", align: "right" },
        ],
        p.rows.map((r) => ({
          order: String(r.orderNo),
          customer: text(r.customer),
          packed: formatNumber(r.elementsPacked),
          expected: formatNumber(r.elementsExpected),
        })),
        p.total
      ),
    ],
    href: () => "/",
  }),

  baseline_suggestion: def<BaselineSuggestion>()({
    description:
      "Forslag til normaltider: den målte median pr. station og elementtype over en periode, mod den normaltid der gælder nu. Den målte tid er delt tid ved stationer med maxOpen over 1.",
    inputSchema: z.object({
      ...period,
      minSamples: z.number().int().min(1).max(100000).optional().describe("Mindst så mange målinger. Standard 5."),
    }),
    views: (b) => [
      table(
        "Forslag til normaltider",
        [
          { key: "station", label: "Station" },
          { key: "type", label: "Elementtype" },
          { key: "suggested", label: "Forslag", align: "right" },
          { key: "current", label: "Nu", align: "right" },
        ],
        b.rows.map((r) => ({
          station: r.stationName,
          type: text(r.elementTypeName) || "Uden type",
          suggested: formatMinutes(r.suggestedSeconds),
          current: formatMinutes(r.currentSeconds),
        }))
      ),
    ],
    href: () => "/indstillinger/tider",
    stations: true,
  }),

  capacity_plan: def<CapacityPlan>()({
    description:
      "Kapacitetsplan for en uge: planlagt belastning mod kapacitet pr. dag. Der er endnu ingen planlagte ordrer fra 3E, så svaret er available false med kalenderen og ordrer med leveringsuge i ugen. Brug den til 'passer næste uges batches ind'.",
    inputSchema: z.object({ day: day("En vilkårlig dag i ugen") }),
    views: (c) => [
      { kind: "note", text: c.message },
      table(
        `Uge ${c.isoWeek}: kalenderen`,
        [
          { key: "day", label: "Dag" },
          { key: "shift", label: "Skifttid", align: "right" },
          { key: "closed", label: "Lukket" },
        ],
        c.days.map((d) => ({ day: d.day, shift: formatDuration(d.shiftSeconds), closed: d.closed ? text(d.closedName) || "Ja" : "" }))
      ),
    ],
  }),

  staffing_analysis: def<StaffingAnalysis>()({
    description:
      "Bemanding mod output pr. station. Der er endnu ingen bemandingsdata, så svaret er available false med output pr. station pr. dag. Brug den til 'hvor mange skal stå ved montagen'.",
    inputSchema: z.object({ ...period, stationNo: stationNo.optional() }),
    views: (s) => [{ kind: "note", text: s.message }],
  }),
};

/** The report tools as ChatTools. Running one goes through runReportQuery, never around it. */
export function reportTool(name: ReportQueryName): ChatTool {
  const d = REPORT_TOOL_DEFS[name];
  return {
    name,
    description: d.description,
    inputSchema: d.inputSchema,
    async run(ctx, input): Promise<ToolResult> {
      const params = { ...(input as object), now: ctx.now };
      const [result, maxOpen] = await Promise.all([
        runReportQuery(ctx.claims, name, params),
        d.stations ? maxOpenByStation(ctx.claims) : null,
      ]);
      const views = d.views?.(result, input as Record<string, unknown>) ?? [];
      const data = compactResult(result);
      return {
        data: maxOpen ? withMaxOpen(data, maxOpen) : data,
        views,
        href: d.href?.(input as Record<string, unknown>),
      };
    },
  };
}

/** "Max i gang" by station number. Empty when the list cannot be read: the figures still come back. */
async function maxOpenByStation(claims: Parameters<typeof listStations>[0]): Promise<Map<number, number>> {
  try {
    return new Map((await listStations(claims)).map((s) => [s.stationNo, s.maxOpen]));
  } catch {
    return new Map();
  }
}

/**
 * Compact data with `maxOpen` beside every `stationNo` (1 for a station not
 * in the list: one at a time). An object that already has one keeps it.
 */
export function withMaxOpen(value: unknown, maxOpen: ReadonlyMap<number, number>): unknown {
  if (Array.isArray(value)) return value.map((v) => withMaxOpen(v, maxOpen));
  if (value == null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = withMaxOpen(v, maxOpen);
    if (key === "stationNo" && typeof v === "number" && !("maxOpen" in value)) out.maxOpen = maxOpen.get(v) ?? 1;
  }
  return out;
}
