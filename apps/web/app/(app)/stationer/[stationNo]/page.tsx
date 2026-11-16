import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  AutoRefresh,
  DayPicker,
  EmptyState,
  KpiRow,
  KpiTile,
  Note,
  Notice,
  PageHeader,
  PageShell,
  SectionCard,
  SectionTitle,
} from "@optipeople/ui/blocks";
import { ExportButtons } from "@/components/export/export-buttons";
import { GapsList, PassesTable } from "@/components/stations/passes-table";
import { StationStatusTag } from "@/components/stations/station-status";
import { StationTimeline } from "@/components/stations/station-timeline";
import { StationTrendChart, StationTrendTable } from "@/components/stations/station-trend";
import { TypeDistributionTable } from "@/components/stations/type-distribution";
import { ClockToggle } from "@/components/stations/view-controls";
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

/** "39 passager", or "40 passager, 1 uden ud-scanning". */
function passesAside(timeline: TimelineInterval[]): string {
  const missing = timeline.filter((iv) => iv.status === "missing_out").length;
  const all = `${timeline.length} ${timeline.length === 1 ? "passage" : "passager"}`;
  return missing > 0 ? `${all}, ${missing} uden ud-scanning` : all;
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

  const clock = parseClock(raw.clock);
  const now = requestTime();
  const today = dayKey(now);
  const { day, clamped } = parseDay(raw.day, today);
  const isToday = day === today;

  const detail = await getStationDetail(ctx.claims, { stationNo, day, weeks: TREND_WEEKS, clock });
  const { station, timeline, distribution, trend } = detail;
  const backHref = hrefWith("/stationer", { day: isToday ? undefined : day, clock });
  const period = detail.distributionPeriod;

  return (
    <PageShell width="wide">
      <PageHeader
        breadcrumbs={[{ label: "Stationer", href: backHref }, { label: station.name }]}
        eyebrow={station.kindLabel}
        title={station.name}
        intro={`${capitalize(formatLongDay(day))}.`}
        actions={
          <ExportButtons
            report="station_performance"
            params={{ from: period.from, to: period.to, stationNo, clock }}
            label="Hent 12 uger"
          />
        }
      >
        <StationStatusTag status={station.status} />
      </PageHeader>

      {!station.configured && (
        <Notice className="mb-4">
          Station nr. {stationNo} er ikke sat op under Indstillinger. Siden viser kun det, scanningerne siger.
        </Notice>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <ClockToggle clock={detail.clock} path={`/stationer/${stationNo}`} params={{ day: isToday ? undefined : day }} />
      </div>
      <DayPicker
        day={day}
        today={today}
        param="day"
        preserve={{ clock }}
        labels={{ previous: "Forrige dag", next: "Næste dag", date: "Dato", today: "I dag", updating: "Opdaterer…" }}
      >
        {isToday && <AutoRefresh />}
      </DayPicker>
      {clamped && <Note>Datoen lå i fremtiden og er rettet til i dag.</Note>}

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
        <EmptyState>
          {station.kind === "machine" || station.kind === "buffer"
            ? `${NO_DATA}. Tallene kommer, når forbindelsen leverer data.`
            : "Ingen passager på stationen denne dag."}
        </EmptyState>
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

      <div className="mt-8 grid gap-5">
        <SectionCard
          title={`Tid pr. stk. uge for uge, ${TREND_WEEKS} uger`}
          description="Medianen pr. uge mod det normale for den uges elementtyper."
        >
          <StationTrendChart points={trend} />
        </SectionCard>
        {trend.some((p) => p.countThrough != null) && <StationTrendTable points={trend} />}

        <SectionCard
          title="Tider pr. elementtype"
          description={`${capitalize(formatShortDay(period.from))} til ${formatShortDay(period.to)}`.replace(/\.?$/, ".")}
        >
          {distribution.length === 0 ? (
            <p className="text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">{NO_DATA}</p>
          ) : (
            <TypeDistributionTable rows={distribution} />
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
