// The station detail's day timeline and trend scale, as plain data. Pure:
// `now` and the day's bounds come in. The drawing is the Timeline block of
// @optipeople/ui; components/stations/station-timeline.tsx adds the words.

import type { StationTrendPoint, TimelineInterval } from "@/lib/reports/types";

const HOUR = 3_600_000;

export interface StationLaneBar {
  interval: TimelineInterval;
  start: number;
  end: number;
  tone: "default" | "alert" | "active";
}

export interface StationLane {
  id: string;
  label: string;
  bars: StationLaneBar[];
  /** Summed duration of the lane's bars on the headline clock, seconds. */
  totalSeconds: number;
}

export interface StationTimelineData {
  axisStart: number;
  axisEnd: number;
  lanes: StationLane[];
  /** Passes with no Out scan: not drawn, listed in the table. */
  missingOut: number;
}

/**
 * One lane per element type (in order of first pass), one bar per pass from
 * In to Out. An open pass runs to `now`, capped at the end of the day. A pass
 * with a missing Out has no end and is left out of the drawing. The axis runs
 * from the hour of the first bar to the hour after the last, within the day.
 * Null when there is nothing to draw.
 */
export function buildStationTimeline(
  intervals: ReadonlyArray<TimelineInterval>,
  bounds: { dayStart: number; dayEnd: number; now: number }
): StationTimelineData | null {
  const lanes = new Map<string, StationLane>();
  let missingOut = 0;
  let first = Infinity;
  let last = -Infinity;

  for (const iv of intervals) {
    if (iv.status === "missing_out") {
      missingOut++;
      continue;
    }
    const start = Math.max(Date.parse(iv.startAt), bounds.dayStart);
    const rawEnd = iv.status === "open" || !iv.endAt ? Math.min(bounds.now, bounds.dayEnd) : Date.parse(iv.endAt);
    const end = Math.min(Math.max(rawEnd, start), bounds.dayEnd);
    const key = iv.elementTypeId ?? "";
    let lane = lanes.get(key);
    if (!lane) {
      lane = { id: key || "uden-type", label: iv.elementTypeName ?? "Uden type", bars: [], totalSeconds: 0 };
      lanes.set(key, lane);
    }
    lane.bars.push({
      interval: iv,
      start,
      end,
      tone: iv.status === "open" ? "active" : iv.isRework ? "alert" : "default",
    });
    lane.totalSeconds += iv.duration.seconds ?? 0;
    first = Math.min(first, start);
    last = Math.max(last, end);
  }

  if (lanes.size === 0) return { axisStart: bounds.dayStart, axisEnd: bounds.dayEnd, lanes: [], missingOut };

  const axisStart = Math.max(bounds.dayStart, Math.floor(first / HOUR) * HOUR);
  let axisEnd = Math.min(bounds.dayEnd, Math.ceil(last / HOUR) * HOUR);
  if (axisEnd <= axisStart) axisEnd = Math.min(bounds.dayEnd, axisStart + HOUR);
  return { axisStart, axisEnd, lanes: [...lanes.values()], missingOut };
}

/**
 * The top of the trend chart's scale: the largest weekly time per piece or
 * normal plus a tenth, rounded up to a whole minute (at least one). Null when no week
 * has a figure.
 */
export function trendScaleMax(points: ReadonlyArray<StationTrendPoint>): number | null {
  let max = 0;
  for (const p of points) {
    max = Math.max(max, p.timePerPiece.seconds ?? 0, p.normalSeconds ?? 0);
  }
  if (max <= 0) return null;
  // A tenth of headroom, so a normal mark at the top stays visible.
  return Math.max(60, Math.ceil((max * 1.1) / 60) * 60);
}
