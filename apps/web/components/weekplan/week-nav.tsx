// The week the Ugeplan page shows, kept in the URL (?uge=2026-48): previous
// and next week as links, the week and its Monday between them. Styled like
// the DayPicker of the daily pages. The hrefs are made by the page.

import Link from "next/link";
import { buttonClasses, ChevronLeftIcon, ChevronRightIcon, cn } from "@optipeople/ui";
import { FilterPanel } from "@optipeople/ui/blocks";

const stepClasses = cn(buttonClasses({ variant: "secondary", size: "compact" }), "gap-[6px]");

export function WeekNav({
  label,
  monday,
  previousHref,
  nextHref,
}: {
  /** "Uge 48, 2026". */
  label: string;
  /** "Mandag 23. november 2026". */
  monday: string;
  previousHref: string;
  nextHref: string;
}) {
  return (
    <FilterPanel className="flex flex-wrap items-center gap-4 print:hidden">
      <Link href={previousHref} scroll={false} className={stepClasses}>
        <ChevronLeftIcon size={14} />
        Forrige uge
      </Link>
      <div className="min-w-[180px] text-center">
        <p className="text-[16px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">{label}</p>
        <p className="text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">{monday}</p>
      </div>
      <Link href={nextHref} scroll={false} className={stepClasses}>
        Næste uge
        <ChevronRightIcon size={14} />
      </Link>
    </FilterPanel>
  );
}
