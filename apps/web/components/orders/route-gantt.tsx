// The route of one order as a Gantt: a lane per step, Arbejde / Ventetid /
// Afvigelse, the "Nu" line while in progress and the forecast. The geometry
// is lib/orders-view/gantt.ts; this file only draws it. A table with the same
// numbers can be opened under it (StepsTable), so nothing is in the chart alone.

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import { ganttLayout, type GanttTone } from "@/lib/orders-view/gantt";
import { formatDayTime, formatDuration, formatForecast, NO_DATA } from "@/lib/reports/format";
import type { OrderHeader, OrderStep } from "@/lib/reports/types";
import { formatDateTime } from "@/lib/time";

const TONE_CLASS: Record<GanttTone, string> = {
  work: "bg-[var(--ds-midnight-green)] border-[var(--ds-midnight-green)]",
  wait: "bg-[var(--ds-tag-orange-light)] border-[var(--ds-tag-orange-dark)]",
  deviation: "bg-[var(--ds-red)] border-[var(--ds-red-dark)]",
};

const TONE_LABEL: Record<GanttTone, string> = { work: "Arbejde", wait: "Ventetid", deviation: "Afvigelse" };

function sourceText(step: OrderStep): string {
  if (step.source === "none") return "Ingen data endnu";
  if (step.source === "assumed") return "Antaget, ikke målt";
  return "Ikke nået endnu";
}

