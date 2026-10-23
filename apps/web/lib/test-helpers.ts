// Builders for the unit tests. Not imported by the app.

import type { Direction, Scan } from "@/lib/scans";

let seq = 0;

/** Copenhagen wall-clock on 2026-10-21 (CEST, UTC+2) as epoch ms. */
export function at(hhmm: string, day = "2026-10-21"): number {
  return Date.parse(`${day}T${hhmm}:00+02:00`);
}

export function scan(
  direction: Direction,
  time: number,
  over: Partial<Scan> = {}
): Scan {
  seq++;
  return {
    id: `s${seq}`,
    barcode: "058556050103",
    orderNo: 58556,
    position: 5,
    subPosition: 1,
    piece: 3,
    station: "Station 10",
    stationNo: 1,
    stationKind: "Assembly",
    direction,
    time,
    durationSec: null,
    device: "PC",
    ...over,
  };
}

/** An In/Out pair at one station; the Out carries DurationSec like the station app sends. */
export function pass(from: number, to: number, over: Partial<Scan> = {}): Scan[] {
  return [
    scan("In", from, over),
    scan("Out", to, { ...over, durationSec: Math.round((to - from) / 1000) }),
  ];
}

export const PACKING: Partial<Scan> = { station: "Pakning", stationNo: 7, stationKind: "Packing" };
