import type { TimelineDay, WorkInterval } from "@/lib/report";
import { positionLabel } from "@/lib/scans";
import { formatClock, formatDuration, formatLongDay } from "@/lib/time";
import { cn } from "@/lib/utils";

// The order as a timeline: one block per day it was worked, one lane per
// station, a bar per pass from In to Out. Plain positioned divs, rendered on
// the server; the bar's title carries the details on hover.

const HOUR = 3_600_000;

function barTitle(iv: WorkInterval): string {
  const lines = [
    `${positionLabel(iv.position, iv.subPosition)}, stk. ${iv.piece ?? "–"} (${iv.barcode})`,
    `${iv.station}: ${formatClock(iv.start)}–${iv.inProgress ? "nu" : formatClock(iv.end)}, ${formatDuration(iv.durationMs)}`,
  ];
  if (iv.visit > 1) lines.push(`Omarbejde (gang nr. ${iv.visit} på stationen)`);
  if (iv.inProgress) lines.push("I gang");
  if (iv.startEstimated) lines.push("Starttid regnet ud fra varigheden");
  return lines.join("\n");
}

function Bar({ iv, axisStart, span }: { iv: WorkInterval; axisStart: number; span: number }) {
  const left = ((iv.start - axisStart) / span) * 100;
  const width = Math.max(((iv.end - iv.start) / span) * 100, 0);
  return (
    <div
      title={barTitle(iv)}
      className={cn(
        "absolute top-[5px] bottom-[5px] min-w-[3px] rounded-[2px] border",
        iv.inProgress
          ? "border-[var(--ds-orange-darkest)] bg-[repeating-linear-gradient(135deg,var(--ds-orange)_0_6px,var(--ds-tag-orange-light)_6px_12px)]"
          : iv.visit > 1
            ? "border-[var(--ds-red-dark)] bg-[var(--ds-red)]"
            : "border-[#0c2f2f] bg-[var(--ds-midnight-green)] hover:bg-[#1d5c5c]"
      )}
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );
}

function DayBlock({ day }: { day: TimelineDay }) {
  const span = day.axisEnd - day.axisStart;
  const hours = Array.from({ length: Math.round(span / HOUR) + 1 }, (_, i) => day.axisStart + i * HOUR);
  // Thin out the hour labels on long days so they never collide.
  const labelEvery = hours.length > 14 ? 2 : 1;

  return (
    <section className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-bold leading-[20px] text-[var(--ds-grey-dark-09)] first-letter:uppercase">
          {formatLongDay(day.day)}
        </h3>
        <p className="text-[13px] leading-[18px] tabular-nums text-[var(--ds-grey-medium-05)]">
          {formatClock(day.lanes.flatMap((l) => l.bars).reduce((m, b) => Math.min(m, b.start), Infinity))}
          {"–"}
          {formatClock(day.lanes.flatMap((l) => l.bars).reduce((m, b) => Math.max(m, b.end), 0))}
          {" · "}
          <span className="font-bold text-[var(--ds-grey-dark-09)]">{formatDuration(day.totalMs)}</span>
        </p>
      </header>

      <div className="grid grid-cols-[110px_1fr_64px] items-stretch gap-x-3 sm:grid-cols-[140px_1fr_80px]">
        {/* Hour axis */}
        <div />
        <div className="relative h-[18px]">
          {hours.map((h, i) =>
            i % labelEvery === 0 ? (
              <span
                key={h}
                className="absolute -translate-x-1/2 text-[11px] leading-[14px] tabular-nums text-[var(--ds-grey-medium-04)]"
                style={{ left: `${((h - day.axisStart) / span) * 100}%` }}
              >
                {formatClock(h)}
              </span>
            ) : null
          )}
        </div>
        <div />

        {day.lanes.map((lane) => (
          <div key={lane.station} className="contents">
            <div className="flex items-center truncate border-t border-[var(--ds-grey-light-02)] text-[13px] leading-[18px] font-bold text-[var(--ds-grey-dark-09)]">
              {lane.station}
            </div>
            <div className="relative h-[30px] border-t border-[var(--ds-grey-light-02)] bg-[var(--ds-grey-light-01)]">
              {hours.map((h) => (
                <span
                  key={h}
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-[var(--ds-grey-light-02)]"
                  style={{ left: `${((h - day.axisStart) / span) * 100}%` }}
                />
              ))}
              {lane.bars.map((iv) => (
                <Bar key={`${iv.barcode}-${iv.start}`} iv={iv} axisStart={day.axisStart} span={span} />
              ))}
            </div>
            <div className="flex items-center justify-end border-t border-[var(--ds-grey-light-02)] text-[13px] leading-[18px] tabular-nums text-[var(--ds-grey-medium-05)]">
              {formatDuration(lane.totalMs)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Timeline({ days }: { days: TimelineDay[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">
        <LegendSwatch className="border-[#0c2f2f] bg-[var(--ds-midnight-green)]" label="Ind til ud" />
        <LegendSwatch className="border-[var(--ds-red-dark)] bg-[var(--ds-red)]" label="Omarbejde" />
        <LegendSwatch
          className="border-[var(--ds-orange-darkest)] bg-[repeating-linear-gradient(135deg,var(--ds-orange)_0_4px,var(--ds-tag-orange-light)_4px_8px)]"
          label="I gang"
        />
        <span>Hold musen over en bjælke for detaljer.</span>
      </div>
      {days.map((day) => (
        <DayBlock key={day.day} day={day} />
      ))}
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-[6px]">
      <span aria-hidden className={cn("inline-block h-[10px] w-[18px] rounded-[2px] border", className)} />
      {label}
    </span>
  );
}
