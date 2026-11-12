"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DateField } from "@/components/ui/date-field";
import { buttonClasses } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const href = (day: string, today: string) => (day === today ? "/" : `/?dato=${day}`);

/** The day the overview shows: previous / next day, a date field, and back to today. */
export function DayPicker({
  day,
  today,
  earliest,
}: {
  day: string;
  today: string;
  /** The earliest day that can be shown (earliestDay in lib/views.ts). */
  earliest: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const prev = shift(day, -1);
  const next = shift(day, 1);
  const atToday = day >= today;
  const atEarliest = day <= earliest;

  return (
    <div
      aria-busy={pending}
      className="flex flex-wrap items-end gap-2 rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm"
    >
      {atEarliest ? (
        <span
          aria-disabled="true"
          className={cn(buttonClasses({ variant: "secondary", size: "compact" }), "pointer-events-none gap-[6px] opacity-50")}
        >
          <ChevronLeftIcon size={14} />
          Forrige dag
        </span>
      ) : (
        <Link
          href={href(prev, today)}
          className={cn(buttonClasses({ variant: "secondary", size: "compact" }), "gap-[6px]")}
          aria-label="Forrige dag"
        >
          <ChevronLeftIcon size={14} />
          Forrige dag
        </Link>
      )}
      <div className="w-[170px]">
        <DateField
          label="Dato"
          value={day}
          min={earliest}
          max={today}
          required
          onChange={(value) => {
            if (!value) return;
            startTransition(() => router.push(href(value, today)));
          }}
        />
      </div>
      {atToday ? (
        <span
          aria-disabled="true"
          className={cn(buttonClasses({ variant: "secondary", size: "compact" }), "pointer-events-none gap-[6px] opacity-50")}
        >
          Næste dag
          <ChevronRightIcon size={14} />
        </span>
      ) : (
        <Link
          href={href(next, today)}
          className={cn(buttonClasses({ variant: "secondary", size: "compact" }), "gap-[6px]")}
          aria-label="Næste dag"
        >
          Næste dag
          <ChevronRightIcon size={14} />
        </Link>
      )}
      {!atToday && (
        <Link href="/" className={buttonClasses({ variant: "primary", size: "compact" })}>
          I dag
        </Link>
      )}
      {/* Today's numbers move while the page is open; a past day's do not. */}
      {day === today && <AutoRefresh />}
      {pending && (
        <span className="ml-auto flex items-center gap-2 self-center text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
          <span
            aria-hidden
            className="h-[12px] w-[12px] animate-spin rounded-full border-2 border-[var(--ds-grey-light-03)] border-t-[var(--ds-midnight-green)]"
          />
          Opdaterer…
        </span>
      )}
    </div>
  );
}
