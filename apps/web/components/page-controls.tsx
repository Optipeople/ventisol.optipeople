import type { ReactNode } from "react";
import { FilterPanel, PillTabs } from "@optipeople/ui/blocks";
import type { Clock } from "@/lib/reports";
import { CLOCK_LABELS, hrefWith } from "@/lib/stations-view/params";

// Every report page is laid out the same way:
//   1. PageHeader: the title on the left, Download (and print) on the right.
//   2. PageControls: one white card with every control of the page. The view
//      tabs, the search, then the day, period, month or list filters, and Tid
//      pinned to the right.
// Then the content. A page leaves out what it does not have, never moves it.
// A picker built on FilterPanel draws no card of its own inside this one.

/**
 * The page's one control card. `clock` is pinned to the right of the first
 * row. `filters` is a second row, for a page whose first row is already full
 * (Ordrer: tabs and search above, the list filters below).
 */
export function PageControls({
  children,
  clock,
  filters,
}: {
  children?: ReactNode;
  clock?: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <FilterPanel className="print:hidden">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-6 gap-y-4">{children}</div>
        {clock && <div className="flex h-[40px] items-center">{clock}</div>}
      </div>
      {filters && <div className="mt-4">{filters}</div>}
    </FilterPanel>
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
