import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { EmptyState, FilterBar, PageHeader, PageShell, PillTabs, SectionTitle, type FilterBarSelect } from "@optipeople/ui/blocks";
import { ExportMenu } from "@/components/export/export-menu";
import { OrdersSearch } from "@/components/orders/orders-search";
import { FinishedOrdersTable, InProgressOrdersTable } from "@/components/orders/orders-tables";
import { AuditPager } from "@/components/settings/audit-pager";
import { ClockToggle } from "@/components/stations/view-controls";
import { requireCapability } from "@/lib/auth";
import type { Claims } from "@/lib/db";
import {
  ACTIVE_DAYS,
  FINISHED_STATUSES,
  IN_PROGRESS_STATUSES,
  ORDERS_PATH,
  PAGE_SIZE,
  parseOrdersView,
  preserveFor,
  STATUS_LABELS,
  tabHref,
  viewHref,
  type FinishedView,
  type InProgressView,
  type OrdersView,
  type SearchParams,
} from "@/lib/orders-view/params";
import { formatCount, listFinishedOrders, listInProgressOrders, type Clock } from "@/lib/reports";
import { report } from "@/lib/reports/shared";
import { dayKey, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Ordrer" };

const FILTER_LABELS = { all: "Alle", from: "Pakket fra", to: "Pakket til", clear: "Ryd filtre", updating: "Opdaterer…" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const view = parseOrdersView(await searchParams);
  const ctx = await requireCapability(viewHref(view), "reports.view");
  const now = requestTime();
  // The clock the lists are read on: the URL's, else the setting's.
  const clock: Clock = view.clock ?? (await report(ctx.claims, undefined, async (_db, c) => c.clock));

  return (
    <PageShell width="wide">
      <PageHeader
        title="Ordrer"
        intro="Ordrer i gang nu og pakkede ordrer. Klik på en ordre for ruten, afvigelserne og produktionslisten."
      >
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <PillTabs
              label="Visning"
              selectedId={view.tab}
              tabs={[
                { id: "in-progress", label: "I gang nu", href: tabHref(view, "in-progress") },
                { id: "finished", label: "Afsluttede", href: tabHref(view, "finished") },
              ]}
            />
            <ClockToggle clock={clock} path={ORDERS_PATH} params={preserveFor(view, "clock")} />
          </div>
          <OrdersSearch value={view.search} basePath={ORDERS_PATH} preserve={preserveFor(view, "q")} />
        </div>
      </PageHeader>

      {view.tab === "finished" ? (
        <FinishedList view={view} claims={ctx.claims} today={dayKey(now)} />
      ) : (
        <InProgressList view={view} claims={ctx.claims} now={now} />
      )}
    </PageShell>
  );
}

function statusSelect(view: OrdersView): FilterBarSelect {
  const keys = view.tab === "finished" ? FINISHED_STATUSES : IN_PROGRESS_STATUSES;
  return {
    param: "status",
    label: "Status",
    value: view.status ?? "",
    options: keys.map((key) => ({ value: key, label: STATUS_LABELS[view.tab][key] ?? key })),
  };
}

function Pager({ view, total }: { view: OrdersView; total: number }) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pageCount <= 1) return null;
  return (
    <div className="mt-4 flex justify-end">
      <AuditPager
        page={Math.min(view.page, pageCount)}
        pageCount={pageCount}
        basePath={ORDERS_PATH}
        params={preserveFor(view)}
        param="page"
      />
    </div>
  );
}

/** "1 til 50 af 312 ordrer", or just "7 ordrer" when they all fit on the page. */
function rangeText(page: number, shown: number, total: number): string {
  if (shown === total) return formatCount(total, "ordre", "ordrer");
  const first = (page - 1) * PAGE_SIZE + 1;
  return `${first} til ${first + shown - 1} af ${formatCount(total, "ordre", "ordrer")}`;
}

/** The count and the download, to the right of the list's title. */
function ListAside({ range, children }: { range: string | null; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-3">
      {range && <span>{range}</span>}
      {children}
    </span>
  );
}

function PastLastPage({ view }: { view: OrdersView }) {
  return (
    <EmptyState title="Siden er tom">
      Der er ikke så mange ordrer.{" "}
      <Link className="underline" href={viewHref({ ...view, page: 1 })}>
        Gå til første side
      </Link>
      .
    </EmptyState>
  );
}