export function RouteGantt({ order, steps, now }: { order: OrderHeader; steps: OrderStep[]; now: number }) {
  const g = ganttLayout(order, steps, now);
  const byStep = new Map(steps.map((s) => [s.step, s]));

  return (
    <div className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-6 shadow-sm">
      <div className="grid grid-cols-[150px_1fr_110px] gap-x-3 text-[14px] leading-[20px]">
        {/* Tick row */}
        <div />
        <div className="relative h-[20px] text-[11px] text-[var(--ds-grey-medium-05)]">
          {g.ticks.map((t) => (
            <span key={t.at} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${t.left}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <div />

        {g.lanes.map((lane) => {
          const step = byStep.get(lane.step as OrderStep["step"])!;
          const bar = lane.bar;
          const title = bar
            ? [
                `${lane.label}: ${TONE_LABEL[bar.tone]}${bar.open ? ", i gang" : ""}`,
                `${formatDateTime(bar.start)} til ${bar.open ? "nu" : formatDateTime(bar.end)}`,
                `Tid: ${formatDuration(step.duration.seconds)}`,
                step.kind === "work" && step.wait.seconds ? `Heraf ventetid: ${formatDuration(step.wait.seconds)}` : "",
              ]
                .filter(Boolean)
                .join("\n")
            : `${lane.label}: ${sourceText(step)}`;
          return (
            <div key={lane.step} className="contents">
              <div
                className={`flex h-[34px] items-center truncate ${lane.kind === "wait" ? "text-[var(--ds-grey-medium-05)]" : "font-bold text-[var(--ds-grey-dark-09)]"}`}
              >
                {lane.label}
              </div>
              <div className="relative h-[34px] border-b border-[var(--ds-grey-light-02)]">
                {g.ticks.map((t) => (
                  <span
                    key={t.at}
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-[var(--ds-grey-light-02)]"
                    style={{ left: `${t.left}%` }}
                  />
                ))}
                {bar ? (
                  <span
                    title={title}
                    className={`absolute top-[8px] h-[18px] rounded-[2px] border ${TONE_CLASS[bar.tone]} ${bar.open ? "border-r-0 opacity-80" : ""}`}
                    style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  />
                ) : (
                  <span className="absolute left-1 top-[8px] text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]" title={title}>
                    {sourceText(step)}
                  </span>
                )}
                {g.nowAt != null && (
                  <span aria-hidden className="absolute inset-y-0 w-[2px] bg-[var(--ds-blue-primary)]" style={{ left: `${g.nowAt}%` }} />
                )}
                {g.forecastAt != null && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 border-l-2 border-dashed border-[var(--ds-grey-medium-05)]"
                    style={{ left: `${g.forecastAt}%` }}
                  />
                )}
              </div>
              <div className="flex h-[34px] items-center justify-end tabular-nums text-[var(--ds-grey-dark-09)]">
                {step.duration.seconds != null ? formatDuration(step.duration.seconds) : ""}
              </div>
            </div>
          );
        })}

        {/* Marker labels */}
        <div />
        {/* Two rows, so "Nu" and "Forventet klar" never print over each other. */}
        <div className="relative h-[36px] text-[11px] font-bold leading-[16px]">
          {g.nowAt != null && (
            <span className="absolute top-0 -translate-x-1/2 text-[var(--ds-blue-primary)]" style={{ left: `${g.nowAt}%` }}>
              Nu
            </span>
          )}
          {g.forecastAt != null && (
            <span
              className="absolute top-[18px] -translate-x-full whitespace-nowrap pr-1 text-[var(--ds-grey-medium-05)]"
              style={{ left: `${g.forecastAt}%` }}
            >
              Forventet klar {formatForecast(order.forecastReadyAt)}
            </span>
          )}
        </div>
        <div />
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
        {(["work", "wait", "deviation"] as const).map((tone) => (
          <li key={tone} className="flex items-center gap-[6px]">
            <span aria-hidden className={`inline-block h-[10px] w-[16px] rounded-[2px] border ${TONE_CLASS[tone]}`} />
            {TONE_LABEL[tone]}
          </li>
        ))}
        {g.nowAt != null && (
          <li className="flex items-center gap-[6px]">
            <span aria-hidden className="inline-block h-[12px] w-[2px] bg-[var(--ds-blue-primary)]" />
            Nu
          </li>
        )}
        <li>Hold musen over en bjælke for tider.</li>
      </ul>
      {order.status === "in_progress" && order.forecastReadyAt == null && (
        <p className="mt-2 text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
          Ingen prognose endnu: der mangler typiske tider for stationerne.
        </p>
      )}
    </div>
  );
}

/**
 * The same steps as a table: the chart's text equivalent, closed until asked
 * for. A step without a time says why once, in the last column, in the
 * chart's words.
 */
export function StepsTable({ steps }: { steps: OrderStep[] }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[14px] font-bold leading-[21px] text-[var(--ds-midnight-green)]">
        Vis trinene som tabel
      </summary>
      <div className="mt-4">
        <StepsTableBody steps={steps} />
      </div>
    </details>
  );
}

function StepsTableBody({ steps }: { steps: OrderStep[] }) {
  return (
    <TableFrame>
      <DataTable>
        <DataTableHead>
          <DataTableHeader>Trin</DataTableHeader>
          <DataTableHeader>Fra</DataTableHeader>
          <DataTableHeader>Til</DataTableHeader>
          <DataTableHeader align="right">Tid</DataTableHeader>
          <DataTableHeader align="right">Arbejde</DataTableHeader>
          <DataTableHeader align="right">Ventetid</DataTableHeader>
          <DataTableHeader>Kilde</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {steps.map((s) => {
            const reached = s.duration.seconds != null || s.startAt != null;
            return (
              <DataTableRow key={s.step} className={s.deviation ? "bg-[var(--ds-red-bg)]" : undefined}>
                <DataTableCell className={s.kind === "work" ? "font-bold" : undefined}>
                  {s.label}
                  {s.isOpen && <span className="ml-2 text-[12px] text-[var(--ds-blue-primary)]">i gang</span>}
                  {s.deviation && <span className="ml-2 text-[12px] text-[var(--ds-red-dark)]">afvigelse</span>}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">{s.startAt ? formatDayTime(s.startAt) : ""}</DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {s.isOpen ? "nu" : s.endAt ? formatDayTime(s.endAt) : ""}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {s.duration.seconds != null ? formatDuration(s.duration.seconds) : ""}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {s.kind === "work" && s.work.seconds != null ? formatDuration(s.work.seconds) : ""}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {s.wait.seconds != null ? formatDuration(s.wait.seconds) : ""}
                </DataTableCell>
                <DataTableCell className="text-[var(--ds-grey-medium-05)]">
                  {!reached
                    ? sourceText(s)
                    : s.source === "scans"
                      ? "Scanninger"
                      : s.source === "machine"
                        ? "Maskine"
                        : s.source === "assumed"
                          ? "Antaget"
                          : NO_DATA}
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
