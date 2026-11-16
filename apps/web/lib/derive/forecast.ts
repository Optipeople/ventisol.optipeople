// "Er nu ved" and the expected-ready time of an order in progress. Pure.
//
// Forecast v1 is an ESTIMATE, kept simple enough to explain in one breath:
//
//   For every element not packed yet, take the typical time at each station it
//   still has to pass. Add those up per station: that is each station's load
//   from this order. Stations work side by side, so the order needs the
//   largest load (the bottleneck), plus one typical piece time at each other
//   station still in play (the last piece has to get through those too), plus
//   the typical wait before packing while packing has not begun. That many
//   shift seconds from now is "Forventet klar".
//
// It does not know about other orders queueing at the same stations.

import { addWorkingSeconds } from "./calendar";
import { STEP_LABELS, type OrderRow, type TypicalStation, type TypicalTimes, type WorkCalendar } from "./types";

export interface ForecastElement {
  elementTypeId: string | null;
  packed: boolean;
  /** Stations with a finished pass. */
  doneStationNos: number[];
  /** The station it is on now, and since when (epoch ms). */
  openAt: { stationNo: number; since: number } | null;
}

export interface ForecastInput {
  now: number;
  /** Elements seen in scans. */
  elements: ForecastElement[];
  /** Elements on the 3E list that no scan has shown yet. */
  unseen: { elementTypeId: string | null; count: number }[];
  /** A packing In exists on the order. */
  packingStarted: boolean;
}

function typicalAt(station: TypicalStation, elementTypeId: string | null): number | null {
  const byType = elementTypeId != null ? station.secondsByType?.[elementTypeId] : undefined;
  return byType ?? station.seconds;
}

/**
 * Shift seconds of work the order still needs, or null when no typical time
 * is known for anything that remains. A station an element has passed, or
 * that lies before the furthest station it has reached, needs nothing more.
 */
export function forecastRemainingSeconds(input: ForecastInput, typical: TypicalTimes): number | null {
  const route = typical.stations;
  const load = new Array<number>(route.length).fill(0);
  const pieces = new Array<number>(route.length).fill(0);
  let known = false;
  let anythingLeft = false;

  const add = (i: number, seconds: number | null, weight: number) => {
    if (seconds == null) return;
    known = true;
    load[i] += seconds * weight;
    pieces[i] += weight;
  };

  for (const el of input.elements) {
    if (el.packed) continue;
    anythingLeft = true;
    const reached = new Set(el.doneStationNos);
    if (el.openAt) reached.add(el.openAt.stationNo);
    let furthest = -1;
    route.forEach((s, i) => {
      if (reached.has(s.stationNo)) furthest = i;
    });
    route.forEach((s, i) => {
      const t = typicalAt(s, el.elementTypeId);
      if (el.openAt?.stationNo === s.stationNo) {
        if (t != null) add(i, Math.max(0, t - (input.now - el.openAt.since) / 1000), 1);
        return;
      }
      if (i <= furthest || el.doneStationNos.includes(s.stationNo)) return;
      add(i, t, s.share ?? 1);
    });
  }
  for (const u of input.unseen) {
    if (u.count <= 0) continue;
    anythingLeft = true;
    route.forEach((s, i) => add(i, typicalAt(s, u.elementTypeId), (s.share ?? 1) * u.count));
  }

  if (!anythingLeft) return 0;
  if (!known) return null;

  let bottleneck = 0;
  for (let i = 1; i < route.length; i++) if (load[i] > load[bottleneck]) bottleneck = i;
  let total = load[bottleneck];
  route.forEach((_, i) => {
    if (i !== bottleneck && pieces[i] > 0) total += load[i] / pieces[i];
  });
  if (!input.packingStarted && typical.waitBeforePackingSeconds != null) total += typical.waitBeforePackingSeconds;
  return Math.round(total);
}

export interface Forecast {
  remainingSeconds: number;
  /** Epoch ms. Null when the calendar has no shift to do the work in. */
  readyAt: number | null;
}

/** The estimate, or null when nothing is known to estimate from. */
export function forecastOrder(input: ForecastInput, typical: TypicalTimes, calendar: WorkCalendar): Forecast | null {
  const remainingSeconds = forecastRemainingSeconds(input, typical);
  if (remainingSeconds == null) return null;
  return { remainingSeconds, readyAt: addWorkingSeconds(input.now, remainingSeconds, calendar) };
}

/**
 * "Er nu ved": the stations the order has an element on, else the step it is
 * waiting in. Danish, for the UI.
 */
export function currentLabel(
  order: Pick<OrderRow, "status" | "currentStep" | "currentStationNos">,
  stationNames: Record<number, string> = {}
): string {
  if (order.status === "packed") return "Pakket";
  if (order.currentStationNos.length > 0) {
    return order.currentStationNos.map((no) => stationNames[no] ?? `Station nr. ${no}`).join(", ");
  }
  if (order.currentStep === "assembly") return "Montage, venter";
  return order.currentStep ? STEP_LABELS[order.currentStep] : "Ukendt";
}
