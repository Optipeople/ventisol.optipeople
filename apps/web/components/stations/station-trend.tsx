import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { CHART_BLUE, TableFrame } from "@optipeople/ui/blocks";
import type { StationTrendPoint } from "@/lib/reports/types";
import { formatDuration, formatMinutes, formatNumber, formatSignedPercent, NO_DATA } from "@/lib/reports/format";
import { trendScaleMax } from "@/lib/stations-view/timeline";

// Time per piece week by week against normal: a column per ISO week with the
// week's normal as a dashed mark, and the table twin under it. Plain
// server-rendered divs like the charts of @optipeople/ui; those have no
// column-with-reference-mark chart.

const CHART_HEIGHT = 160;

export function StationTrendChart({ points }: { points: StationTrendPoint[] }) {
  const max = trendScaleMax(points);
  if (max == null) {
    return <p className="text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">{NO_DATA}</p>;
  }
  const h = (s: number) => `${(s / max) * 100}%`;
  const hasNormal = points.some((p) => p.normalSeconds != null);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
        <span className="flex items-center gap-[6px]">
          <span aria-hidden className="h-[10px] w-[10px] rounded-[2px]" style={{ background: CHART_BLUE }} />
          Tid pr. stk. (median)
        </span>
        {hasNormal && (
          <span className="flex items-center gap-[6px]">
            <span aria-hidden className="w-[14px] border-t-2 border-dashed border-[var(--ds-orange-darkest)]" />
            Normalt
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <div
          className="flex flex-col justify-between text-right text-[11px] leading-[12px] tabular-nums text-[var(--ds-grey-medium-04)]"
          style={{ height: CHART_HEIGHT }}
          aria-hidden
        >
          <span>{formatMinutes(max)}</span>
          <span>{formatMinutes(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative flex items-end gap-[6px] border-b border-l border-[var(--ds-grey-light-03)] px-[4px]"
            style={{ height: CHART_HEIGHT }}
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-[var(--ds-grey-light-02)]" />
            <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[var(--ds-grey-light-02)]" />
            {points.map((p) => {
              const value = p.timePerPiece.seconds;
              return (
                <div
                  key={p.weekStart}
                  className="relative flex h-full flex-1 items-end justify-center"
                  title={`Uge ${p.isoWeek}: ${value == null ? NO_DATA : formatMinutes(value)}${
                    p.normalSeconds == null ? "" : `, normalt ${formatMinutes(p.normalSeconds)}`
                  }${p.countThrough == null ? "" : `, ${formatNumber(p.countThrough)} gennem`}`}
                >
                  {value != null && (
                    <span
                      aria-hidden
                      className="w-full max-w-[36px] rounded-t-[2px]"
                      style={{ height: h(value), background: CHART_BLUE }}
                    />
                  )}
                  {p.normalSeconds != null && (
                    <span
                      aria-hidden
                      className="absolute inset-x-0 border-t-2 border-dashed border-[var(--ds-orange-darkest)]"
                      style={{ bottom: h(p.normalSeconds) }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex gap-[6px] px-[4px] pt-1" aria-hidden>
            {points.map((p) => (
              <span
                key={p.weekStart}
                className="flex-1 text-center text-[11px] leading-[14px] tabular-nums text-[var(--ds-grey-medium-04)]"
              >
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StationTrendTable({ points }: { points: StationTrendPoint[] }) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Uge</DataTableHeader>
          <DataTableHeader align="right">Gennem</DataTableHeader>
          <DataTableHeader align="right">Tid pr. stk.</DataTableHeader>
          <DataTableHeader align="right">Normalt</DataTableHeader>
          <DataTableHeader align="right">Mod normalt</DataTableHeader>
          <DataTableHeader align="right">Stod stille</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {[...points].reverse().map((p) => (
            <DataTableRow key={p.weekStart}>
              <DataTableCell className="whitespace-nowrap">
                Uge {p.isoWeek} <span className="text-[var(--ds-grey-medium-05)]">{p.isoYear}</span>
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatNumber(p.countThrough)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatMinutes(p.timePerPiece.seconds)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatMinutes(p.normalSeconds)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatSignedPercent(p.deviationPercent)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {p.standstillSeconds === 0 ? "Ingen" : formatDuration(p.standstillSeconds)}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
