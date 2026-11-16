// Geometry of the route Gantt on the order page: one lane per step, a bar from
// the step's first to its last instant, the "Nu" marker and the forecast.
// Pure: the steps and `now` in, percentages out. Ticks are Copenhagen time.

import type { StepKind, StepSource } from "@/lib/derive";
import { addDays, dayKey, dayStart, formatClock, formatShortDay } from "@/lib/time";

export type GanttTone = "work" | "wait" | "deviation";

export interface GanttStepInput {
  step: string;
  label: string;
  kind: StepKind;
  source: StepSource;
  startAt: string | null;
  endAt: string | null;
  isOpen: boolean;
  deviation: boolean;
}

export interface GanttOrderInput {
  status: "in_progress" | "packed";
  startAt: string;
  packedAt: string | null;
  forecastReadyAt: string | null;
}

export interface GanttBar {
  /** Percent of the axis from the left. */
  left: number;
  width: number;
  tone: GanttTone;
  /** Still running at `now`: drawn open-ended. */
  open: boolean;
  start: number;
  end: number;
}

export interface GanttLane {
  step: string;
  label: string;
  kind: StepKind;
  source: StepSource;
  /** Null: no time for this step (not measured, assumed, or not reached). */
  bar: GanttBar | null;
}

export interface GanttTick {
  at: number;
  left: number;
  label: string;
}

export interface Gantt {
  axisStart: number;
  axisEnd: number;
  lanes: GanttLane[];
  ticks: GanttTick[];
  /** Percent; null once packed or when now lies outside the axis. */
  nowAt: number | null;
  /** Percent; in progress with a forecast only. */
  forecastAt: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The narrowest bar, in percent, so a two-minute pass still shows. */
const MIN_WIDTH = 0.6;

const pct = (t: number, start: number, span: number) => Math.min(100, Math.max(0, ((t - start) / span) * 100));

function parse(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Ticks a person can read: hours for a short order, days or weeks for a long one. */
export function ganttTicks(axisStart: number, axisEnd: number): GanttTick[] {
  const span = axisEnd - axisStart;
  if (span <= 0) return [];
  const ticks: GanttTick[] = [];
  if (span <= 2 * DAY) {
    const step = span <= 12 * HOUR ? HOUR : span <= DAY ? 3 * HOUR : 6 * HOUR;
    // Copenhagen is a whole number of hours from UTC, so UTC hours are local hours.
    for (let t = Math.ceil(axisStart / step) * step; t <= axisEnd; t += step) {
      ticks.push({ at: t, left: pct(t, axisStart, span), label: formatClock(t) });
    }
    return ticks;
  }
  const days = span / DAY;
  const every = days <= 10 ? 1 : days <= 28 ? 2 : 7;
  let day = addDays(dayKey(axisStart), 1);
  for (let i = 0; i < 400; i++) {
    const t = dayStart(day);
    if (t > axisEnd) break;
    if (i % every === 0) ticks.push({ at: t, left: pct(t, axisStart, span), label: formatShortDay(day) });
    day = addDays(day, 1);
  }
  return ticks;
}

export function ganttLayout(order: GanttOrderInput, steps: GanttStepInput[], now: number): Gantt {
  const inProgress = order.status === "in_progress";
  const orderStart = parse(order.startAt) ?? now;
  const packed = parse(order.packedAt);
  const forecast = inProgress ? parse(order.forecastReadyAt) : null;

  const spans = steps.map((s) => {
    const start = parse(s.startAt);
    if (start == null) return null;
    const open = inProgress && s.isOpen;
    const end = open ? Math.max(now, parse(s.endAt) ?? now) : (parse(s.endAt) ?? start);
    return { start, end: Math.max(start, end), open };
  });

  let axisStart = orderStart;
  let axisEnd = inProgress ? now : (packed ?? orderStart);
  for (const s of spans) {
    if (!s) continue;
    axisStart = Math.min(axisStart, s.start);
    axisEnd = Math.max(axisEnd, s.end);
  }
  if (forecast != null) axisEnd = Math.max(axisEnd, forecast);
  // Some air at the end, and never a zero span.
  const span0 = Math.max(axisEnd - axisStart, HOUR);
  axisEnd = axisStart + span0 * 1.02;
  const span = axisEnd - axisStart;

  const lanes: GanttLane[] = steps.map((s, i) => {
    const t = spans[i];
    if (!t) return { step: s.step, label: s.label, kind: s.kind, source: s.source, bar: null };
    const left = pct(t.start, axisStart, span);
    const width = Math.max(MIN_WIDTH, Math.min(100 - left, pct(t.end, axisStart, span) - left));
    const tone: GanttTone = s.deviation ? "deviation" : s.kind === "wait" ? "wait" : "work";
    return {
      step: s.step,
      label: s.label,
      kind: s.kind,
      source: s.source,
      bar: { left, width, tone, open: t.open, start: t.start, end: t.end },
    };
  });

  return {
    axisStart,
    axisEnd,
    lanes,
    ticks: ganttTicks(axisStart, axisEnd),
    nowAt: inProgress && now >= axisStart && now <= axisEnd ? pct(now, axisStart, span) : null,
    forecastAt: forecast != null ? pct(forecast, axisStart, span) : null,
  };
}
