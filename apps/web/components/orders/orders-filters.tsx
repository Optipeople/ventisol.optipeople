"use client";

import { useMemo, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, DateRangePicker, Select, type DateRangePreset } from "@optipeople/ui";
import { FilterPanel } from "@optipeople/ui/blocks";

export interface OrdersFilterSelect {
  /** URL search param. */
  param: string;
  label: string;
  /** The current value. "" is the empty choice. */
  value: string;
  emptyLabel?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

/**
 * The list filters of Ordrer, the second row of the page card, kept in the URL: the selects, and for
 * the finished orders the same period field with presets as Overblik and
 * Stationer. No period means every packed order.
 */
export function OrdersFilters({
  basePath,
  selects,
  period,
  preserve,
  hasActiveFilters,
  search,
}: {
  basePath: string;
  selects: ReadonlyArray<OrdersFilterSelect>;
  /** ISO yyyy-MM-dd, or undefined for no period. Leave out for a list without a period. */
  period?: {
    from: string | undefined;
    to: string | undefined;
    max: string;
    presets: ReadonlyArray<{ label: string; from: string; to: string }>;
  };
  /** The other search params to keep. */
  preserve: Record<string, string>;
  hasActiveFilters: boolean;
  /** The search field, first in the row. */
  search?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const presets = period?.presets;
  const rail = useMemo<DateRangePreset[]>(
    () => (presets ?? []).map((p) => ({ id: p.label, label: p.label, range: () => ({ from: p.from, to: p.to }) })),
    [presets]
  );

  function go(overrides: Record<string, string | undefined>) {
    const params: Record<string, string | undefined> = { ...preserve };
    for (const select of selects) params[select.param] = select.value;
    if (period) {
      params.from = period.from;
      params.to = period.to;
    }
    Object.assign(params, overrides);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const query = search.toString();
    startTransition(() => router.replace(query ? `${basePath}?${query}` : basePath, { scroll: false }));
  }

  return (
    <FilterPanel pending={pending} pendingLabel="Opdaterer…" className="flex flex-wrap items-end gap-4">
      {search}
      {period && (
        <DateRangePicker
          label="Pakket i perioden"
          className="w-[300px] max-w-full"
          value={{ from: period.from ?? null, to: period.to ?? null }}
          max={period.max}
          presets={rail}
          clearable
          onChange={(range) => {
            if (range.from && range.to) go({ from: range.from, to: range.to });
            else if (!range.from && !range.to) go({ from: undefined, to: undefined });
          }}
        />
      )}
      {selects.map((select) => (
        <div key={select.param} className="w-[240px] max-w-full">
          <Select
            label={select.label}
            value={select.value}
            onValueChange={(value) => go({ [select.param]: value })}
            items={[{ value: "", label: select.emptyLabel ?? "Alle" }, ...select.options]}
          />
        </div>
      ))}
      {hasActiveFilters && (
        <Button
          variant="secondary"
          size="compact"
          className="mb-[6px] self-end"
          onClick={() => {
            const cleared: Record<string, string | undefined> = { from: undefined, to: undefined };
            for (const select of selects) cleared[select.param] = undefined;
            go(cleared);
          }}
        >
          Ryd filtre
        </Button>
      )}
    </FilterPanel>
  );
}
