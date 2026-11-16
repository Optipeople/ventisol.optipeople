import { CHART_BLUE, CHART_GREY } from "@optipeople/ui/blocks";
import { Tag } from "@optipeople/ui";
import { formatDuration, NO_DATA, type StepTime } from "@/lib/reports";

type StepKey = StepTime["step"];

/**
 * The seven steps of an order as averages per order: one bar per step, work
 * and waiting side by side, on one shared scale. Assumed steps (a setting,
 * not measured) are hatched and do not count in the lead time; steps with no
 * data say so.
 */
export function StepBreakdown({ steps, bottleneck }: { steps: StepTime[]; bottleneck: StepKey | null }) {
  const max = Math.max(0, ...steps.map((s) => s.duration.seconds ?? 0));
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
        <Legend color={CHART_BLUE} label="Arbejde" />
        <Legend color={CHART_GREY} label="Ventetid" />
        <span className="flex items-center gap-[6px]">
          <span aria-hidden className="h-[10px] w-[10px] rounded-[2px] border border-dashed border-[var(--ds-grey-medium-04)]" />
          Antaget, tæller ikke med
        </span>
      </div>
      <ol className="flex flex-col gap-[10px]">
        {steps.map((s) => (
          <StepRow key={s.step} step={s} max={max} isBottleneck={s.step === bottleneck} />
        ))}
      </ol>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-[6px]">
      <span aria-hidden className="h-[10px] w-[10px] rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function StepRow({ step, max, isBottleneck }: { step: StepTime; max: number; isBottleneck: boolean }) {
  const total = step.duration.seconds;
  const work = step.work.seconds ?? 0;
  const wait = step.wait.seconds ?? 0;
  const assumed = step.source === "assumed";
  const scale = (v: number) => (max > 0 ? `${(v / max) * 100}%` : "0%");

  let value: string;
  if (total == null) value = NO_DATA;
  else if (step.countsInLead && work > 0 && wait > 0) value = `${formatDuration(total)} (venter ${formatDuration(wait)})`;
  else value = formatDuration(total);

  return (
    <li
      className={
        isBottleneck
          ? "-mx-2 rounded-[2px] border border-[var(--ds-tag-orange-dark)] bg-[var(--ds-tag-orange-light)] px-2 py-[6px]"
          : undefined
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="flex items-center gap-2 text-[13px] leading-[18px] text-[var(--ds-grey-dark-09)]">
          <span className={isBottleneck ? "font-bold" : undefined}>{step.label}</span>
          {isBottleneck && <Tag variant="warning" size="small">Flaskehals</Tag>}
          {assumed && <Tag size="small">Antaget</Tag>}
        </span>
        <span className="text-[12px] leading-[18px] tabular-nums text-[var(--ds-grey-medium-05)]">{value}</span>
      </div>
      <div className="mt-1 h-[12px] w-full" aria-hidden>
        {total != null && total > 0 &&
          (assumed || !step.countsInLead ? (
            <div
              className="h-full rounded-r-[3px] border border-dashed border-[var(--ds-grey-medium-04)]"
              style={{ width: scale(total) }}
            />
          ) : (
            <div className="flex h-full gap-[2px]" style={{ width: scale(total) }}>
              {work > 0 && <div className="h-full" style={{ flexGrow: work, flexBasis: 0, background: CHART_BLUE }} />}
              {wait > 0 && (
                <div className="h-full rounded-r-[3px]" style={{ flexGrow: wait, flexBasis: 0, background: CHART_GREY }} />
              )}
            </div>
          ))}
      </div>
    </li>
  );
}
