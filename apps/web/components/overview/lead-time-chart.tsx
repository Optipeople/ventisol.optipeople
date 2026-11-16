import { CHART_BLUE, CHART_GREY, StackedColumnChart, type ColumnPoint } from "@optipeople/ui/blocks";
import { formatDuration, monthTitle, NO_DATA, weekTitle, type LeadTimePoint } from "@/lib/reports";

const SERIES = [
  { label: "Arbejde", color: CHART_BLUE },
  { label: "Ventetid", color: CHART_GREY },
];

const hours = (seconds: number | null) => (seconds == null ? 0 : seconds / 3600);

function tick(h: number): string {
  if (h === 0) return "0";
  return h >= 1 ? `${Math.round(h * 10) / 10} t`.replace(".", ",") : `${Math.round(h * 60)} min`;
}

/**
 * "Gennemløbstid pr. ordre, uge for uge": average lead time per bucket,
 * stacked as work and waiting. Values are hours on the chart, the tooltip and
 * the screen reader table say them as "11 t 20 min".
 */
export function LeadTimeChart({ points }: { points: LeadTimePoint[] }) {
  const columns: ColumnPoint[] = points.map((p) => {
    const title = p.bucket === "week" ? weekTitle(p.bucketStart) : monthTitle(p.bucketStart);
    const orders = p.ordersPacked === 1 ? "1 ordre" : `${p.ordersPacked} ordrer`;
    return {
      label: p.bucket === "week" ? `Uge ${p.label}` : p.label,
      tooltipLabel: `${title} (${orders}, i alt ${formatDuration(p.lead.seconds)})`,
      values: [hours(p.work.seconds), hours(p.wait.seconds)],
    };
  });

  return (
    <StackedColumnChart
      series={SERIES}
      points={columns}
      height={260}
      formatValue={(h) => formatDuration(Math.round(h * 3600))}
      formatTick={tick}
      tableCaption="Gennemløbstid pr. ordre, arbejde og ventetid"
      rowHeader="Periode"
      emptyLabel={`${NO_DATA}: ingen ordrer er pakket i perioden.`}
    />
  );
}
