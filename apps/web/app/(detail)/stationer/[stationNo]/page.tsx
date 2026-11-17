import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  AutoRefresh,
  DayPicker,
  EmptyState,
  KpiRow,
  KpiTile,
  Note,
  Notice,
  PageHeader,
  PageHeaderSkeleton,
  PageShell,
  SectionCard,
  SectionTitle,
} from "@optipeople/ui/blocks";
import { ExportMenu } from "@/components/export/export-menu";
import { GapsList, PassesTable } from "@/components/stations/passes-table";
import { StationStatusTag } from "@/components/stations/station-status";
import { StationTimeline } from "@/components/stations/station-timeline";
import { StationTrendChart, StationTrendTable } from "@/components/stations/station-trend";
import { TypeDistributionTable } from "@/components/stations/type-distribution";
import { ClockToggle, PageControls } from "@/components/page-controls";
import { requireCapability } from "@/lib/auth";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatSignedPercent,
  getStationDetail,
  NO_DATA,
  type TimelineInterval,
} from "@/lib/reports";
import { hrefWith, parseClock, parseDay, parseStationNo } from "@/lib/stations-view/params";
import { capitalize, dayKey, formatLongDay, formatShortDay, requestTime } from "@/lib/time";

type Search = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const TREND_WEEKS = 12;

type Claims = Parameters<typeof getStationDetail>[0];

/** "39 passager", or "40 passager, 1 uden ud-scanning". */
/** The timeline's own header counts the passes, so this only adds what it does not say. */
function passesAside(timeline: TimelineInterval[]): string | undefined {
  const missing = timeline.filter((iv) => iv.status === "missing_out").length;
  return missing > 0 ? `${missing} uden ud-scanning` : undefined;
}

export async function generateMetadata({ params }: { params: Promise<{ stationNo: string }> }): Promise<Metadata> {
  const { stationNo } = await params;
  return { title: `Station ${stationNo}` };
}

export default async function StationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ stationNo: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ stationNo: rawNo }, sp] = await Promise.all([params, searchParams]);
  const raw = { day: first(sp.day), clock: first(sp.clock) };
  const ctx = await requireCapability(hrefWith(`/stationer/${rawNo}`, raw), "reports.view");
  const stationNo = parseStationNo(rawNo);
  if (stationNo == null) notFound();

  // Everything that can answer 404 runs above this line: the Suspense below
  // starts the stream, and the status is 200 from then on.
  return (
    <Suspense fallback={<StationDetailSkeleton />}>
      <StationDetail claims={ctx.claims} stationNo={stationNo} rawDay={raw.day} clock={parseClock(raw.clock)} />
    </Suspense>
  );
}

