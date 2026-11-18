// The two order lists of the Ordrer tab. Sorted and paged on the server: the
// headers are links (lib/orders-view/params.ts), each row opens the order.

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { SortHeader, TableFrame } from "@optipeople/ui/blocks";
import {
  formatDayTime,
  formatDuration,
  formatForecast,
  formatNumber,
  NO_DATA,
} from "@/lib/reports/format";
import type { AllOrderRow, FinishedOrderRow, InProgressOrderRow } from "@/lib/reports/types";
import {
  orderHref,
  sortHref,
  type AllSort,
  type AllView,
  type FinishedSort,
  type FinishedView,
  type InProgressSort,
  type InProgressView,
} from "@/lib/orders-view/params";
import { DeliveryStatusTag } from "./delivery-status-tag";

const muted = "text-[var(--ds-grey-medium-05)]";

function Customer({ customer, caseName }: { customer: string | null; caseName: string | null }) {
  return (
    <div className="min-w-[160px] max-w-[280px]">
      <div className="truncate" title={customer ?? undefined}>
        {customer ?? <span className={muted}>Ukendt kunde</span>}
      </div>
      {caseName && (
        <div className={`truncate text-[12px] leading-[16px] ${muted}`} title={caseName}>
          {caseName}
        </div>
      )}
    </div>
  );
}

function Elements({ row, packed }: { row: { elements: number; expectedSource: string }; packed?: number }) {
  const noList = row.expectedSource === "scans";
  return (
    <span title={noList ? "Uden produktionsliste: kun de scannede elementer" : undefined}>
      {packed != null ? `${formatNumber(packed)} af ${formatNumber(row.elements)}` : formatNumber(row.elements)}
      {noList && <span className={muted}>*</span>}
    </span>
  );
}

/** "Uge 47" (or "Uge 47, 2026" given the year) with the deadline as a tooltip, or "Ingen leveringsuge". */
function DeliveryWeek({ week, dueAt, year }: { week: number | null; dueAt: string | null; year?: number | null }) {
  if (week == null) return <span className={muted}>Ingen leveringsuge</span>;
  return (
    <span title={dueAt ? `Frist ${formatDayTime(dueAt)}` : undefined}>
      Uge {week}
      {year != null && `, ${year}`}
    </span>
  );
}

