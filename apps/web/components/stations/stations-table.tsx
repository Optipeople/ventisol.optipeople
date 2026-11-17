import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { MeterBar, TableFrame } from "@optipeople/ui/blocks";
import type { StationRow } from "@/lib/reports/types";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatSignedPercent,
  NO_DATA,
} from "@/lib/reports/format";
import { StationStatusTag } from "./station-status";

// The Stationer table: one row per station and machine for a day or a
// period, every figure from lib/reports. A station without data says so
// once across the row instead of in every cell. The day view sits under the
// station tiles, which already show status, in progress and missing scan-outs,
// so the day table leaves those three columns out.

type Mode = "day" | "period";

function Standstill({ seconds }: { seconds: number | null }) {
  if (seconds == null) return <>{NO_DATA}</>;
  if (seconds === 0) return <span className="text-[var(--ds-grey-medium-05)]">Ingen</span>;
  return <span className="font-bold text-[var(--ds-red-dark)]">{formatDuration(seconds)}</span>;
}

function Deviation({ row }: { row: StationRow }) {
  if (row.deviationPercent == null) {
    return <span className="text-[var(--ds-grey-medium-05)]">{row.normalSeconds == null ? "Intet normalt" : NO_DATA}</span>;
  }
  const slow = row.status === "slower";
  return (
    <span className={slow ? "font-bold text-[var(--ds-red-dark)]" : undefined}>
      {formatSignedPercent(row.deviationPercent)}
    </span>
  );
}

/** A wait before the station. Null with data: no element came here from an earlier station. */
function Wait({ seconds }: { seconds: number | null }) {
  if (seconds == null) return <span className="font-normal text-[var(--ds-grey-medium-05)]">Ingen</span>;
  return <>{formatDuration(seconds)}</>;
}

function Count({ value, warn = false }: { value: number | null; warn?: boolean }) {
  if (value == null) return <>{NO_DATA}</>;
  if (value === 0) return <span className="text-[var(--ds-grey-medium-05)]">0</span>;
  return <span className={warn ? "font-bold text-[var(--ds-orange-text)]" : undefined}>{formatNumber(value)}</span>;
}

export function StationsTable({
  rows,
  mode,
  hrefFor,
}: {
  rows: StationRow[];
  mode: Mode;
  hrefFor: (row: StationRow) => string;
}) {
  const period = mode === "period";
  // Columns after Station (and Status in a period), for the colSpan of a row without data.
  const figureColumns = period ? 12 : 6;
  return (
    <TableFrame>
      <DataTable stickyHeader stickyFirstColumn>
        <DataTableHead>
          <DataTableHeader>Station</DataTableHeader>
          {period && <DataTableHeader>Status</DataTableHeader>}
          <DataTableHeader align="right">{period ? "Gennem" : "Gennem i dag"}</DataTableHeader>
          {period && <DataTableHeader align="right">Dage</DataTableHeader>}
          <DataTableHeader align="right">Tid pr. stk.</DataTableHeader>
          <DataTableHeader align="right">Normalt</DataTableHeader>
          <DataTableHeader align="right">Mod normalt</DataTableHeader>
          <DataTableHeader align="right">Stod stille</DataTableHeader>
          {period && <DataTableHeader align="right">Gns. ventetid før</DataTableHeader>}
          <DataTableHeader align="right">Længste ventetid før</DataTableHeader>
          <DataTableHeader>Udnyttelse</DataTableHeader>
          {period && (
            <>
              <DataTableHeader align="right">Omarbejde</DataTableHeader>
              <DataTableHeader align="right">Mangler ud-scanning</DataTableHeader>
              <DataTableHeader align="right">Elementer</DataTableHeader>
            </>
          )}
        </DataTableHead>
        <DataTableBody>
          {rows.map((row) => (
            <DataTableRow key={row.stationNo} href={hrefFor(row)}>
              <DataTableCell className="whitespace-nowrap">
                <span className="font-bold">{row.name}</span>
                <span className="ml-2 text-[12px] text-[var(--ds-grey-medium-05)]">{row.kindLabel}</span>
              </DataTableCell>
              {period && (
                <DataTableCell className="whitespace-nowrap">
                  <StationStatusTag status={row.status} standstillSeconds={row.standstillSeconds} />
                </DataTableCell>
              )}
              {row.hasData ? (
                <>
                  <DataTableCell align="right" className="tabular-nums">
                    {formatNumber(row.countThrough)}
                  </DataTableCell>
                  {period && (
                    <DataTableCell align="right" className="tabular-nums">
                      {formatNumber(row.daysActive)}
                    </DataTableCell>
                  )}
                  <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                    {formatMinutes(row.timePerPiece.seconds)}
                  </DataTableCell>
                  <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                    {row.normalSeconds == null ? (
                      <span className="text-[var(--ds-grey-medium-05)]">Intet normalt</span>
                    ) : (
                      formatMinutes(row.normalSeconds)
                    )}
                  </DataTableCell>
                  <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                    <Deviation row={row} />
                  </DataTableCell>
                  <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                    <Standstill seconds={row.standstillSeconds} />
                  </DataTableCell>
                  {period && (
                    <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                      <Wait seconds={row.avgWaitBefore.seconds} />
                    </DataTableCell>
                  )}
                  <DataTableCell
                    align="right"
                    className={`whitespace-nowrap tabular-nums ${
                      row.status === "long_dwell" ? "font-bold text-[var(--ds-orange-text)]" : ""
                    }`}
                  >
                    <Wait seconds={row.longestWaitBeforeSeconds} />
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap">
                    {row.utilisationPercent == null ? (
                      NO_DATA
                    ) : (
                      <MeterBar ratio={row.utilisationPercent / 100} label={`${row.utilisationPercent} %`} />
                    )}
                  </DataTableCell>
                  {period && (
                    <>
                      <DataTableCell align="right" className="tabular-nums">
                        <Count value={row.reworkPasses} />
                      </DataTableCell>
                      <DataTableCell align="right" className="tabular-nums">
                        <Count value={row.missingScanOutCount} warn />
                      </DataTableCell>
                      <DataTableCell align="right" className="tabular-nums">
                        {formatNumber(row.elementsThrough)}
                      </DataTableCell>
                    </>
                  )}
                </>
              ) : (
                <DataTableCell colSpan={figureColumns} className="text-[var(--ds-grey-medium-05)]">
                  {NO_DATA}
                  {row.kind === "machine" || row.kind === "buffer"
                    ? ". Tallene kommer, når forbindelsen leverer data."
                    : period
                      ? ". Ingen scanninger i perioden."
                      : ". Ingen scanninger denne dag."}
                </DataTableCell>
              )}
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
