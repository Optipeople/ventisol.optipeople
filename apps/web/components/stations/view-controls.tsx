import { PillTabs } from "@optipeople/ui/blocks";

/** Day or period on the Stationer tab, kept in the URL. */
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
