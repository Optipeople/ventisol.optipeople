// station_timeline: the passes at one station over a day or a few days, each
// with its wall-clock time (In to Out) and its split time (its share of the
// station's time when several elements were in progress there at once, "Max
// i gang" above 1). Runs on getStationDetail, the report function over
// rpt.station_timeline, one day at a time, so the clock setting and the role
// rules of the report layer hold. Not in REPORT_QUERIES: the drill-down
// report is larger than the chat needs, so the tool keeps only the passes.

import { z } from "zod";
import { can } from "@/lib/portal/roles";
import {
  formatDayTime,
  formatDuration,
  getStationDetail,
  listStations,
  ReportAccessError,
  type Clock,
  type TimelineInterval,
} from "@/lib/reports";
import { stationHref } from "@/lib/stations-view/params";
import { addDays, dayKey, daysBetween } from "@/lib/time";
import { compact } from "./compact";
import type { ChatTool, ToolContext, ToolResult, ToolView } from "./types";

/** Longest range in days: a week of passes is already more than the model needs. */
export const TIMELINE_MAX_DAYS = 7;

/** Passes the model sees; the rest are counted. */
export const TIMELINE_MAX_ROWS = 40;

const DAY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Dag som yyyy-MM-dd (dansk tid).");

export const stationTimelineSchema = z.object({
  stationNo: z.number().int().min(0).describe("Stationsnummeret (se værktøjet stations)."),
  from: DAY.describe("Første dag som yyyy-MM-dd (dansk tid)."),
  to: DAY.optional().describe(`Sidste dag, med. Udelad for én dag. Højst ${TIMELINE_MAX_DAYS} dage i alt.`),
  clock: z
    .enum(["working", "wall"])
    .optional()
    .describe("Ur: 'working' tæller kun tid i skift, 'wall' er almindelig tid. Udelad for portalens indstilling."),
});

export type StationTimelineInput = z.output<typeof stationTimelineSchema>;

/** One pass as the model reads it. */
export interface TimelinePass {
  orderNo: number;
  position: number | null;
  subPosition: number | null;
  piece: number | null;
  elementType: string | null;
  /** done, open (still in progress) or missing_out (never scanned Out). */
  status: TimelineInterval["status"];
  isRework: boolean;
  /** The station stopped it at shift end: `end` is the shift end, not a scan-out. */
  autoStopped: boolean;
  /** Copenhagen time, "21.10 kl. 07:00". */
  start: string;
  end: string | null;
  /** Wall clock In to Out on the headline clock: not labour when several were in progress at once. */
  durationSeconds: number | null;
  /** Split time: the pass's share of the station's time. Equal to durationSeconds when it was alone. */
  splitSeconds: number | null;
  /** Other passes at the station that overlapped this one. */
  overlapping: number;
}

export interface StationTimeline {
  stationNo: number;
  name: string;
  /** "Max i gang": elements that may be in progress at the station at once. */
  maxOpen: number;
  /** maxOpen above 1: time per piece at this station is split time. */
  parallel: boolean;
  clock: Clock;
  period: { from: string; to: string };
  /** Days asked for beyond TIMELINE_MAX_DAYS, left out. */
  daysOmitted?: number;
  passes: number;
  /** Most passes in progress at the same moment. */
  maxConcurrent: number;
  /** Passes whose split time is below their wall-clock time. */
  passesSplit: number;
  rows: TimelinePass[];
}

/** A pass's end for overlap: now while open, none on a missing scan-out. */
function endMs(t: TimelineInterval, now: number): number | null {
  if (t.status === "missing_out") return null;
  return t.endAt ? Date.parse(t.endAt) : now;
}

/** Overlap per pass and the most passes at once, from start and end only. */
export function overlaps(passes: TimelineInterval[], now: number): { perPass: number[]; maxConcurrent: number } {
  const spans = passes.map((t) => {
    const end = endMs(t, now);
    return end == null ? null : { start: Date.parse(t.startAt), end };
  });
  const perPass = spans.map((a, i) =>
    a == null ? 0 : spans.filter((b, j) => j !== i && b != null && b.start < a.end && a.start < b.end).length
  );
  const events = spans
    .filter((s) => s != null)
    .flatMap((s) => [
      { at: s.start, d: 1 },
      { at: s.end, d: -1 },
    ])
    // An end before a start at the same instant: back to back is not at once.
    .sort((a, b) => a.at - b.at || a.d - b.d);
  let open = 0;
  let maxConcurrent = 0;
  for (const e of events) {
    open += e.d;
    maxConcurrent = Math.max(maxConcurrent, open);
  }
  return { perPass, maxConcurrent };
}

