import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import type { TypeDistribution } from "@/lib/reports/types";
import { formatMinutes, formatNumber, formatSignedPercent } from "@/lib/reports/format";

// The spread of pass times per element type over the trend weeks: a table
// with a small range plot per row. The plot is wall clock (min, quartiles,
// max come from the database on the wall clock); the median column follows
// the chosen clock.

/** The scale of the range plots: wide enough for every middle half and normal, not for the odd outlier. */
function scaleMax(rows: TypeDistribution[]): number {
  let max = 60;
  for (const r of rows) max = Math.max(max, Math.min(r.maxSeconds, r.p75Seconds * 2), r.normalSeconds ?? 0);
  return max;
}

function RangePlot({ row, max }: { row: TypeDistribution; max: number }) {
  const pct = (s: number) => `${Math.min(100, (Math.max(0, s) / max) * 100)}%`;
  const clipped = row.maxSeconds > max;
  return (
    <div
      className="relative h-[18px] w-full min-w-[160px]"
      title={`Korteste ${formatMinutes(row.minSeconds)}, midterste halvdel ${formatMinutes(row.p25Seconds)} til ${formatMinutes(
        row.p75Seconds
      )}, median ${formatMinutes(row.medianSeconds)}, længste ${formatMinutes(row.maxSeconds)}`}
    >
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[var(--ds-grey-light-02)]" />
      <span
        aria-hidden
        className="absolute top-1/2 h-px bg-[var(--ds-grey-medium-04)]"
        style={{ left: pct(row.minSeconds), width: `calc(${pct(row.maxSeconds)} - ${pct(row.minSeconds)})` }}
      />
      <span
        aria-hidden
        className="absolute top-[3px] bottom-[3px] rounded-[2px] bg-[#b2d0d0]"
        style={{ left: pct(row.p25Seconds), width: `calc(${pct(row.p75Seconds)} - ${pct(row.p25Seconds)})` }}
      />
      <span
        aria-hidden
        className="absolute top-[1px] bottom-[1px] w-[2px] bg-[var(--ds-midnight-green)]"
        style={{ left: pct(row.medianSeconds) }}
      />
      {row.normalSeconds != null && (
        <span
          aria-hidden
          className="absolute -top-[1px] -bottom-[1px] w-0 border-l-2 border-dashed border-[var(--ds-orange-darkest)]"
          style={{ left: pct(row.normalSeconds) }}
        />
      )}
      {clipped && (
        <span aria-hidden className="absolute -right-[2px] top-1/2 -translate-y-1/2 text-[10px] text-[var(--ds-grey-medium-04)]">
          ›
        </span>
      )}
    </div>
  );
}

export function TypeDistributionTable({ rows }: { rows: TypeDistribution[] }) {
  const max = scaleMax(rows);
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">
        <span className="inline-flex items-center gap-[6px]">
          <span aria-hidden className="inline-block h-[10px] w-[18px] rounded-[2px] bg-[#b2d0d0]" />
          Midterste halvdel
        </span>
        <span className="inline-flex items-center gap-[6px]">
          <span aria-hidden className="inline-block h-[12px] w-[2px] bg-[var(--ds-midnight-green)]" />
          Median
        </span>
        <span className="inline-flex items-center gap-[6px]">
          <span aria-hidden className="inline-block h-[12px] w-0 border-l-2 border-dashed border-[var(--ds-orange-darkest)]" />
          Normalt
        </span>
        <span>Stregen går fra korteste til længste passage (vægur).</span>
      </div>
      <TableFrame>
        <DataTable stickyHeader>
          <DataTableHead>
            <DataTableHeader>Elementtype</DataTableHeader>
            <DataTableHeader align="right">Passager</DataTableHeader>
            <DataTableHeader align="right">Median</DataTableHeader>
            <DataTableHeader align="right">Normalt</DataTableHeader>
            <DataTableHeader align="right">Mod normalt</DataTableHeader>
            <DataTableHeader align="right">Midterste halvdel</DataTableHeader>
            <DataTableHeader className="w-[35%]">Spredning</DataTableHeader>
          </DataTableHead>
          <DataTableBody>
            {rows.map((row) => (
              <DataTableRow key={row.elementTypeId ?? "uden-type"}>
                <DataTableCell className="whitespace-nowrap font-bold">{row.elementTypeName}</DataTableCell>
                <DataTableCell align="right" className="tabular-nums">
                  {formatNumber(row.passes)}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {formatMinutes(row.median.seconds)}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {row.normalSeconds == null ? (
                    <span className="text-[var(--ds-grey-medium-05)]">Intet normalt</span>
                  ) : (
                    formatMinutes(row.normalSeconds)
                  )}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {row.deviationPercent == null ? (
                    <span className="text-[var(--ds-grey-medium-05)]">
                      {row.normalSeconds == null ? "Intet normalt" : "Ingen data endnu"}
                    </span>
                  ) : (
                    formatSignedPercent(row.deviationPercent)
                  )}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {formatMinutes(row.p25Seconds)} til {formatMinutes(row.p75Seconds)}
                </DataTableCell>
                <DataTableCell>
                  <RangePlot row={row} max={max} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </TableFrame>
    </>
  );
}
