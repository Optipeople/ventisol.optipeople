import type { Metadata } from "next";
import { EmptyState, KpiRow, KpiTile, Note, Notice, PageHeader, PageShell, PeriodFilter, SectionTitle, type PeriodPreset } from "@optipeople/ui/blocks";
import { ReadNotice } from "@/components/read-notice";
import { OrdersTable } from "@/components/report-tables";
import { requireUser } from "@/lib/auth";
import { sortOrders, type OrderSortKey } from "@/lib/report";
import {
  addDays,
  dayKey,
  formatCount,
  formatDisplayDay,
  formatDuration,
  formatInt,
  isoWeek,
  requestTime,
  startOfWeek,
} from "@/lib/time";
import { earliestDay, loadPeriodReport, MAX_LOOKBACK_DAYS, parsePeriodParams } from "@/lib/views";

export const metadata: Metadata = { title: "Periode" };

type Search = { fra?: string; til?: string; sort?: string; retning?: string };

export default async function PeriodPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string") as [string, string][]);
  const ctx = await requireUser(`/periode${qs.size ? `?${qs}` : ""}`);

  const now = requestTime();
  const today = dayKey(now);
  const weekStart = startOfWeek(today);

  // Default: this week so far. Both days are kept inside what can be read.
  const { from, to, sort, dir, clamped } = parsePeriodParams(params, today);

  const report = await loadPeriodReport(ctx, from, to, now);
  const orders = sortOrders(report.orders, sort, dir);

  const presets: PeriodPreset[] = [
    { label: `Denne uge (uge ${isoWeek(today)})`, from: weekStart, to: today },
    { label: `Sidste uge (uge ${isoWeek(addDays(weekStart, -7))})`, from: addDays(weekStart, -7), to: addDays(weekStart, -1) },
    { label: "Seneste 14 dage", from: addDays(today, -13), to: today },
    { label: "Seneste 30 dage", from: addDays(today, -29), to: today },
  ];

  const sortHref = (key: OrderSortKey) => {
    // Clicking the active column flips it; a new column starts descending
    // (largest first), except the order number, which reads naturally up.
    const nextDir = key === sort ? (dir === "asc" ? "desc" : "asc") : key === "order" ? "asc" : "desc";
    return `/periode?${new URLSearchParams({ fra: from, til: to, sort: key, retning: nextDir })}`;
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Tid pr. ordre i en periode"
        intro={`${formatDisplayDay(from)} til ${formatDisplayDay(to)}. Tid fra passager der sluttede i perioden; omarbejde tæller med. Klik på en kolonne for at sortere.`}
      />

      <PeriodFilter
        from={from}
        to={to}
        min={earliestDay(today)}
        max={today}
        presets={presets}
        required
        fromParam="fra"
        toParam="til"
        preserve={{ sort, retning: dir }}
        basePath="/periode"
        history="push"
        labels={{ from: "Fra", to: "Til", updating: "Opdaterer…" }}
      />
      {clamped && <Note>Der kan vises {MAX_LOOKBACK_DAYS} dage tilbage. Perioden er rettet.</Note>}

      {report.incomplete ? (
        <Notice prominent className="mt-5">
          Der er for mange scanninger til at hente perioden, så tallene vises ikke. Vælg en kortere eller nyere periode.
        </Notice>
      ) : (
        <>
          <div className="mt-5">
            <KpiRow>
              <KpiTile label="Ordrer" value={formatInt(report.kpis.orders)} hint={`${formatInt(report.kpis.ordersAtPacking)} ved pakning`} />
              <KpiTile label="Elementer" value={formatInt(report.kpis.elements)} />
              <KpiTile label="Arbejdstid i alt" value={formatDuration(report.kpis.totalWorkedMs)} />
              <KpiTile
                label="Gns. tid pr. ordre"
                value={formatDuration(report.kpis.orders > 0 ? report.kpis.totalWorkedMs / report.kpis.orders : null)}
              />
            </KpiRow>
          </div>

          <SectionTitle title="Ordrer" aside={formatCount(orders.length, "ordre", "ordrer")} />
          {orders.length > 0 ? (
            <OrdersTable orders={orders} sort={{ key: sort, dir, href: sortHref }} period />
          ) : (
            <EmptyState>Ingen scanninger i perioden.</EmptyState>
          )}

          <ReadNotice read={report.read} />
        </>
      )}
    </PageShell>
  );
}
