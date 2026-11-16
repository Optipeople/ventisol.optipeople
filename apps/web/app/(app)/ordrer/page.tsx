import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, FilterBar, PageHeader, PageShell, PillTabs, SectionTitle, type FilterBarSelect } from "@optipeople/ui/blocks";
import { ExportButtons } from "@/components/export/export-buttons";
import { OrdersSearch } from "@/components/orders/orders-search";
import { FinishedOrdersTable, InProgressOrdersTable } from "@/components/orders/orders-tables";
import { AuditPager } from "@/components/settings/audit-pager";
import { requireCapability } from "@/lib/auth";
import type { Claims } from "@/lib/db";
import {
  ACTIVE_DAYS,
  CLOCK_LABELS,
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
import { formatCount, listFinishedOrders, listInProgressOrders } from "@/lib/reports";
import { dayKey, formatDisplayDay, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Ordrer" };

const FILTER_LABELS = { all: "Alle", from: "Pakket fra", to: "Pakket til", clear: "Ryd filtre", updating: "Opdaterer…" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const view = parseOrdersView(await searchParams);
  const ctx = await requireCapability(viewHref(view), "reports.view");
  const now = requestTime();

  return (
    <PageShell width="wide">
      <PageHeader
        title="Ordrer"
        intro="Ordrer i gang nu og pakkede ordrer. Klik på en ordre for ruten, afvigelserne og produktionslisten."
      >
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <PillTabs
            label="Visning"
            selectedId={view.tab}
            tabs={[
              { id: "in-progress", label: "I gang nu", href: tabHref(view, "in-progress") },
              { id: "finished", label: "Afsluttede", href: tabHref(view, "finished") },
            ]}
          />
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

function clockSelect(view: OrdersView): FilterBarSelect {
  return {
    param: "clock",
    label: "Tid",
    value: view.clock ?? "",
    emptyLabel: "Som indstillet",
    options: [
      { value: "working", label: CLOCK_LABELS.working },
      { value: "wall", label: CLOCK_LABELS.wall },
    ],
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

/** "1 til 50 af 312 ordrer". */
function rangeText(page: number, shown: number, total: number): string {
  const first = (page - 1) * PAGE_SIZE + 1;
  return `${first} til ${first + shown - 1} af ${formatCount(total, "ordre", "ordrer")}`;
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

function periodText(view: FinishedView): string {
  if (!view.from && !view.to) return "Alle pakkede ordrer";
  if (view.from && view.to) return `Pakket ${formatDisplayDay(view.from)} til ${formatDisplayDay(view.to)}`;
  return view.from ? `Pakket fra ${formatDisplayDay(view.from)}` : `Pakket til og med ${formatDisplayDay(view.to!)}`;
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
        trailingSelects={[clockSelect(view)]}
        preserve={preserveFor(view, "status", "from", "to", "clock")}
        hasActiveFilters={Boolean(view.status || view.from || view.to || view.clock)}
        labels={FILTER_LABELS}
      />

      <SectionTitle
        title="Afsluttede ordrer"
        aside={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {periodText(view)}
              {list.rows.length > 0 ? `. ${rangeText(list.page, list.rows.length, list.total)}.` : "."}
            </span>
            {list.total > 0 && <ExportButtons report="finished_orders" params={params} />}
          </span>
        }
      />

      {list.rows.length > 0 ? (
        <>
          <FinishedOrdersTable rows={list.rows} view={view} />
          <Pager view={view} total={list.total} />
          <Footnote />
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
        trailingSelects={[clockSelect(view)]}
        preserve={preserveFor(view, "status", "active", "clock")}
        hasActiveFilters={Boolean(view.status || !view.activeOnly || view.clock)}
        labels={FILTER_LABELS}
      />

      <SectionTitle
        title="Ordrer i gang nu"
        aside={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {view.activeOnly ? `Scannet de seneste ${ACTIVE_DAYS} dage` : "Alle ordrer, der ikke er pakket"}
              {list.rows.length > 0 ? `. ${rangeText(list.page, list.rows.length, list.total)}.` : "."}
            </span>
            {list.total > 0 && <ExportButtons report="orders_in_progress" params={params} />}
          </span>
        }
      />

      {list.rows.length > 0 ? (
        <>
          <InProgressOrdersTable rows={list.rows} view={view} />
          <Pager view={view} total={list.total} />
          <Footnote forecast />
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

function Footnote({ forecast = false }: { forecast?: boolean }) {
  return (
    <p className="mt-3 text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
      * Uden produktionsliste: tallet gælder kun de scannede elementer.
      {forecast && " Forventet klar er et skøn ud fra de typiske tider."}
    </p>
  );
}
