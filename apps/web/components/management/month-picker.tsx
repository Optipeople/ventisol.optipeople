"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@optipeople/ui";
import { FilterPanel } from "@optipeople/ui/blocks";

export type MonthChoice = { month: string; label: string };

/**
 * The month of the Ledelse report, kept in the URL (`maaned`): a list of
 * every month the page reaches, locked ones marked.
 * The hrefs are made on the server, so the bare path stays the last full month.
 *
 * Sits in the page card, like the day and period pickers of the other pages.
 */
export function MonthPicker({
  month,
  choices,
  hrefs,
}: {
  month: string;
  /** Newest first. */
  choices: MonthChoice[];
  /** The page URL of each month in `choices`. */
  hrefs: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <FilterPanel pending={pending} pendingLabel="Opdaterer…" className="print:hidden">
      <div className="w-[300px] max-w-full">
        <Select
          label="Måned"
          value={month}
          items={choices.map((c) => ({ value: c.month, label: c.label }))}
          onValueChange={(value) => {
            const href = hrefs[value];
            if (href) startTransition(() => router.push(href));
          }}
        />
      </div>
    </FilterPanel>
  );
}
