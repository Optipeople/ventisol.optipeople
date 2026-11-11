// Runs the shared scan-rule vectors (docs/scan-rules-vectors.json, also run by
// the station app's tests) through lib/report.ts, so the reports site and the
// operators' screen pair scans the same way. The file's "_doc" describes the
// format; this follows it step by step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pairScans } from "@/lib/report";
import { parseBarcode, type Direction, type Scan } from "@/lib/scans";

interface VectorEvent {
  id: string;
  barcode: string;
  stationNo: number;
  station: string;
  stationKind: string;
  direction: Direction;
  time: string;
  durationSec: number | null;
}

interface VectorCase {
  name: string;
  now: string;
  todayStart: string;
  windowStart: string;
  events: VectorEvent[];
  expected: {
    done: { barcode: string; stationNo: number; start: string; end: string }[];
    inProgress: { stationNo: number; barcode: string; since: string }[];
  };
}

const file = fileURLToPath(new URL("../../../docs/scan-rules-vectors.json", import.meta.url));
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: VectorCase[] };

const ms = (iso: string) => Date.parse(iso);

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
  };
}

describe("shared scan-rule vectors", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const now = ms(c.now);
    const todayStart = ms(c.todayStart);
    const windowStart = ms(c.windowStart);

    // Events before the window are never read.
    const scans = c.events.map(toScan).filter((s) => s.time >= windowStart);
    const intervals = pairScans(scans, now);

    const done = intervals
      .filter((iv) => !iv.inProgress && iv.end >= todayStart)
      .map((iv) => ({ barcode: iv.barcode, stationNo: iv.stationNo, start: iv.start, end: iv.end }))
      .sort((a, b) => a.end - b.end || (a.stationNo ?? 0) - (b.stationNo ?? 0) || a.barcode.localeCompare(b.barcode));
    const expectedDone = c.expected.done
      .map((d) => ({ barcode: d.barcode, stationNo: d.stationNo, start: ms(d.start), end: ms(d.end) }))
      .sort((a, b) => a.end - b.end || a.stationNo - b.stationNo || a.barcode.localeCompare(b.barcode));
    expect(done).toEqual(expectedDone);

    const inProgress = intervals
      .filter((iv) => iv.inProgress)
      .map((iv) => ({ stationNo: iv.stationNo, barcode: iv.barcode, since: iv.start }))
      .sort((a, b) => (a.stationNo ?? 0) - (b.stationNo ?? 0));
    const expectedInProgress = c.expected.inProgress
      .map((p) => ({ stationNo: p.stationNo, barcode: p.barcode, since: ms(p.since) }))
      .sort((a, b) => a.stationNo - b.stationNo);
    expect(inProgress).toEqual(expectedInProgress);
  });
});