/** The timeline of one station for the days asked, as compact data and a table view. */
export async function stationTimeline(ctx: ToolContext, input: StationTimelineInput): Promise<ToolResult> {
  if (!can(ctx.claims.role, "reports.view")) throw new ReportAccessError();
  const from = input.from;
  const asked = input.to && input.to >= from ? input.to : from;
  const askedDays = daysBetween(from, asked) + 1;
  const to = askedDays > TIMELINE_MAX_DAYS ? addDays(from, TIMELINE_MAX_DAYS - 1) : asked;
  const days = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));

  const [details, stations] = await Promise.all([
    Promise.all(
      days.map((day) =>
        getStationDetail(ctx.claims, { stationNo: input.stationNo, day, weeks: 1, clock: input.clock })
      )
    ),
    listStations(ctx.claims),
  ]);

  // A pass across midnight is on both days' timelines: keep it once.
  const seen = new Set<string>();
  const passes: TimelineInterval[] = [];
  for (const d of details) {
    for (const t of d.timeline) {
      if (seen.has(t.intervalId)) continue;
      seen.add(t.intervalId);
      passes.push(t);
    }
  }
  passes.sort((a, b) => a.startAt.localeCompare(b.startAt));

  const info = stations.find((s) => s.stationNo === input.stationNo);
  const maxOpen = info?.maxOpen ?? 1;
  const name = info?.name ?? details[0]?.station.name ?? `Station nr. ${input.stationNo}`;
  const { perPass, maxConcurrent } = overlaps(passes, ctx.now);

  const rows: TimelinePass[] = passes.map((t, i) => ({
    orderNo: t.orderNo,
    position: t.position,
    subPosition: t.subPosition,
    piece: t.piece,
    elementType: t.elementTypeName ?? t.elementTypeId,
    status: t.status,
    isRework: t.isRework,
    autoStopped: t.autoStopped,
    start: formatDayTime(t.startAt),
    end: t.endAt ? formatDayTime(t.endAt) : null,
    durationSeconds: t.duration.seconds == null ? null : Math.round(t.duration.seconds),
    splitSeconds: t.split.seconds == null ? null : Math.round(t.split.seconds),
    overlapping: perPass[i] ?? 0,
  }));

  const result: StationTimeline = {
    stationNo: input.stationNo,
    name,
    maxOpen,
    parallel: maxOpen > 1,
    clock: details[0]?.clock ?? "wall",
    period: { from, to },
    ...(askedDays > days.length ? { daysOmitted: askedDays - days.length } : {}),
    passes: rows.length,
    maxConcurrent,
    passesSplit: rows.filter((r) => r.splitSeconds != null && r.durationSeconds != null && r.splitSeconds < r.durationSeconds)
      .length,
    rows,
  };

  return {
    data: compact(result, TIMELINE_MAX_ROWS),
    views: timelineViews(result),
    href: stationHref(input.stationNo, { day: from, today: dayKey(ctx.now), clock: input.clock }),
  };
}

const STATUS_LABELS: Record<TimelineInterval["status"], string> = {
  done: "",
  open: "I gang",
  missing_out: "Mangler ud-scanning",
};

function elementLabel(r: TimelinePass): string {
  const parts = [r.position, r.subPosition, r.piece].filter((n) => n != null);
  return parts.length > 0 ? `${r.orderNo}-${parts.join("-")}` : String(r.orderNo);
}

function timelineViews(t: StationTimeline): ToolView[] {
  const title = t.period.from === t.period.to ? `${t.name} ${t.period.from}` : `${t.name} ${t.period.from} til ${t.period.to}`;
  const views: ToolView[] = [];
  if (t.parallel) {
    views.push({
      kind: "note",
      text: `${t.name} har Max i gang ${t.maxOpen}: op til ${t.maxOpen} elementer ad gangen. Delt tid er hver passages andel af stationens tid; Tid er fra ind til ud.`,
    });
  }
  views.push({
    kind: "table",
    title,
    columns: [
      { key: "start", label: "Ind" },
      { key: "end", label: "Ud" },
      { key: "element", label: "Element" },
      { key: "type", label: "Type" },
      { key: "time", label: "Tid", align: "right" },
      { key: "split", label: "Delt tid", align: "right" },
    ],
    rows: t.rows.slice(0, 12).map((r) => ({
      start: r.start,
      end: r.end ? (r.autoStopped ? `${r.end} (vagtskifte)` : r.end) : STATUS_LABELS[r.status],
      element: elementLabel(r),
      type: r.elementType ?? "",
      time: formatDuration(r.durationSeconds),
      split: formatDuration(r.splitSeconds),
    })),
    total: t.rows.length,
  });
  return views;
}

export const stationTimelineTool: ChatTool<typeof stationTimelineSchema> = {
  name: "station_timeline",
  description:
    "Passagerne på én station en dag (eller op til 7 dage): ind, ud, ordre og element, tid fra ind til ud (durationSeconds, ur-tid) og delt tid (splitSeconds), og hvor mange andre passager der lå på stationen samtidig. Ved en station med Max i gang over 1 (parallel true) deles stationens tid mellem de elementer der er i gang samtidig; tid pr. stk. i de andre værktøjer er den delte tid. Brug den til 'hvad lå på stationen samtidig' og 'hvorfor er tiden delt'.",
  inputSchema: stationTimelineSchema,
  run: stationTimeline,
};
