import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AutoRefresh,
  EmptyState,
  Note,
  PageHeader,
  PageShell,
  SectionTitle,
} from "@optipeople/ui/blocks";
import { ExportMenu } from "@/components/export/export-menu";
import { DayField } from "@/components/day-field";
import { ClockToggle, PageControls } from "@/components/page-controls";
import { PeriodPicker } from "@/components/overview/period-picker";
import { MissingScanOutsTable } from "@/components/stations/missing-scan-outs";
import { attentionHeadline, StationBoard } from "@/components/stations/station-board";
import { StationsTable } from "@/components/stations/stations-table";
import { ViewTabs } from "@/components/stations/view-controls";
import { requireCapability } from "@/lib/auth";
import {
  formatCount,
  getStationDay,
  getStationPerformance,
  listMissingScanOuts,
  type Clock,
  type StationRow,
} from "@/lib/reports";
import {
  defaultPeriod,
  hrefWith,
  parseClock,
  parseDay,
  parsePeriod,
  parseView,
  periodPresets,
  stationHref,
} from "@/lib/stations-view/params";
import { capitalize, dayKey, formatLongDay, formatShortDay, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Stationer" };

type Search = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const INTRO = "Hver station og maskine mod det normale.";

export default async function StationsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const raw = {
    view: first(sp.view),
    day: first(sp.day),
    from: first(sp.from),
    to: first(sp.to),
    clock: first(sp.clock),
  };
  const ctx = await requireCapability(hrefWith("/stationer", raw), "reports.view");
  const view = parseView(raw);
  const clock = parseClock(raw.clock);
  const today = dayKey(requestTime());

  const tabs = {
    dayHref: hrefWith("/stationer", { clock }),
    periodHref: hrefWith("/stationer", { view: "period", clock }),
  };

  if (view === "period") {
    const period = parsePeriod(raw.from, raw.to, today);
    const report = await getStationPerformance(ctx.claims, { from: period.from, to: period.to, clock });
    // The detail page opens on the period's last day.
    const hrefFor = (row: StationRow) => stationHref(row.stationNo, { day: period.to, today, clock });
    return (
      <PageShell width="wide">
        <PageHeader
          title="Stationer"
          intro={`${INTRO} ${capitalize(formatShortDay(period.from))} til ${formatShortDay(period.to)}`.replace(/\.?$/, ".")}
          actions={
            <ExportMenu
              entries={[{ report: "station_performance", params: { from: period.from, to: period.to, clock } }]}
            />
          }
        />
        <Controls
          view="period"
          tabs={tabs}
          clock={report.clock}
          params={{ view: "period", from: period.from, to: period.to }}
        >
          <PeriodPicker
            from={period.from}
            to={period.to}
            max={today}
            preserve={{ view: "period", clock }}
            presets={periodPresets(today)}
            defaults={defaultPeriod(today)}
          />
        </Controls>
        {period.clamped && <Note>Perioden er rettet, så den ender senest i dag og højst er et år lang.</Note>}

        {report.rows.length === 0 ? (
          <NoStations />
        ) : (
          <>
            <SectionTitle title={attentionHeadline(report.attention, report.rows.length)} />
            <StationsTable rows={report.rows} mode="period" hrefFor={hrefFor} />
            <Explain clock={report.clock} period />
          </>
        )}
      </PageShell>
    );
  }

  const { day, clamped } = parseDay(raw.day, today);
  const isToday = day === today;
  const [report, missing] = await Promise.all([
    getStationDay(ctx.claims, { day, clock }),
    listMissingScanOuts(ctx.claims, { from: day, to: day, pageSize: 50 }),
  ]);
  const hrefFor = (row: StationRow) => stationHref(row.stationNo, { day, today, clock });

  return (
    <PageShell width="wide">
      <PageHeader
        title="Stationer"
        intro={`${INTRO} ${capitalize(formatLongDay(day))}.`}
        actions={<ExportMenu entries={[{ report: "station_day", params: { day, clock } }]} />}
      />
      <Controls view="day" tabs={tabs} clock={report.clock} params={{ day: isToday ? undefined : day }}>
        <DayField
          day={day}
          today={today}
          preserve={{ clock }}
        >
          {/* Today's numbers move while the page is open; a past day's do not. */}
          {isToday && <AutoRefresh />}
        </DayField>
      </Controls>
      {clamped && <Note>Datoen lå i fremtiden og er rettet til i dag.</Note>}

      {report.rows.length === 0 ? (
        <NoStations />
      ) : (
        <>
          <div className="mt-6">
            <StationBoard
              rows={report.rows}
              attention={report.attention}
              hrefFor={hrefFor}
              caption={isToday ? "Opdateres automatisk hvert minut" : capitalize(formatShortDay(day))}
            />
          </div>

          <SectionTitle title="Alle tal" />
          <StationsTable rows={report.rows} mode="day" hrefFor={hrefFor} />
          <Explain clock={report.clock} />

          {/* Nothing missing: no heading and no empty box. */}
          {missing.total > 0 && (
            <>
              <SectionTitle title="Mangler ud-scanning" aside={formatCount(missing.total, "passage", "passager")} />
              <MissingScanOutsTable rows={missing.rows} day={day} />
              {missing.rows.some((r) => r.kind === "auto_stopped") && (
                <Note>
                  Auto-stop: stationen stoppede elementet ved vagtskifte, fordi det ikke blev scannet ud. Tiden tæller
                  med frem til stoppet. Mangler ud-scanning tæller ikke med i nogen tid.
                </Note>
              )}
              {missing.total > missing.rows.length && (
                <Note>
                  Viser de {missing.rows.length} nyeste af {missing.total}.
                </Note>
              )}
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

function Controls({
  view,
  tabs,
  clock,
  params,
  children,
}: {
  view: "day" | "period";
  tabs: { dayHref: string; periodHref: string };
  clock: Clock;
  params: Record<string, string | undefined>;
  /** The day or period picker, after the tabs. */
  children: ReactNode;
}) {
  return (
    <PageControls clock={<ClockToggle clock={clock} path="/stationer" params={params} />}>
      <div className="flex h-[40px] items-center">
        <ViewTabs view={view} {...tabs} />
      </div>
      {children}
    </PageControls>
  );
}

function NoStations() {
  return (
    <EmptyState title="Ingen stationer endnu" className="mt-6">
      Der er ingen aktive stationer. De oprettes under{" "}
      <Link href="/indstillinger/stationer" className="underline">
        Indstillinger, Stationer
      </Link>
      .
    </EmptyState>
  );
}

function Explain({ clock, period = false }: { clock: Clock; period?: boolean }) {
  return (
    <Note>
      Tid pr. stk. er medianen af passagerne fra ind til ud. Normalt er normaltiderne vægtet efter de elementtyper, der
      kom igennem. Stod stille er pauser i vagten over grænseværdien, lagt sammen. Stationen får først mærket, når de fylder
      mindst en tiendedel af vagten indtil nu. Udnyttelse er tid i arbejde i forhold
      til vagtens tid.{" "}
      {clock === "working" ? "Kun tid i vagterne tæller." : "Al tid tæller, også nætter og weekender."}
      {period ? " Ventetid før er tiden fra elementets forrige ud-scanning til ind-scanningen her." : ""}
    </Note>
  );
}
