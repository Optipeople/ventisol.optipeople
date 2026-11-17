"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { buttonClasses, ChevronLeftIcon, ChevronRightIcon, cn, Select } from "@optipeople/ui";

export type MonthChoice = { month: string; label: string };

/**
 * The month of the Ledelse report, kept in the URL (`maaned`): previous and
 * next month and a list of every month the page reaches, frozen ones marked.
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
  const index = choices.findIndex((c) => c.month === month);
  const newer = index > 0 ? choices[index - 1] : undefined;
  const older = index >= 0 && index < choices.length - 1 ? choices[index + 1] : undefined;
  const step = cn(buttonClasses({ variant: "secondary", size: "compact" }), "gap-[6px]");
  const off = "pointer-events-none opacity-50";

  return (
    <div aria-busy={pending} className="flex w-full flex-wrap items-end gap-2">
      {older ? (
        <Link href={hrefs[older.month]} className={step}>
          <ChevronLeftIcon size={14} />
          Forrige måned
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(step, off)}>
          <ChevronLeftIcon size={14} />
          Forrige måned
        </span>
      )}
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
      {newer ? (
        <Link href={hrefs[newer.month]} className={step}>
          Næste måned
          <ChevronRightIcon size={14} />
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(step, off)}>
          Næste måned
          <ChevronRightIcon size={14} />
        </span>
      )}
      {pending && (
        <span role="status" className="self-center text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
          Opdaterer…
        </span>
      )}
      {children && <div className="ml-auto">{children}</div>}
    </div>
  );
}