/** The station's day, trend and type times: the slow part, streamed after the 404 check. */
async function StationDetail({
  claims,
  stationNo,
  rawDay,
  clock,
}: {
  claims: Claims;
  stationNo: number;
  rawDay: string | undefined;
  clock: ReturnType<typeof parseClock>;
}) {
  const now = requestTime();
  const today = dayKey(now);
  const { day, clamped } = parseDay(rawDay, today);
  const isToday = day === today;

  const detail = await getStationDetail(claims, { stationNo, day, weeks: TREND_WEEKS, clock });
  const { station, timeline, distribution, trend } = detail;
  const backHref = hrefWith("/stationer", { day: isToday ? undefined : day, clock });
  const period = detail.distributionPeriod;

  // Three cases. The day has passes: everything. The day is empty but the
  // trend weeks are not: one line for the day, then the weeks. The trend weeks
  // are empty too: one empty state, and the day picker to look elsewhere.
  const hasDay = station.hasData || timeline.length > 0;
  const hasTrend = trend.some((p) => p.countThrough != null);
  const hasWeeks = hasTrend || distribution.length > 0;
  const awaitsConnection = station.kind === "machine" || station.kind === "buffer";

  return (
    <PageShell width="wide">
      <PageHeader
        breadcrumbs={[{ label: "Stationer", href: backHref }, { label: station.name }]}
        eyebrow={station.kindLabel}
        title={station.name}
        intro={`${capitalize(formatLongDay(day))}.`}
        actions={
          (hasDay || hasWeeks) && (
            <ExportMenu
              entries={[
                {
                  report: "station_performance",
                  params: { from: period.from, to: period.to, stationNo, clock },
                  name: `${TREND_WEEKS} uger`,
                },
              ]}
            />
          )
        }
      >
        <StationStatusTag status={station.status} standstillSeconds={station.standstillSeconds} />
      </PageHeader>

      {!station.configured && (
        <Notice className="mb-4">
          Station nr. {stationNo} er ikke sat op under Indstillinger. Siden viser kun det, scanningerne siger.
        </Notice>
      )}

      <PageControls
        clock={
          <ClockToggle clock={detail.clock} path={`/stationer/${stationNo}`} params={{ day: isToday ? undefined : day }} />
        }
      >
        <DayPicker
          day={day}
          today={today}
          param="day"
          preserve={{ clock }}
          labels={{ previous: "Forrige dag", next: "Næste dag", date: "Dato", today: "I dag", updating: "Opdaterer…" }}
        >
          {isToday && <AutoRefresh />}
        </DayPicker>
      </PageControls>
      {clamped && <Note>Datoen lå i fremtiden og er rettet til i dag.</Note>}

      {hasDay ? (
        <>
          <div className="mt-5">
            <KpiRow>
              <KpiTile
                label={isToday ? "Gennem i dag" : "Gennem"}
                value={formatNumber(station.countThrough)}
                hint={
                  station.hasData
                    ? [
                        (station.openCount ?? 0) > 0 ? `${station.openCount} i gang` : null,
                        (station.reworkPasses ?? 0) > 0 ? `${station.reworkPasses} omarbejde` : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || undefined
                    : undefined
                }
                explain="Færdige passager, der sluttede denne dag"
              />
              <KpiTile
                label="Tid pr. stk."
                value={formatMinutes(station.timePerPiece.seconds)}
                hint={
                  station.normalSeconds == null
                    ? station.hasData
                      ? "Intet normalt sat"
                      : undefined
                    : `Normalt ${formatMinutes(station.normalSeconds)}${
                        station.deviationPercent == null ? "" : `, ${formatSignedPercent(station.deviationPercent)}`
                      }`
                }
                bad={station.status === "slower"}
                explain="Medianen af passagerne fra ind til ud, mod normaltiderne vægtet efter elementtyperne"
              />
              <KpiTile
                label="Stod stille"
                value={station.standstillSeconds === 0 ? "Ingen" : formatDuration(station.standstillSeconds)}
                hint={
                  station.longestWaitBeforeSeconds != null
                    ? `Længste ventetid før: ${formatDuration(station.longestWaitBeforeSeconds)}`
                    : undefined
                }
                bad={station.status === "stood_still"}
                explain="Pauser i vagten over grænseværdien, lagt sammen"
              />
              <KpiTile
                label="Udnyttelse"
                value={station.utilisationPercent == null ? NO_DATA : `${station.utilisationPercent} %`}
                hint={
                  (station.missingScanOutCount ?? 0) > 0 ? `${station.missingScanOutCount} mangler ud-scanning` : undefined
                }
                explain="Tid i arbejde i forhold til vagtens tid"
              />
            </KpiRow>
          </div>

          <SectionTitle title="Dagen" aside={timeline.length > 0 ? passesAside(timeline) : undefined} />
          {timeline.length === 0 ? (
            <EmptyState>Ingen passager på stationen denne dag.</EmptyState>
          ) : (
            <>
              <StationTimeline day={day} intervals={timeline} now={now} />
              {station.gaps.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[13px] font-bold leading-[18px] text-[var(--ds-grey-dark-09)]">
                    Pauser i vagten på mindst 5 min
                  </p>
                  <GapsList gaps={station.gaps} day={day} />
                </div>
              )}
              <div className="mt-4">
                <PassesTable day={day} intervals={timeline} />
              </div>
            </>
          )}
        </>
      ) : (
        <EmptyState
          className="mt-5"
          title={hasWeeks ? "Ingen passager denne dag" : `Ingen passager de ${TREND_WEEKS} uger op til denne dag`}
        >
          {awaitsConnection
            ? "Tallene kommer, når forbindelsen leverer data."
            : hasWeeks
              ? "Ugerne op til dagen står herunder."
              : "Vælg en anden dag for at se længere tilbage."}
        </EmptyState>
      )}

      {hasWeeks && (
        <div className="mt-8 grid gap-5">
          {hasTrend && (
            <SectionCard
              title={`Tid pr. stk. uge for uge, ${TREND_WEEKS} uger`}
              description="Medianen pr. uge mod det normale for den uges elementtyper."
            >
              <StationTrendChart points={trend} />
              <StationTrendTable points={trend} />
            </SectionCard>
          )}
          {distribution.length > 0 && (
            <SectionCard
              title="Tider pr. elementtype"
              description={`${capitalize(formatShortDay(period.from))} til ${formatShortDay(period.to)}`.replace(
                /\.?$/,
                "."
              )}
            >
              <TypeDistributionTable rows={distribution} />
            </SectionCard>
          )}
        </div>
      )}
    </PageShell>
  );
}

/** While the station's numbers load: header, pickers, tiles and the day, in the same places as the page. */
function StationDetailSkeleton() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-40" withActions />
      <div className="mb-4 ml-auto h-[30px] w-64 animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="h-[64px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="mt-5 grid animate-pulse grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[86px] rounded-[2px] bg-[var(--ds-grey-light-02)]" />
        ))}
      </div>
      <div className="mt-5 h-[240px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <p className="sr-only">Henter stationen…</p>
    </PageShell>
  );
}
