import { PillTabs } from "@optipeople/ui/blocks";
import type { Clock } from "@/lib/reports";
import { CLOCK_LABELS, hrefWith } from "@/lib/stations-view/params";

// The two small pickers of the Stationer tab, both kept in the URL: day or
// period, and the clock the durations are counted on.

export function ViewTabs({
  view,
  dayHref,
  periodHref,
}: {
  view: "day" | "period";
  dayHref: string;
  periodHref: string;
}) {
  return (
    <PillTabs
      label="Visning"
      selectedId={view}
      tabs={[
        { id: "day", label: "Dag", href: dayHref },
        { id: "period", label: "Periode", href: periodHref },
      ]}
    />
  );
}

/**
 * Arbejdstid or Hele døgnet. `clock` is the clock the report used (the
 * setting when the URL has none), so the selected pill always tells the truth.
 */
export function ClockToggle({
  clock,
  path,
  params,
}: {
  clock: Clock;
  path: string;
  /** The page's other search params, carried along. */
  params: Record<string, string | undefined>;
}) {
  const clocks: Clock[] = ["working", "wall"];
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">Tid</span>
      <PillTabs
        label="Tid"
        selectedId={clock}
        tabs={clocks.map((c) => ({
          id: c,
          label: CLOCK_LABELS[c],
          href: hrefWith(path, { ...params, clock: c }),
        }))}
      />
    </div>
  );
}
