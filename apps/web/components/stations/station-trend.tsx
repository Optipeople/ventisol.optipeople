import { ChartState, ReportTable, SeriesChart, type ReportTableModel, type SeriesPayload } from "@optipeople/ui/reports";
import { FoldedTable } from "@/components/overview/folded-table";
import type { StationTrendPoint } from "@/lib/reports/types";
import { formatDuration, formatMinutes, formatNumber, formatSignedPercent, NO_DATA } from "@/lib/reports/format";

// Time per piece week by week against normal, on the shared SeriesChart: one
// line for the week's median and one for the week's normal. The table twin is
// folded away under it and has the count through and the standstill as well.

/** Minutes with one decimal, as the chart's unit "min" counts. */
const minutes = (seconds: number | null) => (seconds == null ? null : Math.round(seconds / 6) / 10);

export function StationTrendChart({ points }: { points: StationTrendPoint[] }) {
  if (!points.some((p) => (p.timePerPiece.seconds ?? 0) > 0 || (p.normalSeconds ?? 0) > 0)) {
    return <ChartState state="empty" minHeight={160} message={NO_DATA} />;
  }
  const hasNormal = points.some((p) => p.normalSeconds != null);

  const payload: SeriesPayload = {
    unit: "min",
    buckets: points.map((p) => ({ start: `${p.weekStart}T00:00:00Z`, isoYear: p.isoYear, isoWeek: p.isoWeek })),
    series: [
      {
        id: "median",
        label: "Tid pr. stk. (median)",
        kind: "metric",
        values: points.map((p) => minutes(p.timePerPiece.seconds)),
      },
      ...(hasNormal
        ? [{ id: "normal", label: "Normalt", kind: "metric" as const, values: points.map((p) => minutes(p.normalSeconds)) }]
        : []),
    ],
  };

  return <SeriesChart payload={payload} type="line" height={260} title="Tid pr. stk. uge for uge" />;
}

/** The chart's weeks as numbers, newest first, closed until asked for: the chart already shows them. */
export function StationTrendTable({ points }: { points: StationTrendPoint[] }) {
  const weeks = [...points].reverse();
  const model: ReportTableModel = {
    columns: ["Uge", "Gennem", "Tid pr. stk.", "Normalt", "Mod normalt", "Stod stille"],
    rows: weeks.map((p) => [
      `Uge ${p.isoWeek} ${p.isoYear}`,
      formatNumber(p.countThrough),
      formatMinutes(p.timePerPiece.seconds),
      formatMinutes(p.normalSeconds),
      formatSignedPercent(p.deviationPercent),
      p.standstillSeconds === 0 ? "Ingen" : formatDuration(p.standstillSeconds),
    ]),
    // Every cell is text with a unit, so each sorts by the number behind it.
    sortKeys: weeks.map((p) => [
      p.isoYear * 100 + p.isoWeek,
      p.countThrough,
      p.timePerPiece.seconds,
      p.normalSeconds,
      p.deviationPercent,
      p.standstillSeconds,
    ]),
  };
  return (
    <FoldedTable showLabel="Vis ugerne som tabel">
      <ReportTable model={model} title="Ugerne som tabel" />
    </FoldedTable>
  );
}
