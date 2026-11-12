import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { DotList, MeterBar, SortHeader, TableFrame } from "@optipeople/ui/blocks";
import { StatusTag } from "@/components/status-tag";
import { stationKey, type ElementSummary, type OrderSortKey, type OrderSummary, type StationSummary } from "@/lib/report";
import { formatDuration, formatInt, formatPercent, formatScanTime } from "@/lib/time";

const muted = <span className="text-[var(--ds-grey-light-03)]">–</span>;

interface SortSpec {
  key: OrderSortKey;
  dir: "asc" | "desc";
  href: (key: OrderSortKey) => string;
}

function Header({
  children,
  sortKey,
  sort,
  align,
}: {
  children: React.ReactNode;
  sortKey?: OrderSortKey;
  sort?: SortSpec;
  align?: "right";
}) {
  if (!sort || !sortKey) {
    return (
      <DataTableHeader align={align} className="whitespace-nowrap">
        {children}
      </DataTableHeader>
    );
  }
  return (
    <SortHeader href={sort.href(sortKey)} active={sort.key === sortKey} direction={sort.dir} align={align}>
      {children}
    </SortHeader>
  );
}

/** Orders: the overview's table, and with `sort` and `period` the period view's. */
export function OrdersTable({
  orders,
  referenceDay,
  sort,
  period = false,
}: {
  orders: OrderSummary[];
  /** Scan times on this day show the clock only. */
  referenceDay?: string;
  sort?: SortSpec;
  period?: boolean;
}) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <Header sortKey="order" sort={sort}>Ordre</Header>
          <Header sortKey="elements" sort={sort} align="right">Elementer</Header>
          <Header sortKey="total" sort={sort} align="right">Tid i alt</Header>
          {period && (
            <Header sortKey="perElement" sort={sort} align="right">Pr. element</Header>
          )}
          <Header sortKey="stations" sort={sort}>Stationer</Header>
          {period && (
            <Header sortKey="days" sort={sort} align="right">Dage</Header>
          )}
          <Header sortKey="status" sort={sort}>Status</Header>
          <Header sortKey="first" sort={sort} align="right">Første scanning</Header>
          <Header sortKey="last" sort={sort} align="right">Sidste scanning</Header>
        </DataTableHead>
        <DataTableBody>
          {orders.map((o) => (
            <DataTableRow key={o.orderNo} className="hover:bg-[var(--ds-table-blue-hover)]">
              <DataTableCell className="whitespace-nowrap font-bold tabular-nums">
                <Link href={`/ordre/${o.orderNo}`} className="text-[var(--ds-midnight-green)] underline-offset-2 hover:underline">
                  {o.orderNo}
                </Link>
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">{formatInt(o.elements)}</DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums font-bold">
                {formatDuration(o.totalMs)}
              </DataTableCell>
              {period && (
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {o.elements > 0 ? formatDuration(o.totalMs / o.elements) : "–"}
                </DataTableCell>
              )}
              <DataTableCell>
                <DotList items={o.stations} active={o.activeAt} empty={muted} />
              </DataTableCell>
              {period && (
                <DataTableCell align="right" className="tabular-nums">{o.days.length}</DataTableCell>
              )}
              <DataTableCell className="whitespace-nowrap">
                <StatusTag status={o.status} />
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatScanTime(o.firstScan, referenceDay)}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {o.status === "active" ? (
                  <span className="text-[var(--ds-orange-darkest)]">nu</span>
                ) : (
                  formatScanTime(o.lastScan, referenceDay)
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

export function StationsTable({
  stations,
  showUtilisation = true,
}: {
  stations: StationSummary[];
  /** Off where the span runs over nights and the ratio would mean little. */
  showUtilisation?: boolean;
}) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Station</DataTableHeader>
          <DataTableHeader align="right">Færdige</DataTableHeader>
          <DataTableHeader align="right">I gang</DataTableHeader>
          <DataTableHeader align="right">Gns. tid pr. element</DataTableHeader>
          <DataTableHeader align="right">Tid i alt</DataTableHeader>
          {showUtilisation && <DataTableHeader align="right">Udnyttelse</DataTableHeader>}
        </DataTableHead>
        <DataTableBody>
          {stations.map((s) => (
            <DataTableRow key={stationKey(s)} className="hover:bg-[var(--ds-table-blue-hover)]">
              <DataTableCell className="whitespace-nowrap font-bold">{s.station}</DataTableCell>
              <DataTableCell align="right" className="tabular-nums">{formatInt(s.done)}</DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {s.active > 0 ? <span className="font-bold text-[var(--ds-orange-darkest)]">{s.active}</span> : muted}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">{formatDuration(s.averageMs)}</DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">{formatDuration(s.busyMs)}</DataTableCell>
              {showUtilisation && (
                <DataTableCell align="right" className="whitespace-nowrap">
                  <MeterBar ratio={s.utilisation} label={formatPercent(s.utilisation)} />
                </DataTableCell>
              )}
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

export function ElementsTable({ elements }: { elements: ElementSummary[] }) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Stregkode</DataTableHeader>
          <DataTableHeader>Position</DataTableHeader>
          <DataTableHeader align="right">Stk.</DataTableHeader>
          <DataTableHeader align="right">Tid i alt</DataTableHeader>
          <DataTableHeader>Stationer</DataTableHeader>
          <DataTableHeader align="right">Omarbejde</DataTableHeader>
          <DataTableHeader>Status</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {elements.map((e) => (
            <DataTableRow key={e.barcode} className="hover:bg-[var(--ds-table-blue-hover)]">
              <DataTableCell className="whitespace-nowrap font-mono text-[13px] tabular-nums">{e.barcode}</DataTableCell>
              <DataTableCell className="whitespace-nowrap font-bold">{e.label}</DataTableCell>
              <DataTableCell align="right" className="tabular-nums">{e.piece ?? "–"}</DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap font-bold tabular-nums">{formatDuration(e.totalMs)}</DataTableCell>
              <DataTableCell>
                <DotList items={e.stations} empty={muted} />
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {e.reworkPasses > 0 ? (
                  <span className="font-bold text-[var(--ds-orange-darkest)]">{e.reworkPasses}</span>
                ) : (
                  muted
                )}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap text-[13px]">
                {e.inProgress ? (
                  <span className="font-bold text-[var(--ds-orange-darkest)]">I gang</span>
                ) : (
                  <span className="text-[var(--ds-grey-medium-05)]">Scannet ud</span>
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
