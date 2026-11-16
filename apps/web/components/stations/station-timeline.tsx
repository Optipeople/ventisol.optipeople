import { Timeline, type TimelineBlock } from "@optipeople/ui/blocks";
import type { TimelineInterval } from "@/lib/reports/types";
import { formatDuration } from "@/lib/reports/format";
import { positionLabel } from "@/lib/scans";
import { buildStationTimeline } from "@/lib/stations-view/timeline";
import { dayEnd, dayStart, formatClock, formatLongDay } from "@/lib/time";

// One station's day as a timeline: a lane per element type, a bar per pass
// from In to Out. The drawing is Timeline from @optipeople/ui/blocks; the
// bar's title carries the details on hover. The passes table below it is
// the timeline's table twin.

export function elementLabel(iv: Pick<TimelineInterval, "position" | "subPosition" | "piece">): string {
  if (iv.position == null) return "Uden position";
  return `${positionLabel(iv.position, iv.subPosition)}${iv.piece != null ? `, stk. ${iv.piece}` : ""}`;
}

function barTitle(iv: TimelineInterval, end: number): string {
  const lines = [
    `Ordre ${iv.orderNo}, ${elementLabel(iv)} (${iv.barcode})`,
    `${iv.elementTypeName ?? "Uden type"}`,
    `${formatClock(Date.parse(iv.startAt))} til ${iv.status === "open" ? "nu" : formatClock(end)}, ${formatDuration(iv.duration.seconds)}`,
  ];
  if (iv.waitBefore.seconds != null) lines.push(`Ventede ${formatDuration(iv.waitBefore.seconds)} før stationen`);
  if (iv.isRework) lines.push(`Omarbejde (gang nr. ${iv.visit ?? 2} på stationen)`);
  if (iv.status === "open") lines.push("I gang");
  if (iv.startEstimated) lines.push("Starttid regnet ud fra varigheden");
  return lines.join("\n");
}

export function StationTimeline({
  day,
  intervals,
  now,
}: {
  day: string;
  intervals: TimelineInterval[];
  now: number;
}) {
  const data = buildStationTimeline(intervals, { dayStart: dayStart(day), dayEnd: dayEnd(day), now });
  if (!data || data.lanes.length === 0) return null;

  const passes = data.lanes.reduce((n, lane) => n + lane.bars.length, 0);
  const block: TimelineBlock = {
    id: day,
    title: formatLongDay(day),
    summary: `${formatClock(data.axisStart)} til ${formatClock(data.axisEnd)} · ${passes} ${passes === 1 ? "passage" : "passager"}`,
    axisStart: data.axisStart,
    axisEnd: data.axisEnd,
    lanes: data.lanes.map((lane) => ({
      id: lane.id,
      label: lane.label,
      total: formatDuration(lane.totalSeconds),
      bars: lane.bars.map((bar) => ({
        id: bar.interval.intervalId,
        start: bar.start,
        end: bar.end,
        tone: bar.tone,
        title: barTitle(bar.interval, bar.end),
      })),
    })),
  };

  const tones = new Set(data.lanes.flatMap((lane) => lane.bars.map((b) => b.tone)));
  const legend = [
    { tone: "default" as const, label: "Ind til ud" },
    { tone: "alert" as const, label: "Omarbejde" },
    { tone: "active" as const, label: "I gang" },
  ].filter((item) => item.tone === "default" || tones.has(item.tone));

  return (
    <Timeline
      blocks={[block]}
      legend={legend}
      hint="Hold musen over en bjælke for detaljer."
      formatTick={formatClock}
    />
  );
}
