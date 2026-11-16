import type { Metadata } from "next";
import { Note, Notice, PageHeader, PageShell, PillTabs, SectionCard, SectionTitle } from "@optipeople/ui/blocks";
import { ExportButtons } from "@/components/export/export-buttons";
import { FreezeButton } from "@/components/management/freeze-button";
import { MonthPicker } from "@/components/management/month-picker";
import { NotesEditor } from "@/components/management/notes-editor";
import {
  BottleneckSection,
  CalcVsMeasuredTable,
  LeadTimeChart,
  LeadTimeTable,
  ManagementKpis,
  SectionHeading,
  StationsTable,
} from "@/components/management/report-sections";
import { requireCapability } from "@/lib/auth";
import {
  currentMonth,
  isMonthOver,
  monthChoices,
  monthHref,
  parseClockParam,
  parseMonthParam,
} from "@/lib/management-view/month";
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
import { freezeMonthAction, saveNotesAction } from "./actions";

export const metadata: Metadata = { title: "Ledelse" };

/** The months from the first with packed orders on; the chart still shows all twelve. */
function withoutLeadingEmpty<T extends { ordersPacked: number }>(points: T[]): T[] {
  const first = points.findIndex((p) => p.ordersPacked > 0);
  return first < 0 ? points.slice(-1) : points.slice(first);
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
    label: `${capitalize(monthTitle(`${m}-01`))}${frozenMonths.has(m) ? " (frosset)" : m === currentMonth(now) ? " (i gang)" : ""}`,
  }));
  const hrefs = Object.fromEntries(choices.map((c) => [c.month, monthHref(c.month, now, askedClock)]));
  // A snapshot is stored on the clock it was frozen with and cannot switch.
  const clock = report.clock;
  const clockLocked = result.frozen;
  const period = report.period;

  return (
    <PageShell width="wide">
      <PageHeader
        title="Ledelse"
        intro={`Månedsrapport for ${name}: nøgletal mod måneden før, gennemløbstid, flaskehals, stationer og kalkule mod målt.`}
        actions={<ExportButtons report="management_kpis" params={{ month, clock: askedClock }} pdf label="Hent" />}
      />

      <MonthPicker month={month} choices={choices} hrefs={hrefs}>
        <div>
          <p className="mb-[6px] text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em] text-[var(--ds-grey-medium-04)]">
            Tid
          </p>
          {clockLocked ? (
            <p className="text-[14px] leading-[28px] text-[var(--ds-grey-dark-09)]">
              {clock === "working" ? "Arbejdstid" : "Hele døgnet"} (frosset)
            </p>
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
      {clamped && <Note>Den valgte måned kan ikke vises. Siden viser {name} i stedet.</Note>}
      {clockLocked && askedClock && askedClock !== clock && (
        <Note>
          En frosset måned vises med den tid, den blev frosset med ({clock === "working" ? "arbejdstid" : "hele døgnet"}).
        </Note>
      )}

      <div className="mt-4">
        {result.frozen ? (
          <Notice tone="info">
            <strong>Frosset.</strong> Tallene for {name} blev låst {formatDayTime(result.frozenAt)} og ændrer sig ikke
            længere. Noterne kan stadig rettes.
          </Notice>
        ) : isCurrent ? (
          <Notice tone="warning">
            <strong>Live.</strong> {capitalize(name)} er ikke slut. Tallene er beregnet nu og ændrer sig, indtil
            måneden fryses den 1. i næste måned. Ændringerne er mod hele måneden før, så antal ordrer ligger lavt, indtil
            måneden er omme.
          </Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Notice tone="warning" className="min-w-0 flex-1">
              <strong>Ikke frosset.</strong> {capitalize(name)} er slut, men tallene er beregnet nu og kan stadig
              ændre sig.
              {canFreeze ? "" : " Månedens tal fryses automatisk den 1. i måneden efter, eller af en administrator."}
            </Notice>
            {canFreeze && <FreezeButton month={month} monthName={name} onFreeze={freezeMonthAction} />}
          </div>
        )}
      </div>

      <SectionTitle
        title={`Nøgletal, ${name}`}
        aside={`Mod måneden før. ${clock === "working" ? "Kun tid i vagterne tæller." : "Al tid tæller, også nætter og weekender."}`}
      />
      <ManagementKpis kpis={report.kpis} />

      <SectionHeading
        title="Gennemløbstid pr. ordre, måned for måned"
        actions={<ExportButtons report="monthly_lead_time" params={{ month, clock: askedClock }} />}
      />
      <SectionCard>
        <LeadTimeChart points={report.leadTimeMonthly} kind="month" />
      </SectionCard>
      <LeadTimeTable points={withoutLeadingEmpty(report.leadTimeMonthly)} kind="month" />

      <SectionTitle title={`Uge for uge i ${name}`} />
      <SectionCard>
        <LeadTimeChart points={report.leadTimeWeekly} kind="week" />
      </SectionCard>

      <SectionTitle title="Flaskehalsen: hvor går tiden pr. ordre" aside={capitalize(name)} />
      <BottleneckSection bottleneck={report.bottleneck} />

      <SectionTitle title="Stationer" aside={report.stationAttention.sentence} />
      <StationsTable stations={report.stations} />
      <Note>
        Ud-scanninger, der mangler i måneden: <strong>{formatNumber(report.missingScanOuts)}</strong>. En passage uden
        ud-scanning tæller ikke med i tiderne.
      </Note>

      {can(ctx.role, "costs.view") && (
        <>
          <SectionHeading
            title="Kalkule mod målt"
            actions={<ExportButtons report="calc_vs_measured" params={{ from: period.from, to: period.to, clock: askedClock }} />}
          />
          {report.calcVsMeasured.byElementType.length > 0 ? (
            <>
              <CalcVsMeasuredTable calc={report.calcVsMeasured} />
              <Note>
                Målt er mediantiden pr. element. Afvigelser over {report.calcVsMeasured.thresholdPercent} % i begge
                retninger er markeret. Kun stationer med både kalkule og måling tæller med.
              </Note>
            </>
          ) : (
            <Note>Ingen data endnu: der er ingen kalkulerede tider eller ingen målinger i måneden.</Note>
          )}
        </>
      )}

      <SectionTitle title="Det vigtigste og til beslutning" />
      <SectionCard>
        <NotesEditor
          month={month}
          highlights={notes.highlights}
          decisions={notes.decisions}
          updatedText={notes.updatedAt ? `Senest rettet ${formatDayTime(notes.updatedAt)}` : null}
          onSave={saveNotesAction}
        />
      </SectionCard>
    </PageShell>
  );
}
