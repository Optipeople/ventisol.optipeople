"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Field, FieldFrame } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import {
  addDays,
  addMonths,
  dateToIso,
  formatDisplayDate,
  isoToDate,
  isoWeekNumber,
  maskDateInput,
  parseDisplayDate,
  startOfIsoWeek,
  todayUtc,
} from "@/lib/date-format";

/** Month and weekday names. Copied from optipeople.vola, Danish only here. */
const INTL_LOCALE = "da-DK";

const TEXT = {
  dateFormat: "dd-mm-åååå",
  dateFormatHint: "Indtast en dato som dd-mm-åååå.",
  dateInvalid: "Ikke en gyldig dato. Brug dd-mm-åååå.",
  openCalendar: "Åbn kalender",
  previousMonth: "Forrige måned",
  nextMonth: "Næste måned",
  weekAbbr: "Uge",
  weekNumberColumn: "Ugenummer",
  today: "I dag",
};

const MS_PER_DAY = 86_400_000;

/**
 * Period field for the filter bars. Shows and accepts dd-MM-yyyy while the
 * `value` it exchanges with the caller stays ISO yyyy-MM-dd.
 *
 * It is a text input plus a calendar popover rather than <input type="date">:
 * the native control renders in the *browser's* locale, so a Danish operator
 * on an English Windows install read 09/14/2026 with no way to tell whether
 * that meant September or the 9th. Typing is forgiving (dots, slashes, bare
 * digits and pasted ISO all parse) and the calendar leads with ISO week
 * numbers, which is how the shop floor talks about periods.
 */
export function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  /** ISO yyyy-MM-dd, or "" for no date. */
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  const intlLocale = INTL_LOCALE;

  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  const [text, setText] = React.useState(() => formatDisplayDate(value));
  const [rejected, setRejected] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [rect, setRect] = React.useState<PopoverRect | null>(null);
  const [editing, setEditing] = React.useState(false);

  // Re-sync when the period changes from outside (reset, clear, back button).
  // Skipped while the field has focus: navigation runs in a transition, so the
  // new `value` can land several keystrokes after the commit that caused it
  // and would otherwise overwrite what the user has typed since. Blur always
  // re-syncs, so the field cannot stay out of step.
  const [prevValue, setPrevValue] = React.useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (!editing) {
      setText(formatDisplayDate(value));
      setRejected(false);
    }
  }

  const commit = React.useCallback(
    (iso: string) => {
      setText(formatDisplayDate(iso));
      setRejected(false);
      if (iso !== value) onChange(iso);
    },
    [onChange, value],
  );

  const inRange = React.useCallback(
    (iso: string) => (!min || iso >= min) && (!max || iso <= max),
    [min, max],
  );

  function handleChange(raw: string) {
    const next = maskDateInput(raw);
    setText(next);
    setEditing(true);
    setRejected(false);
    // Commit as soon as a full date is typed so the filter keeps up without
    // waiting for a blur. Anything shorter simply parses to null.
    if (next.replace(/\D/g, "").length >= 8) {
      const iso = parseDisplayDate(next);
      if (iso && inRange(iso)) commit(iso);
    }
  }

  function handleBlur() {
    setEditing(false);
    commitText();
  }

  function commitText() {
    if (open) return; // Focus moved into the calendar, not away from the field.
    const trimmed = text.trim();
    if (!trimmed) {
      commit("");
      return;
    }
    const iso = parseDisplayDate(trimmed);
    if (iso && inRange(iso)) {
      commit(iso);
      return;
    }
    // Restore the last good date rather than leave the field and the filter
    // disagreeing; the hint below explains why the typing was dropped.
    setText(formatDisplayDate(value));
    setRejected(true);
  }

  const closeCalendar = React.useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  function openCalendar() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect(placePopover(r));
    setRejected(false);
    setOpen(true);
  }

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closeCalendar(false);
    };
    const onDismiss = () => closeCalendar(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [open, closeCalendar]);

  return (
    <Field
      label={label}
      htmlFor={inputId}
      helpText={
        rejected ? (
          <span className="block text-left text-[var(--ds-red)]">
            {TEXT.dateInvalid}
          </span>
        ) : undefined
      }
    >
      <FieldFrame className="relative h-[30px] rounded-[2px]">
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={TEXT.dateFormat}
          aria-describedby={hintId}
          aria-invalid={rejected || undefined}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            } else if (e.key === "ArrowDown" && e.altKey) {
              e.preventDefault();
              openCalendar();
            }
          }}
          className={cn(
            "absolute inset-y-0 left-0 right-[30px] appearance-none bg-transparent px-[8px]",
            "font-['Hanken_Grotesk',sans-serif] text-[14px] leading-[14px] tabular-nums",
            "text-[var(--ds-grey-dark-09)] placeholder:text-[var(--ds-grey-light-03)]",
            "outline-none focus-visible:rounded-[2px] focus-visible:shadow-[inset_0_0_0_2px_var(--ds-green-80)]",
          )}
        />
        {/* Screen-reader format hint; sighted users read it off the placeholder. */}
        <span id={hintId} className="sr-only">
          {TEXT.dateFormatHint}
        </span>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={TEXT.openCalendar}
          onClick={() => (open ? closeCalendar(true) : openCalendar())}
          className={cn(
            "absolute right-[7px] top-1/2 flex h-[16px] w-[15px] -translate-y-1/2",
            "items-center justify-center rounded-[2px] bg-[#134343] text-white",
            "shadow-[0px_1px_2.5px_rgba(0,122,255,0.24),0px_0px_0px_0.5px_rgba(0,122,255,0.12)]",
            "cursor-pointer outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-green-80)]",
          )}
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(255,255,255,0.17) 0%, rgba(255,255,255,0) 100%)",
          }}
        >
          <CalendarGlyph />
        </button>
      </FieldFrame>
      {open && rect ? (
        <Calendar
          ref={popoverRef}
          rect={rect}
          intlLocale={intlLocale}
          selected={value}
          min={min}
          max={max}
          onSelect={(iso) => {
            commit(iso);
            closeCalendar(true);
          }}
          onDismiss={() => closeCalendar(true)}
        />
      ) : null}
    </Field>
  );
}

function CalendarGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="3.5" width="12" height="11" rx="1.5" />
      <path d="M2 7h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  );
}

type PopoverRect = { top?: number; bottom?: number; left: number };

const POPOVER_WIDTH = 268;

function placePopover(r: DOMRect): PopoverRect {
  const GAP = 6;
  const MARGIN = 8;
  const spaceBelow = window.innerHeight - r.bottom - GAP - MARGIN;
  const left = Math.min(
    Math.max(MARGIN, r.left),
    Math.max(MARGIN, window.innerWidth - POPOVER_WIDTH - MARGIN),
  );
  // Flip above only when the month grid genuinely will not fit below.
  return spaceBelow < 300 && r.top > spaceBelow
    ? { bottom: window.innerHeight - r.top + GAP, left }
    : { top: r.bottom + GAP, left };
}

const Calendar = React.forwardRef<
  HTMLDivElement,
  {
    rect: PopoverRect;
    intlLocale: string;
    selected: string;
    min?: string;
    max?: string;
    onSelect: (iso: string) => void;
    onDismiss: () => void;
  }
>(function Calendar(
  { rect, intlLocale, selected, min, max, onSelect, onDismiss },
  ref,
) {
  const today = React.useMemo(() => todayUtc(), []);
  const [focused, setFocused] = React.useState<Date>(
    () => isoToDate(selected) ?? clampToRange(todayUtc(), min, max),
  );
  const gridRef = React.useRef<HTMLDivElement>(null);

  const monthLabel = React.useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(focused),
    [intlLocale, focused],
  );

  const dayLabelFormat = React.useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        dateStyle: "long",
        timeZone: "UTC",
      }),
    [intlLocale],
  );

  const weekdayNames = React.useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intlLocale, {
      weekday: "short",
      timeZone: "UTC",
    });
    // 2024-01-01 was a Monday — Danish and ISO weeks both start there.
    const monday = Date.UTC(2024, 0, 1);
    return Array.from({ length: 7 }, (_, i) =>
      // Danish "short" weekdays carry a trailing period the grid has no room for.
      fmt.format(new Date(monday + i * MS_PER_DAY)).replace(/\.$/, ""),
    );
  }, [intlLocale]);

  const weeks = React.useMemo(() => buildMonthGrid(focused), [focused]);

  // Roving tabindex: keep DOM focus on the day the arrow keys point at.
  React.useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLButtonElement>('[data-focused="true"]')
      ?.focus({ preventScroll: true });
  }, [focused]);

  const isDisabled = React.useCallback(
    (date: Date) => {
      const iso = dateToIso(date);
      return (!!min && iso < min) || (!!max && iso > max);
    },
    [min, max],
  );

  const move = (next: Date) => setFocused(clampToRange(next, min, max));

  function onKeyDown(e: React.KeyboardEvent) {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => startOfIsoWeek(focused),
      End: () => addDays(startOfIsoWeek(focused), 6),
      PageUp: () => addMonths(focused, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focused, e.shiftKey ? 12 : 1),
    };
    const next = moves[e.key];
    if (next) {
      e.preventDefault();
      move(next());
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isDisabled(focused)) onSelect(dateToIso(focused));
    }
  }

  if (typeof document === "undefined") return null;
  const todayIso = dateToIso(today);
  const focusedIso = dateToIso(focused);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={TEXT.openCalendar}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: POPOVER_WIDTH,
      }}
      className={cn(
        "z-50 rounded-[2px] bg-white p-[10px]",
        "font-['Hanken_Grotesk',sans-serif] text-[var(--ds-grey-dark-09)]",
        "shadow-[0px_0px_0.5px_rgba(0,0,0,0.4),0px_0px_0.75px_rgba(0,0,0,0.3),0px_7px_11px_rgba(0,0,0,0.25)]",
      )}
    >
      <div className="mb-[6px] flex items-center justify-between">
        <NavButton
          label={TEXT.previousMonth}
          onClick={() => move(addMonths(focused, -1))}
        >
          <ChevronGlyph direction="left" />
        </NavButton>
        <span
          aria-live="polite"
          className="text-[14px] leading-[20px] font-bold capitalize"
        >
          {monthLabel}
        </span>
        <NavButton
          label={TEXT.nextMonth}
          onClick={() => move(addMonths(focused, 1))}
        >
          <ChevronGlyph direction="right" />
        </NavButton>
      </div>

      <div ref={gridRef} role="grid" aria-label={monthLabel}>
        <div role="row" className="grid grid-cols-[28px_repeat(7,1fr)]">
          <span
            role="columnheader"
            aria-label={TEXT.weekNumberColumn}
            className="overflow-hidden py-[4px] text-center text-[11px] leading-[14px] text-[var(--ds-grey-light-03)]"
          >
            {TEXT.weekAbbr}
          </span>
          {weekdayNames.map((name) => (
            <span
              key={name}
              role="columnheader"
              className="overflow-hidden py-[4px] text-center text-[11px] leading-[14px] capitalize text-[var(--ds-grey-medium-05)]"
            >
              {name}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div
            key={dateToIso(week[0])}
            role="row"
            className="grid grid-cols-[28px_repeat(7,1fr)]"
          >
            <span
              role="rowheader"
              className="flex h-[28px] items-center justify-center text-[11px] leading-[14px] tabular-nums text-[var(--ds-grey-light-03)]"
            >
              {isoWeekNumber(week[0])}
            </span>
            {week.map((day) => {
              const iso = dateToIso(day);
              const outsideMonth = day.getUTCMonth() !== focused.getUTCMonth();
              const disabled = isDisabled(day);
              const isSelected = iso === selected;
              const isToday = iso === todayIso;
              return (
                <div role="gridcell" key={iso} aria-selected={isSelected}>
                  <button
                    type="button"
                    data-focused={iso === focusedIso}
                    tabIndex={iso === focusedIso ? 0 : -1}
                    disabled={disabled}
                    aria-label={dayLabelFormat.format(day)}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => onSelect(iso)}
                    className={cn(
                      "h-[28px] w-full rounded-[2px] text-[13px] leading-[14px] tabular-nums outline-none",
                      "cursor-pointer hover:bg-[var(--ds-blue-secondary)]",
                      "focus-visible:shadow-[inset_0_0_0_2px_var(--ds-green-80)]",
                      outsideMonth && "text-[var(--ds-grey-light-03)]",
                      isToday &&
                        !isSelected &&
                        "font-bold underline underline-offset-[3px]",
                      isSelected &&
                        "bg-[var(--ds-midnight-green)] text-white hover:bg-[var(--ds-midnight-green)]",
                      disabled &&
                        "cursor-not-allowed text-[var(--ds-text-disabled)] hover:bg-transparent",
                    )}
                  >
                    {day.getUTCDate()}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <button
        type="button"
        tabIndex={-1}
        onClick={() => onSelect(dateToIso(clampToRange(today, min, max)))}
        className={cn(
          "mt-[8px] w-full rounded-[2px] py-[4px] text-[13px] leading-[16px]",
          "text-[var(--ds-midnight-green)] outline-none hover:bg-[var(--ds-blue-secondary)]",
          "focus-visible:shadow-[inset_0_0_0_2px_var(--ds-green-80)]",
        )}
      >
        {TEXT.today}
      </button>
    </div>,
    document.body,
  );
});

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        "flex h-[24px] w-[24px] items-center justify-center rounded-[2px]",
        "text-[var(--ds-grey-dark-09)] outline-none",
        "cursor-pointer hover:bg-[var(--ds-blue-secondary)]",
        "focus-visible:shadow-[inset_0_0_0_2px_var(--ds-green-80)]",
      )}
    >
      {children}
    </button>
  );
}

function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={direction === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} />
    </svg>
  );
}

/** Six Monday-first weeks covering `month`, so the popover never changes height. */
function buildMonthGrid(month: Date): Date[][] {
  const firstOfMonth = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1),
  );
  const start = startOfIsoWeek(firstOfMonth);
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
  );
}

function clampToRange(date: Date, min?: string, max?: string): Date {
  const iso = dateToIso(date);
  if (min && iso < min) return isoToDate(min) ?? date;
  if (max && iso > max) return isoToDate(max) ?? date;
  return date;
}