export function FinishedOrdersTable({ rows, view }: { rows: FinishedOrderRow[]; view: FinishedView }) {
  const head = (key: FinishedSort, label: string, align?: "right") => (
    <SortHeader href={sortHref(view, key)} active={view.sort === key} direction={view.dir} align={align}>
      {label}
    </SortHeader>
  );
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          {head("order", "Ordre")}
          {head("customer", "Kunde")}
          {head("elements", "Elementer", "right")}
          <DataTableHeader>Leveringsuge</DataTableHeader>
          {head("start", "Start")}
          {head("packed", "Pakket")}
          {head("lead", "Gennemløbstid", "right")}
          {head("wait", "Heraf ventetid", "right")}
          {head("status", "Status")}
        </DataTableHead>
        <DataTableBody>
          {rows.map((r) => (
            <DataTableRow key={r.orderNo} href={orderHref(r.orderNo, view.clock)}>
              <DataTableCell className="font-bold tabular-nums">{r.orderNo}</DataTableCell>
              <DataTableCell>
                <Customer customer={r.customer} caseName={r.caseName} />
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                <Elements row={r} />
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap">
                <DeliveryWeek week={r.deliveryWeek} dueAt={r.dueAt} />
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{formatDayTime(r.startAt)}</DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{formatDayTime(r.packedAt)}</DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatDuration(r.lead.seconds)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatDuration(r.wait.seconds)}
              </DataTableCell>
              <DataTableCell>
                <DeliveryStatusTag status={r.status} label={r.statusLabel} />
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

export function AllOrdersTable({ rows, view }: { rows: AllOrderRow[]; view: AllView }) {
  const head = (key: AllSort, label: string, align?: "right") => (
    <SortHeader href={sortHref(view, key)} active={view.sort === key} direction={view.dir} align={align}>
      {label}
    </SortHeader>
  );
  const day = (iso: string | null) => (iso ? formatDayTime(iso) : <span className={muted}>{NO_DATA}</span>);
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          {head("order", "Ordre")}
          {head("customer", "Kunde")}
          {head("elements", "Elementer", "right")}
          {head("delivery", "Leveringsuge")}
          {head("first_scan", "Start")}
          {head("last_scan", "Seneste scanning")}
          {head("status", "Status")}
        </DataTableHead>
        <DataTableBody>
          {rows.map((r) => (
            <DataTableRow key={r.orderNo} href={orderHref(r.orderNo, view.clock)}>
              <DataTableCell className="font-bold tabular-nums">{r.orderNo}</DataTableCell>
              <DataTableCell>
                <Customer customer={r.customer} caseName={r.caseName} />
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {r.elements == null ? (
                  <span className={muted}>{NO_DATA}</span>
                ) : r.status === "in_progress" && r.elementsPacked != null ? (
                  `${formatNumber(r.elementsPacked)} af ${formatNumber(r.elements)}`
                ) : (
                  formatNumber(r.elements)
                )}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap">
                <DeliveryWeek week={r.deliveryWeek} dueAt={r.dueAt} year={r.deliveryYear} />
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{day(r.firstScanAt)}</DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{day(r.lastScanAt)}</DataTableCell>
              <DataTableCell
                className={r.status === "not_started" ? `whitespace-nowrap ${muted}` : "whitespace-nowrap"}
                title={r.hasDocument ? undefined : "Uden produktionsliste"}
              >
                {r.statusLabel}
                {!r.hasDocument && <span className={muted}>*</span>}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

export function InProgressOrdersTable({ rows, view }: { rows: InProgressOrderRow[]; view: InProgressView }) {
  const head = (key: InProgressSort, label: string, align?: "right") => (
    <SortHeader href={sortHref(view, key)} active={view.sort === key} direction={view.dir} align={align}>
      {label}
    </SortHeader>
  );
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          {head("order", "Ordre")}
          {head("customer", "Kunde")}
          {head("elements", "Pakket", "right")}
          {head("start", "Start")}
          <DataTableHeader>Er nu ved</DataTableHeader>
          {head("elapsed", "Tid indtil nu", "right")}
          {head("forecast", "Forventet klar")}
          {head("due", "Leveringsuge")}
          <DataTableHeader>Status</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {rows.map((r) => (
            <DataTableRow key={r.orderNo} href={orderHref(r.orderNo, view.clock)}>
              <DataTableCell className="font-bold tabular-nums">{r.orderNo}</DataTableCell>
              <DataTableCell>
                <Customer customer={r.customer} caseName={r.caseName} />
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                <Elements row={r} packed={r.elementsPacked} />
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{formatDayTime(r.startAt)}</DataTableCell>
              <DataTableCell className="max-w-[220px]">
                <span className="line-clamp-2" title={`Seneste scanning ${formatDayTime(r.lastScanAt)}`}>
                  {r.currentLabel}
                </span>
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatDuration(r.elapsed.seconds)}
              </DataTableCell>
              <DataTableCell
                className="whitespace-nowrap"
                title={
                  r.forecastBasis === "seen_elements" ? "Kun for de scannede elementer: der er ingen produktionsliste" : undefined
                }
              >
                {r.forecastReadyAt ? formatForecast(r.forecastReadyAt) : <span className={muted}>{NO_DATA}</span>}
                {r.forecastBasis === "seen_elements" && <span className={muted}>*</span>}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap">
                <DeliveryWeek week={r.deliveryWeek} dueAt={r.dueAt} />
              </DataTableCell>
              <DataTableCell>
                <DeliveryStatusTag status={r.status} label={r.statusLabel} />
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
