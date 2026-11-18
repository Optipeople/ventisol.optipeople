// Split time: each pass's share of its station's time when several elements
// are on the station at once (docs/read-model.md §2, "Split time: parallel
// work"). Pure.
//
// The station's timeline is cut at every start and end of its done and open
// passes. In each piece the passes on the station share the piece's length by
// weight, and the working variant shares the piece's shift time the same way.
// A pass alone on its station gets its whole time, so at a station with one
// element at a time the split time equals the wall-clock time.

import { workingMsBetween } from "./calendar";
import type { WorkCalendar } from "./types";

/**
 * How the pieces are shared (config.settings.parallel_split).
 *   calculated: by the pass's calculated time at the station; a piece where a
 *               pass has none is shared equally.
 *   equal:      every pass weighs the same.
 */
export type ParallelSplit = "calculated" | "equal";

export const PARALLEL_SPLITS: readonly ParallelSplit[] = ["calculated", "equal"];
export const DEFAULT_PARALLEL_SPLIT: ParallelSplit = "calculated";

export interface SplitPass {
  id: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms: the Out, or now for a pass still open. */
  end: number;
  /** The calculated seconds of the pass's element type here. Null or 0: none known. */
  weight: number | null;
}

export interface SplitShare {
  seconds: number;
  workingSeconds: number;
}

/**
 * The share of every pass of ONE station. Hand in every done and open pass of
 * the station that overlaps the passes whose share you want (a pass's share
 * depends on the passes beside it); leave missing scan-outs out. Rounded to
 * whole seconds per pass. By pass id.
 */
export function splitStationTime(
  passes: SplitPass[],
  mode: ParallelSplit,
  calendar: WorkCalendar
): Map<string, SplitShare> {
  const ms = new Map<string, { wall: number; working: number }>();
  for (const p of passes) ms.set(p.id, { wall: 0, working: 0 });

  // A sweep over the cut points; the passes on the station between two
  // points stay the same.
  const timed = passes.filter((p) => p.end > p.start);
  const points = [...new Set(timed.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const byStart = [...timed].sort((a, b) => a.start - b.start);
  let next = 0;
  let active: SplitPass[] = [];

  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    active = active.filter((p) => p.end > from);
    while (next < byStart.length && byStart[next].start <= from) active.push(byStart[next++]);
    if (active.length === 0) continue;

    const wall = to - from;
    const working = workingMsBetween(from, to, calendar);
    if (active.length === 1) {
      const share = ms.get(active[0].id) as { wall: number; working: number };
      share.wall += wall;
      share.working += working;
      continue;
    }
    const weighed = mode === "calculated" && active.every((p) => p.weight != null && p.weight > 0);
    const weights = active.map((p) => (weighed ? (p.weight as number) : 1));
    const total = weights.reduce((t, w) => t + w, 0);
    active.forEach((p, k) => {
      const share = ms.get(p.id) as { wall: number; working: number };
      share.wall += (wall * weights[k]) / total;
      share.working += (working * weights[k]) / total;
    });
  }

  const out = new Map<string, SplitShare>();
  for (const [id, share] of ms) {
    out.set(id, { seconds: Math.round(share.wall / 1000), workingSeconds: Math.round(share.working / 1000) });
  }
  return out;
}
