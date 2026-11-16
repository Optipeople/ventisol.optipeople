import type { Metadata } from "next";
import Link from "next/link";
import {
  AutoRefresh,
  DayPicker,
  EmptyState,
  Note,
  PageHeader,
  PageShell,
  PeriodFilter,
  SectionTitle,
} from "@optipeople/ui/blocks";
import { ExportButtons } from "@/components/export/export-buttons";
import { MissingScanOutsTable } from "@/components/stations/missing-scan-outs";
import { StationBoard } from "@/components/stations/station-board";
import { StationsTable } from "@/components/stations/stations-table";
import { ClockToggle, ViewTabs } from "@/components/stations/view-controls";
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
            <ExportButtons
              report="station_performance"
              params={{ from: period.from, to: period.to, clock }}
              label="Hent"
            />
          }
        />
        <Controls
          view="period"
          tabs={tabs}
          clock={report.clock}
          params={{ view: "period", from: period.from, to: period.to }}
        />
        <PeriodFilter
          from={period.from}
          to={period.to}
          max={today}
          required
          preserve={{ view: "period", clock }}
          presets={periodPresets(today)}
          defaults={defaultPeriod(today)}
          labels={{ from: "Fra", to: "Til", reset: "Tilbage til denne uge", updating: "Opdaterer…" }}
        />
        {period.clamped && <Note>Perioden er rettet, så den ender senest i dag og højst er et år lang.</Note>}

        {report.rows.length === 0 ? (
          <NoStations />
        ) : (
          <>
            <SectionTitle
              title={report.attention.sentence}
              aside={`${formatCount(report.rows.length, "station", "stationer")} · ${clockWords(report.clock)}`}
            />
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
        actions={<ExportButtons report="station_day" params={{ day, clock }} label="Hent" />}
      />
      <Controls view="day" tabs={tabs} clock={report.clock} params={{ day: isToday ? undefined : day }} />
      <DayPicker
        day={day}
        today={today}
        param="day"
        preserve={{ clock }}
        labels={{ previous: "Forrige dag", next: "Næste dag", date: "Dato", today: "I dag", updating: "Opdaterer…" }}
      >
        {/* Today's numbers move while the page is open; a past day's do not. */}
        {isToday && <AutoRefresh />}
      </DayPicker>
      {clamped && <Note>Datoen lå i fremtiden og er rettet til i dag.</Note>}

      {report.rows.length === 0 ? (
        <NoStations />
      ) : (
        <>
          <div className="mt-5">
            <StationBoard
              rows={report.rows}
              attention={report.attention}
              hrefFor={hrefFor}
              caption={isToday ? "I dag, opdateres hvert minut" : capitalize(formatShortDay(day))}
            />
          </div>

          <SectionTitle
            title="Alle tal"
            aside={`${formatCount(report.rows.length, "station", "stationer")} · ${clockWords(report.clock)}`}
          />
          <StationsTable rows={report.rows} mode="day" hrefFor={hrefFor} />
          <Explain clock={report.clock} />

          <SectionTitle
            title="Mangler ud-scanning"
            aside={missing.total > 0 ? formatCount(missing.total, "passage", "passager") : undefined}
          />
          {missing.total === 0 ? (
            <EmptyState>Alt, der blev scannet ind denne dag, er scannet ud eller stadig i gang.</EmptyState>
          ) : (
            <>
              <MissingScanOutsTable rows={missing.rows} day={day} />
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

function clockWords(clock: Clock): string {
  return clock === "wall" ? "hele døgnet tæller" : "kun arbejdstid tæller";
}

function Controls({
  view,
  tabs,
  clock,
  params,
}: {
  view: "day" | "period";
  tabs: { dayHref: string; periodHref: string };
  clock: Clock;
  params: Record<string, string | undefined>;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <ViewTabs view={view} {...tabs} />
      <ClockToggle clock={clock} path="/stationer" params={params} />
    </div>
  );
}

function NoStations() {
  return (
    <EmptyState title="Ingen stationer endnu" className="mt-5">
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
      kom igennem. Stod stille er pauser i vagten over grænseværdien, lagt sammen. Udnyttelse er tid i arbejde i forhold
      til vagtens tid.{" "}
      {clock === "working" ? "Kun tid i vagterne tæller." : "Al tid tæller, også nætter og weekender."}
      {period ? " Ventetid før er tiden fra elementets forrige ud-scanning til ind-scanningen her." : ""}
    </Note>
  );
}
