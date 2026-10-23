"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Top-level navigation between the report views, copied from optipeople.vola:
// folder-style tabs on a grey strip, active tab marked with a green top bar.
// The order page belongs to the day overview it is opened from.
const TABS = [
  { label: "Dagsoverblik", href: "/", match: ["/", "/ordre"] },
  { label: "Periode", href: "/periode", match: ["/periode"] },
] as const;

export function SectionNav() {
  const pathname = usePathname() ?? "";

  return (
    <div className="w-full border-b border-[var(--ds-grey-light-03)] bg-[var(--ds-grey-light-02)]">
      <div className="mx-auto w-full max-w-6xl overflow-x-auto overflow-y-clip px-3 sm:px-6">
        <nav aria-label="Rapporter" className="flex items-end gap-[7px] pt-3">
          {TABS.map((tab) => {
            const active = tab.match.some((m) =>
              m === "/" ? pathname === "/" : pathname === m || pathname.startsWith(`${m}/`)
            );
            return active ? (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current="page"
                className="-mb-px flex flex-col items-stretch"
              >
                <span
                  aria-hidden
                  className="h-1 rounded-t-[1px] border-x border-t border-[var(--ds-grey-light-03)] bg-[var(--color-success)]"
                />
                <span className="border-x border-[var(--ds-grey-light-03)] bg-[var(--color-surface)] px-7 pt-[5px] pb-[3px] text-[14px] font-bold leading-4 text-[var(--ds-grey-dark-09)] shadow-[inset_1px_1px_2px_0_rgba(0,0,0,0.1)] whitespace-nowrap">
                  {tab.label}
                </span>
              </Link>
            ) : (
              <Link
                key={tab.href}
                href={tab.href}
                className="rounded-t-[1px] border border-[var(--ds-grey-light-03)] bg-white px-7 pt-[5px] pb-[3px] text-[14px] leading-[14px] text-[var(--ds-grey-dark-09)] opacity-60 shadow-[inset_1px_1px_2px_0_rgba(0,0,0,0.1)] transition-opacity hover:opacity-100 whitespace-nowrap"
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
