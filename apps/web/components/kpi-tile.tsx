import { useId } from "react";
import { InfoIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * One headline figure on a report page. From optipeople.vola, with the
 * explanation passed in as text instead of looked up in the metric catalogue.
 */
export function KpiTile({
  label,
  value,
  hint,
  explain,
}: {
  label: string;
  value: string;
  hint?: string;
  /** What the figure means, behind the info button on hover, focus or tap. */
  explain?: string;
}) {
  const explainId = useId();
  return (
    <div className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm">
      <p className="flex items-start justify-between gap-2 text-[12px] leading-[14px] font-bold tracking-[0.02em] text-[var(--ds-grey-medium-04)] uppercase">
        <span className="min-w-0">{label}</span>
        {explain && (
          // Anchored to the right of the icon so it grows leftwards and never
          // pushes past the edge of the page on the last tile of a row.
          <Tooltip
            content={<span id={explainId}>{explain}</span>}
            side="top"
            align="end"
            multiline
            className="shrink-0"
          >
            {/* A button only so keyboard and touch users can reach the explanation. */}
            <button
              type="button"
              aria-label={`Forklaring af ${label}`}
              aria-describedby={explainId}
              className="cursor-help rounded-full text-[var(--ds-grey-light-03)] transition-colors hover:text-[var(--ds-blue-primary)] focus-visible:text-[var(--ds-blue-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-blue-primary)]"
            >
              <InfoIcon size={14} />
            </button>
          </Tooltip>
        )}
      </p>
      <p className="mt-1 text-[24px] leading-[28px] font-bold tabular-nums text-[var(--ds-grey-dark-09)]">
        {value}
      </p>
      {hint && (
        <p className="text-[12px] leading-[21px] text-[var(--ds-grey-medium-05)]">{hint}</p>
      )}
    </div>
  );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}
