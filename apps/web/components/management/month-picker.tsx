"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { Select } from "@optipeople/ui";

export type MonthChoice = { month: string; label: string };

/**
 * The month of the Ledelse report, kept in the URL (`maaned`): a list of
 * every month the page reaches, locked ones marked.
 * The hrefs are made on the server, so the bare path stays the last full month.
 *
 * A bare row: it sits in the toolbar of the ReportFrame, which is not printed.
 */
export function MonthPicker({
  month,
  choices,
  hrefs,
  children,
}: {
  month: string;
  /** Newest first. */
  choices: MonthChoice[];
  /** The page URL of each month in `choices`. */
  hrefs: Record<string, string>;
  /** More filters in the same row (the clock). */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div aria-busy={pending} className="flex w-full flex-wrap items-end gap-2">
      <div className="w-[220px]">
        <Select
          label="Måned"
          size="small"
          value={month}
          items={choices.map((c) => ({ value: c.month, label: c.label }))}
          onValueChange={(value) => {
            const href = hrefs[value];
            if (href) startTransition(() => router.push(href));
          }}
        />
      </div>
      {pending && (
        <span role="status" className="self-center text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
          Opdaterer…
        </span>
      )}
      {children && <div className="ml-auto">{children}</div>}
    </div>
  );
}
