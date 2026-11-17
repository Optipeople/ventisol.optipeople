import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@optipeople/ui";
import {
  CHART_GREY,
  AutoRefresh,
  BarList,
  KpiRow,
  KpiTile,
  Note,
  Notice,
  PageHeader,
  PageShell,
  PillTabs,
  SectionCard,
} from "@optipeople/ui/blocks";
import { ExportMenu } from "@/components/export/export-menu";
import { KpiChange } from "@/components/overview/kpi-change";
import { LeadTimeChart } from "@/components/overview/lead-time-chart";
import { PeriodPicker } from "@/components/overview/period-picker";
import { StepBreakdown } from "@/components/overview/step-breakdown";
import { TodayStrip } from "@/components/overview/today-strip";
import { requireCapability } from "@/lib/auth";
import { ordersHref } from "@/lib/orders-view/params";
import {
  defaultPeriod,
  filterHref,
  formatPeriod,
  parseOverviewFilters,
  periodPresets,
} from "@/lib/overview/filters";
import {
  formatCount,
  formatDuration,
  formatNumber,
  formatPercent,
  getKpiSummary,
  getLeadTimeSeries,
  joinDanish,
} from "@/lib/reports";
import { dayKey, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Overblik" };

type SearchParams = Record<string, string | string[] | undefined>;

function currentPath(sp: SearchParams): string {
  const search = new URLSearchParams();
  for (const key of ["from", "to", "clock", "bucket"]) {
    const v = sp[key];
    if (typeof v === "string") search.set(key, v);
  }
  const q = search.toString();
  return q ? `/?${q}` : "/";
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await requireCapability(currentPath(sp), "reports.view");

  const now = requestTime();
  const today = dayKey(now);
  const filters = parseOverviewFilters(sp, today);
  const { from, to, bucket } = filters;

  const [summary, series] = await Promise.all([
    getKpiSummary(ctx.claims, { from, to, now, clock: filters.clock }),
    getLeadTimeSeries(ctx.claims, { from, to, bucket, clock: filters.clock }),
  ]);
  const { kpis, bottleneck, today: todayStrip } = summary;
  const cur = kpis.current;
  // The clock the numbers were read on: the URL's, else the setting's.
  const clock = summary.clock;

  // Links into the other tabs carry the period and the clock the user chose.
  const carry = { from, to, clock: filters.clock };
  const keep = {
    clock: filters.clock,
    bucket: filters.bucketChosen ? bucket : undefined,
  };
  const selfHref = (over: Record<string, string | undefined>) =>
    filterHref("/", { from, to }, { ...keep, ...over });

  const noOrders = cur.ordersPacked === 0;
  const worstStations = bottleneck.stations.filter((s) => (s.avgWaitBefore.seconds ?? 0) > 0).slice(0, 6);

  return (
    <PageShell width="wide">
      {to === today && <AutoRefresh />}
      <PageHeader
        title="Overblik"
        intro={
          <>
            Ordrer pakket {formatPeriod(from, to)}, sammenlignet med{" "}
            {formatPeriod(kpis.previousPeriod.from, kpis.previousPeriod.to)}.{" "}
            {clock === "working" ? "Kun tid i vagterne tæller." : "Al tid tæller, også nætter og weekender."}
          </>
        }
        actions={
          <ExportMenu
            entries={[
              { report: "kpi_summary", params: { from, to, now, clock: filters.clock }, name: "Nøgletal", pdf: true },
              { report: "lead_time_series", params: { from, to, bucket, clock: filters.clock }, name: "Gennemløbstid" },
            ]}
          />
        }
      />

      <TodayStrip
        today={todayStrip}
        // rpt.today counts every order in progress, so the lists show all of them (active=all).
        lateHref={ordersHref({ view: "in-progress", status: "late", active: "all", clock: filters.clock })}
        atRiskHref={ordersHref({ view: "in-progress", status: "at_risk", active: "all", clock: filters.clock })}
      />
      <Note>
        <Link href={filterHref("/stationer", carry)} className="underline-offset-2 hover:underline">
          {summary.stationsToday.sentence}
        </Link>
      </Note>

      {/* One card for the whole filter: the period, and the clock beside it. */}
      <PeriodPicker
        className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-4"
        from={from}
        to={to}
        max={today}
        presets={periodPresets(today).map(({ label, from: f, to: t }) => ({ label, from: f, to: t }))}
        defaults={defaultPeriod(today)}
        preserve={keep}
        basePath="/"
      >
        <div>
          <p className="mb-[6px] text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em] text-[var(--ds-grey-medium-04)]">
            Tid
          </p>
          <PillTabs
            label="Tid"
            selectedId={clock}
            tabs={[
              { id: "working", label: "Arbejdstid", href: selfHref({ clock: "working" }) },
              { id: "wall", label: "Hele døgnet", href: selfHref({ clock: "wall" }) },
            ]}
          />
        </div>
      </PeriodPicker>
      {filters.correction && <Note>{filters.correction}</Note>}

      <div className="mt-6">
        <KpiRow>
          <KpiTile
            label="Gennemløbstid pr. ordre"
            value={formatDuration(cur.lead.seconds)}
            hint={<KpiChange value={kpis.change.leadPercent} unit="percent" lowerIsBetter />}
            explain="Gennemsnit fra ordrens første scanning til den er pakket"
          />
          <KpiTile
            label="Ventetid pr. ordre"
            value={formatDuration(cur.wait.seconds)}
            hint={<KpiChange value={kpis.change.waitPercent} unit="percent" lowerIsBetter />}
            explain="Gennemsnitlig tid hvor intet element fra ordren var på en station"
          />
          <KpiTile
            label="Leveret til tiden"
            value={formatPercent(cur.onTimePercent)}
            hint={<KpiChange value={kpis.change.onTimePoints} unit="points" lowerIsBetter={false} />}
            explain={`Pakket senest i leveringsugen. Tæller kun ordrer med en leveringsuge: ${cur.onTimeOrders} af ${cur.onTimeKnown}`}
          />
          <KpiTile
            label="Ordrer pakket"
            value={formatNumber(cur.ordersPacked)}
            hint={<KpiChange value={kpis.change.ordersPercent} unit="percent" lowerIsBetter={false} />}
            explain={`Ordrer pakket i perioden, i alt ${formatCount(cur.elementsPacked, "element", "elementer")}`}
          />
        </KpiRow>
      </div>

      {noOrders && (
        <Notice tone="info" className="mt-4">
          Ingen ordrer er pakket i perioden, så der er ingen gennemløbstid at vise endnu. Vælg en længere periode, eller
          se dagens tal ovenfor.
        </Notice>
      )}

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <SectionCard
          id="gennemloebstid"
          title={`Gennemløbstid pr. ordre, ${bucket === "week" ? "uge for uge" : "måned for måned"}`}
          description="Gennemsnit af de ordrer, der blev pakket i hver periode"
          action={
            <PillTabs
              label="Inddeling"
              selectedId={bucket}
              tabs={[
                { id: "week", label: "Uge", href: selfHref({ bucket: "week" }) },
                { id: "month", label: "Måned", href: selfHref({ bucket: "month" }) },
              ]}
            />
          }
        >
          <LeadTimeChart points={series} />
        </SectionCard>

        <SectionCard
          id="flaskehals"
          title="Flaskehalsen: hvor går tiden pr. ordre"
          description={`Gennemsnit pr. ordre over ${formatCount(bottleneck.ordersPacked, "pakket ordre", "pakkede ordrer")}`}
        >
          <p className="mb-1 text-[16px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">{bottleneck.sentence}</p>
          {!noOrders && bottleneck.missingSteps.length > 0 && (
            <p className="mb-3 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
              Ingen data endnu for {joinDanish(bottleneck.missingSteps)}.
            </p>
          )}
          {!noOrders && (
            <div className="mt-3">
              <StepBreakdown steps={bottleneck.steps} bottleneck={bottleneck.bottleneck?.step ?? null} />
              <p className="mt-3 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
                Gennemløbstid i alt: <span className="font-bold tabular-nums">{formatDuration(bottleneck.lead.seconds)}</span>
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      {worstStations.length > 0 && (
        <SectionCard
          id="ventetid-stationer"
          className="mt-4"
          title="Ventetid før hver station"
          description="Hvor længe et element i snit venter, fra det forlod forrige station til det kom hertil"
          action={
            <Link href={filterHref("/stationer", carry)} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              Se stationer
            </Link>
          }
        >
          <BarList
            color={CHART_GREY}
            items={worstStations.map((s) => ({
              label: s.name,
              value: s.avgWaitBefore.seconds ?? 0,
              title: `${s.name}: i snit ${formatDuration(s.avgWaitBefore.seconds)}, længst ${formatDuration(
                s.longestWaitBefore.seconds
              )} over ${formatCount(s.passes, "passage", "passager")}`,
            }))}
            formatValue={(v) => formatDuration(v)}
          />
        </SectionCard>
      )}
    </PageShell>
  );
}
