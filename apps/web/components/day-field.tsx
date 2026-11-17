"use client";

import { useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DateField } from "@optipeople/ui";
import { FilterPanel } from "@optipeople/ui/blocks";

/**
 * The day a page shows, kept in the URL: one date field, like the period and
 * month fields of the other pages. Today is the bare path, so the menu link
 * always means "now".
 */
export function DayField({
  day,
  today,
  param = "day",
  preserve,
  children,
}: {
  /** ISO yyyy-MM-dd. */
  day: string;
  /** Today in the app's time zone. Later days cannot be picked. */
  today: string;
  /** URL search param carrying the day. */
  param?: string;
  /** Other search params to carry along. */
  preserve?: Record<string, string | undefined>;
  /** More in the row, for example AutoRefresh while showing today. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const path = usePathname() ?? "/";
  const [pending, startTransition] = useTransition();

  function go(value: string) {
    const search = new URLSearchParams();
    for (const [key, v] of Object.entries({ ...preserve, [param]: value === today ? undefined : value })) {
      if (v) search.set(key, v);
    }
    const query = search.toString();
    startTransition(() => router.push(query ? `${path}?${query}` : path, { scroll: false }));
  }

  return (
    <FilterPanel pending={pending} pendingLabel="Opdaterer…">
      <div className="w-[300px] max-w-full">
        <DateField
          label="Dato"
          value={day}
          max={today}
          onChange={(value) => {
            if (value) go(value);
          }}
        />
      </div>
      {children}
    </FilterPanel>
  );
}
