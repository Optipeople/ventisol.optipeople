import type { ReactNode } from "react";
// The sections of the Ledelse month report. Server components: they take
// what lib/reports returned and only format it (lib/reports/format), so a
// null reads "Ingen data endnu" and never 0.

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Tag,
  type TagVariant,
} from "@optipeople/ui";
import {
  CHART_BLUE,
  CHART_GREY,
  KpiRow,
  KpiTile,
  StackedColumnChart,
  TableFrame,
  type ColumnPoint,
} from "@optipeople/ui/blocks";
import { ReportTable } from "@optipeople/ui/reports";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSignedPercent,
  monthTitle,
  NO_DATA,
  weekTitle,
  type Bottleneck,
  type CalcVsMeasured,
  type LeadTimePoint,
  type PeriodKpis,
  type StationRow,
} from "@/lib/reports";

const MOD = "mod sidste måned";

/** The change line under a KPI, or why there is none. */
function change(text: string, value: number | null): string {
  return value == null ? `Ingen sammenligning med sidste måned` : `${text} ${MOD}`;
}

/** Gennemløbstid, Ventetid, Leveret til tiden and Ordrer pakket, each against the month before. */
export function ManagementKpis({ kpis }: { kpis: PeriodKpis }) {
  const { current, change: c } = kpis;
  return (
    <KpiRow>
      <KpiTile
        label="Gennemløbstid pr. ordre"
        value={formatDuration(current.lead.seconds)}
        hint={change(formatSignedPercent(c.leadPercent), c.leadPercent)}
        explain="Gennemsnit fra ordrens første scanning til den er pakket, for ordrer pakket i måneden. Minus er hurtigere."
      />
      <KpiTile
        label="Ventetid pr. ordre"
        value={formatDuration(current.wait.seconds)}
        hint={change(formatSignedPercent(c.waitPercent), c.waitPercent)}
        explain="Den del af gennemløbstiden, hvor intet element fra ordren er på en station."
      />
      <KpiTile
        label="Leveret til tiden"
        value={formatPercent(current.onTimePercent)}
        hint={change(formatPoints(c.onTimePoints), c.onTimePoints)}
        explain={`Andel af de pakkede ordrer med en leveringsuge, der blev pakket til tiden (${formatNumber(current.onTimeOrders)} af ${formatNumber(current.onTimeKnown)}).`}
      />
      <KpiTile
        label="Ordrer pakket"
        value={formatNumber(current.ordersPacked)}
        hint={change(formatSignedPercent(c.ordersPercent), c.ordersPercent)}
        explain={`Ordrer pakket i måneden, i alt ${formatNumber(current.elementsPacked)} elementer.`}
      />
    </KpiRow>
  );
}

const HOURS = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 1 });
const toHours = (seconds: number | null) => (seconds == null ? 0 : seconds / 3600);

/** Work and waiting per order, stacked, one column per month or week. */
export function LeadTimeChart({ points, kind }: { points: LeadTimePoint[]; kind: "month" | "week" }) {
  const columns: ColumnPoint[] = points.map((p) => ({
    label: p.label,
    tooltipLabel: kind === "month" ? monthTitle(p.bucketStart) : weekTitle(p.bucketStart),
    values: [toHours(p.work.seconds), toHours(p.wait.seconds)],
  }));
  return (
    <StackedColumnChart
      series={[
        { label: "Arbejde", color: CHART_BLUE },
        { label: "Ventetid", color: CHART_GREY },
      ]}
      points={columns}
      formatValue={(h) => formatDuration(h * 3600)}
      formatTick={(h) => `${HOURS.format(h)} t`}
      height={180}
      tableCaption={kind === "month" ? "Gennemløbstid pr. ordre, måned for måned" : "Gennemløbstid pr. ordre, uge for uge"}
      rowHeader={kind === "month" ? "Måned" : "Uge"}
      emptyLabel={NO_DATA}
    />
  );
}

/**
 * The table under a lead time chart: the same numbers as text. The cells are
 * the formatted texts, and each column sorts by the number behind it.
 */
/**
 * A table inside a report card. The frame scrolls sideways when the sheet is
 * narrow, so it is a named region that the keyboard can reach and scroll.
 */
function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-[var(--ds-green-80)] print:overflow-visible"
    >
      <TableFrame className={`${IN_CARD} max-h-none overflow-visible`}>{children}</TableFrame>
    </div>
  );
}

export function LeadTimeTable({ points, kind }: { points: LeadTimePoint[]; kind: "month" | "week" }) {
  return (
    <ReportTable
      className="mt-4 print:mt-3"
      title={kind === "month" ? "Gennemløbstid pr. ordre, måned for måned" : "Gennemløbstid pr. ordre, uge for uge"}
      emptyText={NO_DATA}
      model={{
        columns: [kind === "month" ? "Måned" : "Uge", "Ordrer pakket", "Gennemløbstid", "Heraf ventetid"],
        rows: points.map((p) => [
          kind === "month" ? monthTitle(p.bucketStart) : weekTitle(p.bucketStart),
          formatNumber(p.ordersPacked),
          formatDuration(p.lead.seconds),
          formatDuration(p.wait.seconds),
        ]),
        sortKeys: points.map((p) => [Date.parse(p.bucketStart), p.ordersPacked, p.lead.seconds, p.wait.seconds]),
      }}
    />
  );
}

