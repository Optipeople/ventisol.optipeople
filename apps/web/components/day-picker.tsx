"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DateField } from "@/components/ui/date-field";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const href = (day: string, today: string) => (day === today ? "/" : `/?dato=${day}`);

/** The day the overview shows: previous / next day, a date field, and back to today. */
export function DayPicker({ day, today }: { day: string; today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const prev = shift(day, -1);
  const next = shift(day, 1);
  const atToday = day >= today;

  return (
    <div
      aria-busy={pending}
      className="flex flex-wrap items-end gap-2 rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm"
    >
      <Link
        href={href(prev, today)}
        className={buttonClasses({ variant: "secondary", size: "compact" })}
        aria-label="Forrige dag"
      >
        ‹ Forrige dag
      </Link>
      <div className="w-[170px]">
        <DateField
          label="Dato"
          value={day}
          max={today}
          onChange={(value) => {
            if (!value) return;
            startTransition(() => router.push(href(value, today)));
          }}
        />
      </div>
      {atToday ? (
        <span
          aria-disabled="true"
          className={cn(buttonClasses({ variant: "secondary", size: "compact" }), "pointer-events-none opacity-50")}
        >
          Næste dag ›
        </span>
      ) : (
        <Link
          href={href(next, today)}
          className={buttonClasses({ variant: "secondary", size: "compact" })}
          aria-label="Næste dag"
        >
          Næste dag ›
        </Link>
      )}
      {!atToday && (
        <Link href="/" className={buttonClasses({ variant: "primary", size: "compact" })}>
          I dag
        </Link>
      )}
      {pending && (
        <span className="ml-auto self-center text-[12px] leading-[14px] text-[var(--ds-grey-medium-05)]">
          Opdaterer…
        </span>
      )}
    </div>
  );
}
