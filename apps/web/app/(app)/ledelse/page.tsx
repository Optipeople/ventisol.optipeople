import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Note, Notice, PageShell, PillTabs } from "@optipeople/ui/blocks";
import {
  REPORT_CUSTOM_RANGE,
  ReportFrame,
  ReportHeader,
  ReportPeriodBadge,
  ReportWidgetCard,
} from "@optipeople/ui/reports";
import { aiConfigured } from "@/app/api/chat/config";
import { ExportMenu, type ExportEntry } from "@/components/export/export-menu";
import { FreezeButton } from "@/components/management/freeze-button";
import { MonthPicker } from "@/components/management/month-picker";
import { NotesEditor } from "@/components/management/notes-editor";
import {
  BottleneckSection,
  CalcVsMeasuredTable,
  LeadTimeChart,
  LeadTimeTable,
  ManagementKpis,
  StationsTable,
} from "@/components/management/report-sections";
import { ReportSheet } from "@/components/management/report-sheet";
import { requireCapability } from "@/lib/auth";
import {
  currentMonth,
  isMonthOver,
  monthChoices,
  monthHref,
  parseClockParam,
  parseMonthParam,
} from "@/lib/management-view/month";
import { DRAFT_MESSAGES } from "@/lib/management-view/draft";
import { can, hasAnyRole } from "@/lib/portal/roles";
import {
  formatDayTime,
  formatNumber,
  getManagementNotes,
  getMonthReport,
  listSnapshots,
  monthTitle,
} from "@/lib/reports";
import { capitalize, requestTime } from "@/lib/time";
import { draftNotesAction, freezeMonthAction, saveNotesAction } from "./actions";

export const metadata: Metadata = { title: "Ledelse" };

/** The months from the first with packed orders on; the chart still shows all twelve. */
function withoutLeadingEmpty<T extends { ordersPacked: number }>(points: T[]): T[] {
  const first = points.findIndex((p) => p.ordersPacked > 0);
  return first < 0 ? points.slice(-1) : points.slice(first);
}

/** The line of context at the top of a card. */
function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">{children}</p>;
}

