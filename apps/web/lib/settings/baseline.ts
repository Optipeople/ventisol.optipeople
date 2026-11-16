// "Foreslå fra baseline" on Indstillinger > Tider: the measured median pass
// time per station and element type (rpt.baseline_suggestion, through
// getBaselineSuggestion) as a proposal for the normal times.
//
// Two steps, never one: `loadBaselineProposal` only reads and returns the
// proposal for the user to review; `applyBaselineProposal` saves the rows the
// user kept through saveTimes, which validates and audits each change. Both
// check the times.edit capability themselves (the friendly line); row level
// security is the real enforcement, as everywhere in lib/settings.

import { z } from "zod";
import type { Claims } from "@/lib/db";
import { can } from "@/lib/portal/roles";
import { getBaselineSuggestion } from "@/lib/reports";
import type { BaselineSuggestionRow } from "@/lib/reports/types";
import { addDays, dayKey } from "@/lib/time";
import { listElementTypes } from "./element-types";
import { formatMinutes, MAX_TIME_MINUTES } from "./format";
import { fail, FORBIDDEN_MESSAGE, type ActionFail, type ActionResult } from "./result";
import { listStations } from "./stations";
import { saveTimes, type TimeEntry } from "./times";

/** The window the proposal is measured over: the last eight whole weeks. */
export const BASELINE_WEEKS = 8;

/** Pairs with fewer finished passes in the window are left out. */
export const BASELINE_MIN_SAMPLES = 5;

/** The eight weeks of days that end yesterday (Copenhagen): today is not over. */
export function baselineWindow(now: number): { from: string; to: string } {
  const to = addDays(dayKey(now), -1);
  return { from: addDays(to, -(BASELINE_WEEKS * 7 - 1)), to };
}

/** One row of the proposal, as the preview shows it. */
export interface BaselineProposalRow {
  stationNo: number;
  stationName: string;
  elementTypeId: string;
  elementTypeName: string;
  /** The normal time in force, whole seconds, or null when none is set. */
  currentSeconds: number | null;
  /** The measured median, whole seconds. */
  suggestedSeconds: number;
  samples: number;
}

export interface BaselineProposal {
  ok: true;
  period: { from: string; to: string };
  weeks: number;
  minSamples: number;
  /** Pairs whose suggestion differs from the normal time in force. */
  rows: BaselineProposalRow[];
  /** Pairs that already have exactly the suggested time. */
  unchanged: number;
}

export type BaselineProposalResult = BaselineProposal | ActionFail;

/**
 * The suggestion rows that can become a normal time: an element type, an
 * active station and type (the grid offers no others), a time above zero
 * that saveTimes accepts. Seconds are rounded to whole seconds, as stored.
 */
export function toProposalRows(
  rows: BaselineSuggestionRow[],
  active: { stations: ReadonlySet<number>; types: ReadonlySet<string> }
): { rows: BaselineProposalRow[]; unchanged: number } {
  const out: BaselineProposalRow[] = [];
  let unchanged = 0;
  for (const row of rows) {
    if (row.elementTypeId === null) continue;
    if (!active.stations.has(row.stationNo) || !active.types.has(row.elementTypeId)) continue;
    const suggested = Math.round(row.suggestedSeconds);
    if (!(suggested > 0) || suggested > MAX_TIME_MINUTES * 60) continue;
    if (row.currentSeconds === suggested) {
      unchanged += 1;
      continue;
    }
    out.push({
      stationNo: row.stationNo,
      stationName: row.stationName,
      elementTypeId: row.elementTypeId,
      elementTypeName: row.elementTypeName ?? row.elementTypeId,
      currentSeconds: row.currentSeconds,
      suggestedSeconds: suggested,
      samples: row.samples,
    });
  }
  return { rows: out, unchanged };
}

/** The proposal for this user to review. Reads only, writes nothing. */
export async function loadBaselineProposal(
  claims: Claims,
  now: number,
  window: { from: string; to: string } = baselineWindow(now),
  minSamples: number = BASELINE_MIN_SAMPLES
): Promise<BaselineProposalResult> {
  if (!can(claims.role, "times.edit")) return fail(FORBIDDEN_MESSAGE);
  const [suggestion, stations, types] = await Promise.all([
    getBaselineSuggestion(claims, { ...window, minSamples }),
    listStations(claims),
    listElementTypes(claims),
  ]);
  const { rows, unchanged } = toProposalRows(suggestion.rows, {
    stations: new Set(stations.filter((s) => s.active).map((s) => s.stationNo)),
    types: new Set(types.filter((t) => t.active).map((t) => t.id)),
  });
  return { ok: true, period: suggestion.period, weeks: suggestion.weeks, minSamples, rows, unchanged };
}

const keptSchema = z
  .array(
    z.object({
      stationNo: z.number().int().min(1).max(9999),
      elementTypeId: z.string().min(1).max(40),
      seconds: z.number().int().min(1).max(MAX_TIME_MINUTES * 60),
    })
  )
  .min(1)
  .max(2000);

export type BaselineKept = z.infer<typeof keptSchema>;

/** The kept rows as the cells saveTimes takes: minutes text that reads back to the same seconds. */
export function baselineEntries(kept: BaselineKept): TimeEntry[] {
  return kept.map((k) => ({
    stationNo: k.stationNo,
    elementTypeId: k.elementTypeId,
    minutes: formatMinutes(k.seconds),
  }));
}

/**
 * Saves the rows of the proposal the user kept as normal times, through
 * saveTimes (one transaction, every change audited). Nothing is saved
 * unless the user asked for exactly these rows.
 */
export async function applyBaselineProposal(claims: Claims, kept: unknown): Promise<ActionResult> {
  if (!can(claims.role, "times.edit")) return fail(FORBIDDEN_MESSAGE);
  const parsed = keptSchema.safeParse(kept);
  if (!parsed.success) return fail("Vælg mindst ét forslag at bruge.");
  const result = await saveTimes(claims, "normal", baselineEntries(parsed.data));
  if (!result.ok) return result;
  const n = parsed.data.length;
  return { ok: true, message: n === 1 ? "1 normaltid er gemt." : `${n} normaltider er gemt.` };
}
