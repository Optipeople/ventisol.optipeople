import { Timeline as TimelineBlocks, type TimelineBlock } from "@optipeople/ui/blocks";
import { stationKey, type TimelineDay, type WorkInterval } from "@/lib/report";
import { positionLabel } from "@/lib/scans";
import { dayKey, formatClock, formatDuration, formatLongDay, formatScanTime } from "@/lib/time";

// The order as a timeline: one block per day it was worked, one lane per
// station, a bar per pass from In to Out. The drawing is Timeline from
// @optipeople/ui/blocks; this file only turns the report's days into its
// blocks. The bar's title carries the details on hover.

function barTitle(iv: WorkInterval): string {
  const lines = [
    `${positionLabel(iv.position, iv.subPosition)}, stk. ${iv.piece ?? "-"} (${iv.barcode})`,
    // A pass that began on an earlier day says which.
    `${iv.station}: ${formatScanTime(iv.start, dayKey(iv.end))} til ${iv.inProgress ? "nu" : formatClock(iv.end)}, ${formatDuration(iv.durationMs)}`,
  ];
  if (iv.visit > 1) lines.push(`Omarbejde (gang nr. ${iv.visit} på stationen)`);
  if (iv.inProgress) lines.push("I gang");
  if (iv.startEstimated) lines.push("Starttid regnet ud fra varigheden");
  return lines.join("\n");
}

function toBlock(day: TimelineDay): TimelineBlock {
  const bars = day.lanes.flatMap((lane) => lane.bars);
  const first = bars.reduce((m, b) => Math.min(m, b.start), Infinity);
  const last = bars.reduce((m, b) => Math.max(m, b.end), 0);
  return {
    id: day.day,
    title: formatLongDay(day.day),
    summary: (
      <>
        {formatScanTime(first, day.day)}
        {" til "}
        {formatClock(last)}
        {" · "}
        <span className="font-bold text-[var(--ds-grey-dark-09)]">{formatDuration(day.totalMs)}</span>
      </>
    ),
    axisStart: day.axisStart,
    axisEnd: day.axisEnd,
    lanes: day.lanes.map((lane) => ({
      id: stationKey(lane),
      label: lane.station,
      total: formatDuration(lane.totalMs),
      bars: lane.bars.map((iv) => ({
        id: `${iv.barcode}-${iv.start}`,
        start: iv.start,
        end: iv.end,
        tone: iv.inProgress ? "active" : iv.visit > 1 ? "alert" : "default",
        title: barTitle(iv),
      })),
    })),
  };
}

export function Timeline({ days }: { days: TimelineDay[] }) {
  return (
    <TimelineBlocks
      blocks={days.map(toBlock)}
      legend={[
        { tone: "default", label: "Ind til ud" },
        { tone: "alert", label: "Omarbejde" },
        { tone: "active", label: "I gang" },
      ]}
      hint="Hold musen over en bjælke for detaljer."
      formatTick={formatClock}
    />
  );
}
