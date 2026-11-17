import type { ReactNode } from "react";
import { PillTabs } from "@optipeople/ui/blocks";
import type { Clock } from "@/lib/reports";
import { CLOCK_LABELS, hrefWith } from "@/lib/stations-view/params";

// Every report page is laid out the same way:
//   1. PageHeader: the title on the left, Download (and print) on the right.
//   2. PageControls: the view tabs and the search on the left, Tid on the right.
//   3. One filter card: the day, the period, the month or the list filters.
// Then the content. A page leaves out what it does not have, never moves it.

/** The row right under the page header. `clock` is pinned to the right. */
export function PageControls({ children, clock }: { children?: ReactNode; clock?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 print:hidden">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3">{children}</div>
      {clock}
    </div>
  );
}

/**
 * Arbejdstid or Hele døgnet. `clock` is the clock the report used (the
 * setting when the URL has none), so the selected pill always tells the truth.
 * The links are either `path` with `params`, or ready made in `hrefs`.
 */
export function ClockToggle({
  clock,
  path,
  params,
  hrefs,
  locked = false,
}: {
  clock: Clock;
  path?: string;
  /** The page's other search params, carried along. */
  params?: Record<string, string | undefined>;
  hrefs?: Record<Clock, string>;
  /** The clock cannot be switched: it is shown as text. */
  locked?: boolean;
}) {
  const clocks: Clock[] = ["working", "wall"];
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">Tid</span>
      {locked ? (
        <span className="text-[14px] leading-[28px] text-[var(--ds-grey-dark-09)]">{CLOCK_LABELS[clock]} (låst)</span>
      ) : (
        <PillTabs
          label="Tid"
          selectedId={clock}
          tabs={clocks.map((c) => ({
            id: c,
            label: CLOCK_LABELS[c],
            href: hrefs ? hrefs[c] : hrefWith(path ?? "/", { ...params, clock: c }),
          }))}
        />
      )}
    </div>
  );
}