/** Flaskehalsen: the seven steps with their time per order, the bottleneck marked, and the sentence. */
export function BottleneckSection({ bottleneck }: { bottleneck: Bottleneck }) {
  const worst = bottleneck.bottleneck?.step;
  return (
    <div className="space-y-4 print:space-y-3">
      {/* Sized by the room it has, not the window: the report is also shown as an A4 sheet. */}
      <ol className="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-3 print:gap-2">
        {bottleneck.steps.map((s) => {
          const isWorst = s.step === worst;
          return (
            <li
              key={s.step}
              className={
                "rounded-[var(--ds-radius-surface)] border bg-[var(--color-surface)] p-4 shadow-sm print:rounded-[2px] print:p-3 " +
                (isWorst ? "border-[var(--ds-tag-red-dark)]" : "border-[var(--ds-grey-light-02)]")
              }
            >
              <p className="text-[12px] leading-[14px] font-bold text-[var(--ds-grey-medium-04)]">{s.label}</p>
              <p
                className={
                  "mt-2 text-[16px] leading-[20px] font-bold tabular-nums print:mt-1 " +
                  (isWorst ? "text-[var(--ds-red-dark)]" : "text-[var(--ds-grey-dark-09)]")
                }
              >
                {s.source === "none" ? NO_DATA : formatDuration(s.duration.seconds)}
              </p>
              {s.source === "assumed" && <p className="text-[11px] text-[var(--ds-grey-medium-05)]">antaget</p>}
              {s.source !== "none" && s.kind !== "wait" && (s.wait.seconds ?? 0) >= 60 && (
                <p className="text-[11px] text-[var(--ds-grey-medium-05)]">heraf venter {formatDuration(s.wait.seconds)}</p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">{bottleneck.sentence}</p>
      {bottleneck.missingSteps.length > 0 && (
        <p className="text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]">
          Ingen data endnu for {bottleneck.missingSteps.join(", ")}. De tæller ikke med i gennemløbstiden.
        </p>
      )}
    </div>
  );
}

// A table in a ReportWidgetCard: the card is the frame, and paper cannot scroll.
const IN_CARD =
  "rounded-none border-0 shadow-none print:max-h-none print:overflow-visible print:[&_td]:whitespace-normal print:[&_th]:whitespace-normal";

const STATUS_VARIANT: Record<StationRow["status"], TagVariant> = {
  normal: "positive",
  long_dwell: "warning",
  slower: "warning",
  stood_still: "issue",
  no_data: "default",
};

function standstill(seconds: number | null): string {
  if (seconds == null) return NO_DATA;
  return seconds === 0 ? "Ingen" : formatDuration(seconds);
}

/** Every station over the month: the ones that need attention first. */
export function StationsTable({ stations }: { stations: StationRow[] }) {
  const rank = (s: StationRow) => (s.status === "normal" ? 1 : s.status === "no_data" ? 2 : 0);
  const rows = [...stations].sort((a, b) => rank(a) - rank(b));
  return (
    <ScrollTable label="Stationer">
      <DataTable>
        <DataTableHead>
          <DataTableHeader>Station</DataTableHeader>
          <DataTableHeader align="right">Gennem</DataTableHeader>
          <DataTableHeader align="right">Tid pr. stk.</DataTableHeader>
          <DataTableHeader align="right">Normalt</DataTableHeader>
          <DataTableHeader align="right">Mod normalt</DataTableHeader>
          <DataTableHeader align="right">Stod stille</DataTableHeader>
          <DataTableHeader align="right">Mangler ud-scan</DataTableHeader>
          <DataTableHeader>Status</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {rows.map((s) => (
            <DataTableRow key={s.stationNo}>
              <DataTableCell>
                <span className="font-bold">{s.name}</span>
                <span className="block text-[12px] text-[var(--ds-grey-medium-05)]">{s.kindLabel}</span>
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {s.countThrough == null ? NO_DATA : `${formatNumber(s.countThrough)} emner`}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatMinutes(s.timePerPiece.seconds)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatMinutes(s.normalSeconds)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatSignedPercent(s.deviationPercent)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {standstill(s.standstillSeconds)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatNumber(s.missingScanOutCount)}
              </DataTableCell>
              <DataTableCell>
                <Tag size="small" variant={STATUS_VARIANT[s.status]}>
                  {s.statusLabel}
                </Tag>
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </ScrollTable>
  );
}

/** Kalkule mod målt per element type, the flagged ones marked. */
export function CalcVsMeasuredTable({ calc }: { calc: CalcVsMeasured }) {
  return (
    <ScrollTable label="Kalkule mod målt">
      <DataTable>
        <DataTableHead>
          <DataTableHeader>Elementtype</DataTableHeader>
          <DataTableHeader align="right">Gennem</DataTableHeader>
          <DataTableHeader align="right">Kalkule</DataTableHeader>
          <DataTableHeader align="right">Målt</DataTableHeader>
          <DataTableHeader align="right">Afvigelse</DataTableHeader>
          <DataTableHeader align="right">Stationer sammenlignet</DataTableHeader>
          <DataTableHeader>Vurdering</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {calc.byElementType.map((t) => (
            <DataTableRow key={t.elementTypeId}>
              <DataTableCell className="font-bold">{t.elementTypeName}</DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatNumber(t.passes)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatMinutes(t.calculatedSeconds)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatMinutes(t.measuredSeconds)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {formatSignedPercent(t.deviationPercent)}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {t.stationsIncomplete > 0
                  ? `${t.stationsCompared} af ${t.stationsCompared + t.stationsIncomplete}`
                  : formatNumber(t.stationsCompared)}
              </DataTableCell>
              <DataTableCell>
                {t.deviationPercent == null ? (
                  <Tag size="small">Mangler kalkule eller måling</Tag>
                ) : t.flagged ? (
                  <Tag size="small" variant="issue">
                    Over {calc.thresholdPercent} %
                  </Tag>
                ) : (
                  <Tag size="small" variant="positive">
                    Inden for {calc.thresholdPercent} %
                  </Tag>
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </ScrollTable>
  );
}