export default async function ManagementPage({
  searchParams,
}: {
  searchParams: Promise<{ maaned?: string | string[]; clock?: string | string[] }>;
}) {
  const sp = await searchParams;
  const keep = new URLSearchParams();
  for (const key of ["maaned", "clock"] as const) {
    const v = sp[key];
    if (typeof v === "string" && v) keep.set(key, v);
  }
  const query = keep.toString();
  const ctx = await requireCapability(query ? `/ledelse?${query}` : "/ledelse", "ledelse.view");

  const now = requestTime();
  const { month, clamped } = parseMonthParam(sp.maaned, now);
  const askedClock = parseClockParam(sp.clock);
  const firstDay = `${month}-01`;
  const name = monthTitle(firstDay);

  // A frozen month reads its snapshot; any other month is computed now. The
  // notes are always read live: they are written after the month has ended.
  const [result, notes, snapshots] = await Promise.all([
    getMonthReport(ctx.claims, { month, now, clock: askedClock }),
    getManagementNotes(ctx.claims, { month }),
    listSnapshots(ctx.claims),
  ]);
  const { report } = result;
  const frozenMonths = new Set(snapshots.map((s) => s.month.slice(0, 7)));
  const isCurrent = month === currentMonth(now);
  const over = isMonthOver(month, now);
  const canFreeze = over && !result.frozen && hasAnyRole(ctx.role, ["admin"]);

  const choices = monthChoices(now).map((m) => ({
    month: m,
    label: `${capitalize(monthTitle(`${m}-01`))}${frozenMonths.has(m) ? " (låst)" : m === currentMonth(now) ? " (i gang)" : ""}`,
  }));
  const hrefs = Object.fromEntries(choices.map((c) => [c.month, monthHref(c.month, now, askedClock)]));
  // A snapshot is stored on the clock it was frozen with and cannot switch.
  const clock = report.clock;
  const clockLocked = result.frozen;
  const period = report.period;

  // Every file of the page, in the one "Download" menu of the header.
  const exports: ExportEntry[] = [
    { report: "management_kpis", params: { month, clock: askedClock }, name: "Månedsrapport", pdf: true },
    { report: "monthly_lead_time", params: { month, clock: askedClock }, name: "Gennemløbstid pr. måned" },
  ];
  if (can(ctx.role, "costs.view")) {
    exports.push({
      report: "calc_vs_measured",
      params: { from: period.from, to: period.to, clock: askedClock },
      name: "Kalkule mod målt",
    });
  }

  const clockName = clock === "working" ? "Arbejdstid" : "Hele døgnet";

  const toolbar = (
    <MonthPicker month={month} choices={choices} hrefs={hrefs}>
      <div>
        <p className="mb-[6px] text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em] text-[var(--ds-grey-medium-04)]">
          Tid
        </p>
        {clockLocked ? (
          <p className="text-[14px] leading-[28px] text-[var(--ds-grey-dark-09)]">{clockName} (låst)</p>
        ) : (
          <PillTabs
            label="Tid"
            selectedId={clock}
            tabs={[
              { id: "working", label: "Arbejdstid", href: monthHref(month, now, "working") },
              { id: "wall", label: "Hele døgnet", href: monthHref(month, now, "wall") },
            ]}
          />
        )}
      </div>
    </MonthPicker>
  );

  return (
    <PageShell width="wide">
      <ReportSheet>
        <ReportFrame
          header={
            <ReportHeader
              title="Ledelse"
              subtitle={`Månedsrapport for ${name}.`}
              actions={<ExportMenu entries={exports} />}
            />
          }
          toolbar={toolbar}
          // The days and the clock of the report. Printed, which the toolbar is not.
          periodRow={
            <ReportPeriodBadge
              value={{ preset: REPORT_CUSTOM_RANGE, from: period.from, to: period.to }}
              zoneLabel={clockName}
            />
          }
        >
          {clamped && <Note className="mt-0 mb-3">Den valgte måned kan ikke vises. Siden viser {name} i stedet.</Note>}
          {clockLocked && askedClock && askedClock !== clock && (
            <Note className="mt-0 mb-3">
              En låst måned vises med den tid, den blev låst med ({clock === "working" ? "arbejdstid" : "hele døgnet"}).
            </Note>
          )}

          <div className="mb-4">
            {result.frozen ? (
              <Notice tone="info">
                <strong>Låste tal.</strong> Tallene for {name} blev gemt {formatDayTime(result.frozenAt)} og ændrer sig
                ikke længere, heller ikke ved sene scanninger eller rettelser. Noterne kan stadig rettes.
              </Notice>
            ) : isCurrent ? (
              <Notice tone="warning">
                <strong>Foreløbige tal.</strong> {capitalize(name)} er ikke slut, så tallene ændrer sig dag for dag. De
                låses automatisk den 1. i næste måned. Ændringerne er mod hele måneden før, så antal ordrer ligger lavt,
                indtil måneden er omme.
              </Notice>
            ) : (
              <Notice
                tone="warning"
                actions={
                  canFreeze ? <FreezeButton month={month} monthName={name} onFreeze={freezeMonthAction} /> : undefined
                }
              >
                <strong>Foreløbige tal.</strong> {capitalize(name)} er slut, men sene scanninger og rettelser kan stadig
                ændre tallene. Når måneden låses, gemmes tallene, som de er, så rapporten ikke ændrer sig bagefter.
                {canFreeze ? "" : " Det sker automatisk den 1. i måneden efter, eller når en administrator gør det."}
              </Notice>
            )}
          </div>

          <ReportWidgetCard title={`Nøgletal, ${name}`}>
            <Lead>{clock === "working" ? "Kun tid i vagterne tæller." : "Al tid tæller, også nætter og weekender."}</Lead>
            <ManagementKpis kpis={report.kpis} />
          </ReportWidgetCard>

          <ReportWidgetCard title="Gennemløbstid pr. ordre, måned for måned">
            <LeadTimeChart points={report.leadTimeMonthly} kind="month" />
            <LeadTimeTable points={withoutLeadingEmpty(report.leadTimeMonthly)} kind="month" />
          </ReportWidgetCard>

          <ReportWidgetCard title={`Uge for uge i ${name}`}>
            <LeadTimeChart points={report.leadTimeWeekly} kind="week" />
          </ReportWidgetCard>

          <ReportWidgetCard
            title={`Flaskehalsen: hvor går tiden pr. ordre, ${name}`}
          >
            <BottleneckSection bottleneck={report.bottleneck} />
          </ReportWidgetCard>

          <ReportWidgetCard title="Stationer">
            {report.stationAttention.sentence && <Lead>{report.stationAttention.sentence}</Lead>}
            <StationsTable stations={report.stations} />
            <Note>
              Ud-scanninger, der mangler i måneden: <strong>{formatNumber(report.missingScanOuts)}</strong>. En passage
              uden ud-scanning tæller ikke med i tiderne.
            </Note>
          </ReportWidgetCard>

          {can(ctx.role, "costs.view") && (
            <ReportWidgetCard title="Kalkule mod målt">
              {report.calcVsMeasured.byElementType.length > 0 ? (
                <>
                  <CalcVsMeasuredTable calc={report.calcVsMeasured} />
                  <Note>
                    Målt er mediantiden pr. element. Afvigelser over {report.calcVsMeasured.thresholdPercent} % i begge
                    retninger er markeret. Kun stationer med både kalkule og måling tæller med.
                  </Note>
                </>
              ) : (
                <Note className="mt-0">
                  Ingen data endnu: der er ingen kalkulerede tider eller ingen målinger i måneden.
                </Note>
              )}
            </ReportWidgetCard>
          )}

          <ReportWidgetCard title="Det vigtigste og til beslutning">
            <NotesEditor
              month={month}
              highlights={notes.highlights}
              decisions={notes.decisions}
              updatedText={notes.updatedAt ? `Senest rettet ${formatDayTime(notes.updatedAt)}` : null}
              onSave={saveNotesAction}
              onDraft={draftNotesAction}
              draftDisabledReason={aiConfigured() ? null : DRAFT_MESSAGES.notConfigured}
            />
          </ReportWidgetCard>
        </ReportFrame>
      </ReportSheet>
    </PageShell>
  );
}
