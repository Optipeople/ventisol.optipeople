import type { Metadata } from "next";
import { KpiRow, KpiTile } from "@/components/kpi-tile";
import { PageHeader, PageShell } from "@/components/page-shell";
import { PeriodFilter, type PeriodPreset } from "@/components/period-filter";
import { ReadNotice } from "@/components/read-notice";
import { EmptyState, OrdersTable, SectionTitle } from "@/components/report-tables";
import { requireUser } from "@/lib/auth";
import { ORDER_SORT_KEYS, sortOrders, type OrderSortKey } from "@/lib/report";
import {
  addDays,
  dayKey,
  daysBetween,
  formatCount,
  formatDisplayDay,
  formatDuration,
  formatInt,
  isIsoDay,
  isoWeek,
  requestTime,
  startOfWeek,
} from "@/lib/time";
import { loadPeriodReport, MAX_PERIOD_DAYS } from "@/lib/views";

export const metadata: Metadata = { title: "Periode" };

type Search = { fra?: string; til?: string; sort?: string; retning?: string };

export default async function PeriodPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string") as [string, string][]);
  const ctx = await requireUser(`/periode${qs.size ? `?${qs}` : ""}`);

  const now = requestTime();
  const today = dayKey(now);
  const weekStart = startOfWeek(today);

  // Default: this week so far. Clamp to today and to the longest period.
  let to = isIsoDay(params.til) && params.til <= today ? params.til : today;
  let from = isIsoDay(params.fra) ? params.fra : weekStart;
  if (from > to) [from, to] = [to, from];
  const clamped = daysBetween(from, to) + 1 > MAX_PERIOD_DAYS;
  if (clamped) from = addDays(to, -(MAX_PERIOD_DAYS - 1));

  const sort: OrderSortKey = ORDER_SORT_KEYS.includes(params.sort as OrderSortKey)
    ? (params.sort as OrderSortKey)
    : "total";
  const dir = params.retning === "asc" ? "asc" : "desc";

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
    <PageShell>
      <PageHeader
        title="Tid pr. ordre i en periode"
        intro={`${formatDisplayDay(from)} til ${formatDisplayDay(to)}. Tid fra passager der startede i perioden; omarbejde tæller med. Klik på en kolonne for at sortere.`}
      />

      <PeriodFilter from={from} to={to} today={today} presets={presets} sort={sort} dir={dir} />
      {clamped && (
        <p className="mt-3 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
          Perioden er kortet ned til de seneste {MAX_PERIOD_DAYS} dage.
        </p>
      )}

      <div className="mt-5">
        <KpiRow>
          <KpiTile label="Ordrer" value={formatInt(report.kpis.orders)} hint={`${formatInt(report.kpis.ordersPacked)} pakket`} />
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
    </PageShell>
  );
}