async function FinishedList({ view, claims, today }: { view: FinishedView; claims: Claims; today: string }) {
  const params = {
    search: view.search || undefined,
    from: view.from,
    to: view.to,
    status: view.status,
    sort: view.sort,
    dir: view.dir,
    clock: view.clock,
  };
  const list = await listFinishedOrders(claims, { ...params, page: view.page, pageSize: PAGE_SIZE });
  const filtered = Boolean(view.search || view.status || view.from || view.to);

  return (
    <>
      <FilterBar
        basePath={ORDERS_PATH}
        selects={[statusSelect(view)]}
        dateRange={{ from: view.from ?? "", to: view.to ?? "", max: today }}
        preserve={preserveFor(view, "status", "from", "to")}
        hasActiveFilters={Boolean(view.status || view.from || view.to)}
        labels={FILTER_LABELS}
      />

      <SectionTitle
        title="Afsluttede ordrer"
        aside={
          <ListAside range={list.rows.length > 0 ? rangeText(list.page, list.rows.length, list.total) : null}>
            {list.total > 0 && <ExportMenu entries={[{ report: "finished_orders", params }]} />}
          </ListAside>
        }
      />

      {list.rows.length > 0 ? (
        <>
          <FinishedOrdersTable rows={list.rows} view={view} />
          <Pager view={view} total={list.total} />
          <Footnote partial={list.rows.some((r) => r.expectedSource === "scans")} />
        </>
      ) : list.total > 0 ? (
        <PastLastPage view={view} />
      ) : (
        <EmptyState title={filtered ? "Ingen ordrer med de filtre" : "Ingen pakkede ordrer endnu"}>
          {filtered
            ? "Ret søgningen, vælg en anden status eller periode, eller ryd filtrene."
            : "En ordre kommer her, når den er pakket."}
        </EmptyState>
      )}
    </>
  );
}

async function InProgressList({ view, claims, now }: { view: InProgressView; claims: Claims; now: number }) {
  const params = {
    now,
    search: view.search || undefined,
    status: view.status,
    sort: view.sort,
    dir: view.dir,
    activeDays: view.activeOnly ? ACTIVE_DAYS : undefined,
    clock: view.clock,
  };
  const list = await listInProgressOrders(claims, { ...params, page: view.page, pageSize: PAGE_SIZE });
  const filtered = Boolean(view.search || view.status);

  return (
    <>
      <FilterBar
        basePath={ORDERS_PATH}
        selects={[
          statusSelect(view),
          {
            param: "active",
            label: "Seneste scanning",
            value: view.activeOnly ? "" : "all",
            emptyLabel: `Seneste ${ACTIVE_DAYS} dage`,
            options: [{ value: "all", label: "Alle ordrer, der ikke er pakket" }],
          },
        ]}
        preserve={preserveFor(view, "status", "active")}
        hasActiveFilters={Boolean(view.status || !view.activeOnly)}
        labels={FILTER_LABELS}
      />

      <SectionTitle
        title="Ordrer i gang nu"
        aside={
          <ListAside range={list.rows.length > 0 ? rangeText(list.page, list.rows.length, list.total) : null}>
            {list.total > 0 && <ExportMenu entries={[{ report: "orders_in_progress", params }]} />}
          </ListAside>
        }
      />

      {list.rows.length > 0 ? (
        <>
          <InProgressOrdersTable rows={list.rows} view={view} />
          <Pager view={view} total={list.total} />
          <Footnote
            partial={list.rows.some((r) => r.expectedSource === "scans" || r.forecastBasis === "seen_elements")}
            forecast
          />
        </>
      ) : list.total > 0 ? (
        <PastLastPage view={view} />
      ) : (
        <EmptyState title={filtered ? "Ingen ordrer med de filtre" : "Ingen ordrer i gang"}>
          {filtered
            ? "Ret søgningen, vælg en anden status, eller ryd filtrene."
            : view.activeOnly
              ? `Ingen ordre, der ikke er pakket, er scannet de seneste ${ACTIVE_DAYS} dage.`
              : "Alle scannede ordrer er pakket."}
        </EmptyState>
      )}
    </>
  );
}

/** `partial`: a row on the page carries the asterisk. */
function Footnote({ partial, forecast = false }: { partial: boolean; forecast?: boolean }) {
  if (!partial && !forecast) return null;
  return (
    <p className="mt-3 text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
      {partial && "* Uden produktionsliste: tallet gælder kun de scannede elementer."}
      {partial && forecast && " "}
      {forecast && "Forventet klar er et skøn ud fra de typiske tider."}
    </p>
  );
}
