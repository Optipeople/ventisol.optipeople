import type { Metadata } from "next";
import { AutoRefresh, DayPicker, EmptyState, KpiRow, KpiTile, Note, Notice, PageHeader, PageShell, SectionTitle } from "@optipeople/ui/blocks";
import { OrdersTable, StationsTable } from "@/components/report-tables";
import { ReadNotice } from "@/components/read-notice";
import { requireUser } from "@/lib/auth";
import { capitalize, dayKey, requestTime, formatCount, formatDuration, formatInt, formatLongDay } from "@/lib/time";
import { earliestDay, loadDayReport, MAX_LOOKBACK_DAYS, parseDayParam } from "@/lib/views";

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
  const { day, clamped } = parseDayParam(dato, today);
  const report = await loadDayReport(ctx, day, now);
  const { kpis } = report;

  return (
    <PageShell width="wide">
      <PageHeader
        title="Dagsoverblik"
        intro={
          `${capitalize(formatLongDay(day))}.${report.isToday ? " Elementer i gang tæller med op til nu." : ""}`
        }
      />

      <DayPicker
        day={day}
        today={today}
        earliest={earliestDay(today)}
        param="dato"
        labels={{
          previous: "Forrige dag",
          next: "Næste dag",
          date: "Dato",
          today: "I dag",
          updating: "Opdaterer…",
        }}
      >
        {/* Today's numbers move while the page is open; a past day's do not. */}
        {day === today && <AutoRefresh />}
      </DayPicker>

      {clamped && <Note>Der kan vises {MAX_LOOKBACK_DAYS} dage tilbage. Datoen er rettet.</Note>}

      {report.incomplete ? (
        <Notice prominent className="mt-5">
          Der er for mange scanninger til at hente denne dag, så tallene vises ikke. Vælg en nyere dag.
        </Notice>
      ) : (
        <>
          <div className="mt-5">
            <KpiRow>
              <KpiTile
                label="Elementer"
                value={formatInt(kpis.elements)}
                hint={kpis.inProgress > 0 ? `${kpis.inProgress} i gang nu` : undefined}
                explain="Forskellige elementer (stregkoder), der er scannet ud eller er i gang denne dag"
              />
              <KpiTile
                label="Ordrer ved pakning"
                value={formatInt(kpis.ordersAtPacking)}
                hint={`af ${formatCount(kpis.orders, "ordre", "ordrer")}`}
                explain="Ordrer med mindst én ud-scanning på en pakkestation. Siger ikke, at ordren er færdigpakket"
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

          <SectionTitle title="Ordrer" aside={formatCount(report.orders.length, "ordre", "ordrer")} />
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
            <>
              <StationsTable stations={report.stations} />
              <Note>
                Tid i alt tæller hele passagen på den dag, den sluttede, også timerne før dagen. Udnyttelse tæller kun
                tiden på dagen.
              </Note>
            </>
          ) : (
            <EmptyState>Ingen stationer har arbejdet denne dag.</EmptyState>
          )}

          <ReadNotice read={report.read} />
        </>
      )}
    </PageShell>
  );
}
