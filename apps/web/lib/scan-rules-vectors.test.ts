// Runs the shared scan-rule vectors (docs/scan-rules-vectors.json, also run by
// the station app's tests) through lib/report.ts, so the reports site and the
// operators' screen pair scans the same way. The file's "_doc" describes the
// format; this follows it step by step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pairScans } from "@/lib/report";
import { eventField, parseBarcode, type Direction, type Scan } from "@/lib/scans";

interface VectorEvent {
  id: string;
  barcode: string;
  stationNo: number;
  station: string;
  stationKind: string;
  direction: Direction;
  /** The row's Event; missing means Scan. */
  event?: string;
  time: string;
  durationSec: number | null;
}

interface VectorCase {
  name: string;
  now: string;
  todayStart: string;
  windowStart: string;
  /** "Max i gang" per station number, as a string key. A station not listed has 1. */
  maxOpen?: Record<string, number>;
  /** Waits for a rule not built yet (see the file's _doc). Skipped unless its tag is in BUILT. */
  needs?: string;
  events: VectorEvent[];
  expected: {
    /** endEvent ShiftEnd: auto-stopped. activeSec: compared when given. */
    done: { barcode: string; stationNo: number; start: string; end: string; activeSec?: number; endEvent?: string }[];
    inProgress: { stationNo: number; barcode: string; since: string }[];
  };
}

const file = fileURLToPath(new URL("../../../docs/scan-rules-vectors.json", import.meta.url));
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: VectorCase[] };

const ms = (iso: string) => Date.parse(iso);

// The "needs" tags lib/report.ts follows. "events" (pause chains) is for the
// read model's pairing only: lib/report.ts is the old pairing and never gets it.
const BUILT: string[] = ["shift-end"];
const ready = cases.filter((c) => !c.needs || BUILT.includes(c.needs));
const waiting = cases.filter((c) => !ready.includes(c));

function toScan(e: VectorEvent): Scan {
  const parts = parseBarcode(e.barcode);
  if (!parts) throw new Error(`bad barcode in vectors: ${e.barcode}`);
  return {
    id: e.id,
    barcode: e.barcode,
    orderNo: parts.orderNo,
    position: parts.position,
    subPosition: parts.subPosition,
    piece: parts.piece,
    station: e.station,
    stationNo: e.stationNo,
    stationKind: e.stationKind,
    direction: e.direction,
    time: ms(e.time),
    durationSec: e.durationSec,
    device: null,
    ...eventField(e.event),
  };
}

/** In progress compares sorted by stationNo, then since, then barcode. */
const byStationSince = (
  a: { stationNo: number; since: number; barcode: string },
  b: { stationNo: number; since: number; barcode: string }
) => a.stationNo - b.stationNo || a.since - b.since || a.barcode.localeCompare(b.barcode);

describe("shared scan-rule vectors", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.skip.each(waiting.map((c) => [c.name] as const))("%s", () => {});

  it.each(ready.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const now = ms(c.now);
    const todayStart = ms(c.todayStart);
    const windowStart = ms(c.windowStart);

    // Events before the window are never read.
    const scans = c.events.map(toScan).filter((s) => s.time >= windowStart);
    const maxOpen = Object.fromEntries(Object.entries(c.maxOpen ?? {}).map(([no, n]) => [Number(no), n]));
    const intervals = pairScans(scans, now, maxOpen);

    const done = intervals
      .filter((iv) => !iv.inProgress && iv.end >= todayStart)
      .map((iv) => ({
        barcode: iv.barcode,
        stationNo: iv.stationNo,
        start: iv.start,
        end: iv.end,
        activeSec: (iv.end - iv.start) / 1000,
        autoStopped: iv.autoStopped,
      }))
      .sort((a, b) => a.end - b.end || (a.stationNo ?? 0) - (b.stationNo ?? 0) || a.barcode.localeCompare(b.barcode));
    const expectedDone = c.expected.done
      .map((d) => ({
        barcode: d.barcode,
        stationNo: d.stationNo,
        start: ms(d.start),
        end: ms(d.end),
        activeSec: d.activeSec ?? (ms(d.end) - ms(d.start)) / 1000,
        autoStopped: d.endEvent === "ShiftEnd",
      }))
      .sort((a, b) => a.end - b.end || a.stationNo - b.stationNo || a.barcode.localeCompare(b.barcode));
    expect(done).toEqual(expectedDone);

    const inProgress = intervals
      .filter((iv) => iv.inProgress)
      .map((iv) => ({ stationNo: iv.stationNo ?? 0, barcode: iv.barcode, since: iv.start }))
      .sort(byStationSince);
    const expectedInProgress = c.expected.inProgress
      .map((p) => ({ stationNo: p.stationNo, barcode: p.barcode, since: ms(p.since) }))
      .sort(byStationSince);
    expect(inProgress).toEqual(expectedInProgress);
  });
});
