import Link from "next/link";
import { StatusTag } from "@/components/status-tag";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/components/ui/data-table";
import { stationKey, type ElementSummary, type OrderSortKey, type OrderSummary, type StationSummary } from "@/lib/report";
import { formatDuration, formatInt, formatPercent, formatScanTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export function TableFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-area max-h-[70vh] overflow-auto rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm">
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[2px] border border-dashed border-[var(--ds-grey-light-03)] bg-[var(--color-surface)] p-8 text-center text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
      {children}
    </p>
  );
}

/** The read did not get everything: shown instead of numbers that would be wrong. */
export function ReadFailed({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-5 rounded-[2px] border border-[var(--ds-tag-orange-dark)] bg-[var(--ds-tag-orange-light)] p-8 text-center text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]"
    >
      {children}
    </p>
  );
}

/** One quiet line under a filter, e.g. that a date was moved. */
export function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">{children}</p>;
}

export function SectionTitle({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-[16px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">{title}</h2>
      {aside && (
        <p className="text-[14px] leading-[21px] tabular-nums text-[var(--ds-grey-medium-05)]">{aside}</p>
      )}
    </div>
  );
}

const muted = <span className="text-[var(--ds-grey-light-03)]">–</span>;

function StationList({ stations, active }: { stations: string[]; active: string[] }) {
  if (stations.length === 0) return muted;
  return (
    <span className="text-[13px] leading-[18px]">
      {stations.map((s, i) => (
        // Two stations can carry the same name (they are told apart by number).
        <span key={`${i}-${s}`}>
          {i > 0 && <span className="text-[var(--ds-grey-light-03)]"> · </span>}
          <span className={cn(active.includes(s) && "font-bold text-[var(--ds-orange-darkest)]")}>{s}</span>
        </span>
      ))}
    </span>
  );
}

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
  const active = sort.key === sortKey;
  return (
    <DataTableHeader align={align} className="whitespace-nowrap">
      <Link
        href={sort.href(sortKey)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
        className={cn("hover:underline", active && "text-[var(--ds-midnight-green)]")}
      >
        {children}
        <span aria-hidden className="ml-1 inline-block w-[10px] text-[11px]">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </Link>
    </DataTableHeader>
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
      <DataTable>
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
                <StationList stations={o.stations} active={o.activeAt} />
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

function UtilisationBar({ ratio }: { ratio: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-block h-[8px] w-[80px] overflow-hidden rounded-[2px] bg-[var(--ds-grey-light-02)]">
        <span
          className="absolute inset-y-0 left-0 bg-[var(--ds-midnight-green)]"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="w-[38px] text-right tabular-nums">{formatPercent(ratio)}</span>
    </span>
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
      <DataTable>
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
                  <UtilisationBar ratio={s.utilisation} />
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
      <DataTable>
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
                <StationList stations={e.stations} active={[]} />
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
