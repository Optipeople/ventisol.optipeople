"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";

export interface PeriodPreset {
  label: string;
  from: string;
  to: string;
}

/** From/To for the period view, plus quick presets. Keeps the sort in the URL. */
export function PeriodFilter({
  from,
  to,
  today,
  earliest,
  presets,
  sort,
  dir,
}: {
  from: string;
  to: string;
  today: string;
  /** The earliest day that can be shown (earliestDay in lib/views.ts). */
  earliest: string;
  presets: PeriodPreset[];
  sort: string;
  dir: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const hrefFor = (f: string, t: string) => {
    const qs = new URLSearchParams({ fra: f, til: t, sort, retning: dir });
    return `/periode?${qs}`;
  };

  function go(next: { from?: string; to?: string }) {
    let f = next.from ?? from;
    let t = next.to ?? to;
    if (!f || !t) return;
    if (f > t) [f, t] = [t, f];
    startTransition(() => router.push(hrefFor(f, t)));
  }

  return (
    <div
      aria-busy={pending}
      className="relative rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm"
    >
      {pending && (
        <span className="absolute right-3 top-3 text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
          Opdaterer…
        </span>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DateField label="Fra" value={from} min={earliest} max={today} required onChange={(v) => go({ from: v })} />
        <DateField label="Til" value={to} min={earliest} max={today} required onChange={(v) => go({ to: v })} />
      </div>
      <div className="mt-3 flex flex-wrap gap-[6px]">
        {presets.map((p) => {
          const active = p.from === from && p.to === to;
          return (
            <Link
              key={p.label}
              href={hrefFor(p.from, p.to)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "rounded-[2px] border px-[14px] py-[5px] text-[14px] leading-[18px] transition-colors",
                active
                  ? "border-[var(--ds-midnight-green)] bg-[var(--ds-midnight-green)] font-bold text-white"
                  : "border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] text-[var(--ds-grey-dark-09)] hover:border-[var(--ds-grey-light-03)] hover:bg-[var(--ds-blue-secondary)]"
              )}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
