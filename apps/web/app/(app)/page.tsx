import type { Metadata } from "next";
import { DayPicker } from "@/components/day-picker";
import { KpiRow, KpiTile } from "@/components/kpi-tile";
import { PageHeader, PageShell } from "@/components/page-shell";
import { EmptyState, OrdersTable, SectionTitle, StationsTable } from "@/components/report-tables";
import { ReadNotice } from "@/components/read-notice";
import { requireUser } from "@/lib/auth";
import { capitalize, dayKey, requestTime, formatDuration, formatInt, formatLongDay, isIsoDay } from "@/lib/time";
import { loadDayReport } from "@/lib/views";

export const metadata: Metadata = { title: "Dagsoverblik" };

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ dato?: string }>;
}) {
  const { dato } = await searchParams;
  const ctx = await requireUser(dato ? `/?dato=${dato}` : "/");

  const now = requestTime();
  const today = dayKey(now);
  const day = isIsoDay(dato) && dato <= today ? dato : today;
  const report = await loadDayReport(ctx, day, now);
  const { kpis } = report;

  return (
    <PageShell>
      <PageHeader
        title="Dagsoverblik"
        intro={
          `${capitalize(formatLongDay(day))}.${report.isToday ? " Elementer i gang tæller med op til nu." : ""}`
        }
      />

      <DayPicker day={day} today={today} />

      <div className="mt-5">
        <KpiRow>
          <KpiTile
            label="Elementer"
            value={formatInt(kpis.elements)}
            hint={kpis.inProgress > 0 ? `${kpis.inProgress} i gang nu` : undefined}
            explain="Forskellige elementer (stregkoder) scannet ind på en station i dag"
          />
          <KpiTile
            label="Ordrer pakket"
            value={formatInt(kpis.ordersPacked)}
            hint={`af ${formatInt(kpis.orders)} ordrer`}
            explain="Ordrer hvis sidste scanning er en ud-scanning på pakning, og hvor intet er i gang"
          />
          <KpiTile
            label="Gns. tid pr. element pr. station"
            value={formatDuration(kpis.averagePassMs)}
            explain="Gennemsnit af færdige passager (ind til ud) på tværs af stationer"
          />
          <KpiTile
            label="Arbejdstid i alt"
            value={formatDuration(kpis.totalWorkedMs)}
            explain="Summen af al tid fra ind til ud på alle stationer, også det der er i gang"
          />
        </KpiRow>
      </div>

      <SectionTitle title="Ordrer" aside={`${formatInt(report.orders.length)} ordrer`} />
      {report.orders.length > 0 ? (
        <OrdersTable orders={report.orders} referenceDay={day} />
      ) : (
        <EmptyState>Ingen scanninger denne dag.</EmptyState>
      )}

      <SectionTitle
        title="Stationer"
        aside={report.isToday ? "Udnyttelse: tid i arbejde siden dagens første scanning" : "Udnyttelse: tid i arbejde fra første til sidste scanning"}
      />
      {report.stations.length > 0 ? (
        <StationsTable stations={report.stations} />
      ) : (
        <EmptyState>Ingen stationer har arbejdet denne dag.</EmptyState>
      )}

      <ReadNotice read={report.read} />
    </PageShell>
  );
}
