"use client";

import { useMemo, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DateRangePicker, type DateRangePreset } from "@optipeople/ui";
import { FilterPanel } from "@optipeople/ui/blocks";

export interface PeriodPickerPreset {
  label: string;
  /** ISO yyyy-MM-dd. */
  from: string;
  to: string;
}

/**
 * The period a page shows, kept in the URL as from and to: the date range
 * field of the backoffice reports, with the page's presets in its rail. The
 * page's default period is the bare URL, so picking it drops both dates.
 */
export function PeriodPicker({
  from,
  to,
  max,
  presets,
  defaults,
  preserve,
  basePath,
  label = "Periode",
  children,
  className,
}: {
  /** ISO yyyy-MM-dd. */
  from: string;
  to: string;
  /** The latest day that can be picked. */
  max?: string;
  presets: ReadonlyArray<PeriodPickerPreset>;
  /** The period the page shows when the URL carries none. */
  defaults: { from: string; to: string };
  /** Other search params to carry along. */
  preserve?: Record<string, string | undefined>;
  /** Defaults to the current path. */
  basePath?: string;
  label?: string;
  /** More controls in the same card, after the field. */
  children?: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const path = basePath ?? pathname;
  const [pending, startTransition] = useTransition();

  const rail = useMemo<DateRangePreset[]>(
    () => presets.map((p) => ({ id: p.label, label: p.label, range: () => ({ from: p.from, to: p.to }) })),
    [presets]
  );

  function go(range: { from: string; to: string }) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(preserve ?? {})) {
      if (value) search.set(key, value);
    }
    if (range.from !== defaults.from || range.to !== defaults.to) {
      search.set("from", range.from);
      search.set("to", range.to);
    }
    const query = search.toString();
    startTransition(() => router.replace(query ? `${path}?${query}` : path, { scroll: false }));
  }

  return (
    <FilterPanel pending={pending} pendingLabel="Opdaterer…" className={className}>
      <DateRangePicker
        label={label}
        className="w-[300px] max-w-full"
        value={{ from, to }}
        max={max}
        presets={rail}
        onChange={(range) => {
          if (range.from && range.to) go({ from: range.from, to: range.to });
        }}
      />
      {children}
    </FilterPanel>
  );
}
