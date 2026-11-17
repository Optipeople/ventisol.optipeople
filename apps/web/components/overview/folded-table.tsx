import type { ReactNode } from "react";
import { ChevronRightIcon } from "@optipeople/ui";

/**
 * A chart's numbers as a table, closed until asked for: the chart already
 * shows them. Plain details and summary, so it works without script.
 */
export function FoldedTable({
  showLabel,
  hideLabel = "Skjul tabellen",
  children,
}: {
  showLabel: string;
  hideLabel?: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-4">
      <summary className="inline-flex cursor-pointer list-none items-center gap-[6px] rounded-[2px] text-[13px] font-bold leading-[18px] text-[var(--ds-midnight-green)] hover:underline focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-green-80)] [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon size={10} strokeWidth={2.5} className="transition-transform group-open:rotate-90" />
        <span className="group-open:hidden">{showLabel}</span>
        <span className="hidden group-open:inline">{hideLabel}</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
