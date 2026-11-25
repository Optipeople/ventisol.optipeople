import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Tag,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import type { MissingScanOut } from "@/lib/reports";
import { dayKey, formatClock, formatDateTime } from "@/lib/time";
import { elementLabel } from "./station-timeline";

// Passes scanned In on the day and never Out (listMissingScanOuts), so the
// floor can find the element and fix the scan. The ones the station stopped
// at shift end are listed too, as Auto-stop: forgotten, but caught. They
// count in times up to the stop; the missing ones count in none.

export function MissingScanOutsTable({ rows, day }: { rows: MissingScanOut[]; day: string }) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Ind</DataTableHeader>
          <DataTableHeader>Station</DataTableHeader>
          <DataTableHeader>Ordre</DataTableHeader>
          <DataTableHeader>Kunde</DataTableHeader>
          <DataTableHeader>Element</DataTableHeader>
          <DataTableHeader>Hvorfor</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {rows.map((r) => {
            const ms = Date.parse(r.startAt);
            return (
              <DataTableRow key={r.intervalId}>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {dayKey(ms) === day ? formatClock(ms) : formatDateTime(ms)}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap">{r.stationName}</DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  <Link href={`/ordre/${r.orderNo}`} className="text-[var(--ds-midnight-green)] hover:underline">
                    {r.orderNo}
                  </Link>
                </DataTableCell>
                <DataTableCell className="max-w-[220px] truncate">{r.customer ?? ""}</DataTableCell>
                <DataTableCell className="whitespace-nowrap">
                  {elementLabel(r)} <span className="text-[var(--ds-grey-medium-05)]">({r.barcode})</span>
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap">
                  {r.kind === "auto_stopped" ? (
                    <Tag size="small" title="Tiden tæller med frem til stoppet">
                      Auto-stop
                    </Tag>
                  ) : (
                    <Tag variant="issue" size="small" title="Tæller ikke med i nogen tid">
                      Mangler ud-scanning
                    </Tag>
                  )}{" "}
                  <span className="text-[var(--ds-grey-medium-05)]">{r.reasonLabel}</span>
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
