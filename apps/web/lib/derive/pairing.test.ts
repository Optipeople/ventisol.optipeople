import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBarcode, type Direction, type Scan } from "@/lib/scans";
import { at, pass, scan } from "@/lib/test-helpers";
import { pairHistory } from "./pairing";

// ---------------------------------------------------------------------------
// The shared vectors (docs/scan-rules-vectors.json), as its _doc says to run
// them, and once more over the full history with no read window: the read
// model has no window, and must still count the same.
// ---------------------------------------------------------------------------

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
  /** "Max i gang" per station number, as a string key. A station not listed has 1. */
  maxOpen?: Record<string, number>;
  events: VectorEvent[];
  expected: {
    done: { barcode: string; stationNo: number; start: string; end: string }[];
    inProgress: { stationNo: number; barcode: string; since: string }[];
  };
}

const file = fileURLToPath(new URL("../../../../docs/scan-rules-vectors.json", import.meta.url));
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: VectorCase[] };
const ms = (iso: string) => Date.parse(iso);

function toScan(e: VectorEvent): Scan {
  const parts = parseBarcode(e.barcode);
  if (!parts) throw new Error(`bad barcode in vectors: ${e.barcode}`);
  return { ...parts, id: e.id, barcode: e.barcode, station: e.station, stationNo: e.stationNo, stationKind: e.stationKind, direction: e.direction, time: ms(e.time), durationSec: e.durationSec, device: null };
}

const maxOpenOf = (c: VectorCase) =>
  Object.fromEntries(Object.entries(c.maxOpen ?? {}).map(([stationNo, n]) => [Number(stationNo), n]));

/** In progress compares sorted by stationNo, then since, then barcode. */
const byStationSince = (
  a: { stationNo: number; since: number; barcode: string },
  b: { stationNo: number; since: number; barcode: string }
) => a.stationNo - b.stationNo || a.since - b.since || a.barcode.localeCompare(b.barcode);

function check(c: VectorCase, scans: Scan[]) {
  const intervals = pairHistory(scans, { now: ms(c.now), maxOpen: maxOpenOf(c) });
  const done = intervals
    .filter((iv) => iv.status === "done" && (iv.end as number) >= ms(c.todayStart))
    .map((iv) => ({ barcode: iv.barcode, stationNo: iv.stationNo, start: iv.start, end: iv.end }))
    .sort((a, b) => (a.end as number) - (b.end as number) || a.stationNo - b.stationNo || a.barcode.localeCompare(b.barcode));
  const expectedDone = c.expected.done
    .map((d) => ({ barcode: d.barcode, stationNo: d.stationNo, start: ms(d.start), end: ms(d.end) }))
    .sort((a, b) => a.end - b.end || a.stationNo - b.stationNo || a.barcode.localeCompare(b.barcode));
  expect(done).toEqual(expectedDone);

  const inProgress = intervals
    .filter((iv) => iv.status === "open")
    .map((iv) => ({ stationNo: iv.stationNo, barcode: iv.barcode, since: iv.start }))
    .sort(byStationSince);
  const expectedInProgress = c.expected.inProgress
    .map((p) => ({ stationNo: p.stationNo, barcode: p.barcode, since: ms(p.since) }))
    .sort(byStationSince);
  expect(inProgress).toEqual(expectedInProgress);
}

describe("shared scan-rule vectors against pairHistory", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));

  it.each(cases.map((c) => [c.name, c] as const))("windowed: %s", (_n, c) => {
    check(c, c.events.map(toScan).filter((s) => s.time >= ms(c.windowStart)));
  });

  it.each(cases.map((c) => [c.name, c] as const))("full history: %s", (_n, c) => {
    check(c, c.events.map(toScan));
  });
});

// ---------------------------------------------------------------------------
// What the read model adds: missing scan-outs, visits, scan ids
// ---------------------------------------------------------------------------

const NOW = at("12:00");

describe("pairHistory", () => {
  it("keeps the scan ids of a pair", () => {
    const [a, b] = pass(at("07:00"), at("07:10"));
    const [iv] = pairHistory([b, a], { now: NOW });
    expect(iv).toMatchObject({ id: a.id, inScanId: a.id, outScanId: b.id, status: "done", visit: 1, stationKind: "assembly" });
  });

  it("an In with no Out is open while recent, a missing scan-out after 36 hours", () => {
    const open = scan("In", at("07:00"));
    expect(pairHistory([open], { now: at("07:00") + 36 * 3_600_000 })[0]).toMatchObject({ status: "open", end: null, visit: 1 });
    expect(pairHistory([open], { now: at("07:00") + 36 * 3_600_000 + 1 })[0]).toMatchObject({
      status: "missing_out",
      missingReason: "stale",
      end: null,
      visit: null,
    });
  });

  it("the stale limit is a parameter", () => {
    const open = scan("In", at("07:00"));
    expect(pairHistory([open], { now: at("09:01"), staleOpenSeconds: 7200 })[0].status).toBe("missing_out");
  });

  it("a double In keeps the later one and lists the earlier as a missing scan-out", () => {
    const first = scan("In", at("07:00"));
    const second = scan("In", at("07:30"));
    const out = scan("Out", at("07:40"), { durationSec: 600 });
    const ivs = pairHistory([first, second, out], { now: NOW });
    expect(ivs.map((iv) => [iv.id, iv.status, iv.missingReason, iv.visit])).toEqual([
      [first.id, "missing_out", "superseded", null],
      [second.id, "done", null, 1],
    ]);
  });

  it("a missing scan-out does not make the next pass a rework", () => {
    const ivs = pairHistory(
      [scan("In", at("07:00")), ...pass(at("08:00"), at("08:10")), ...pass(at("09:00"), at("09:05"))],
      { now: NOW }
    );
    expect(ivs.map((iv) => iv.visit)).toEqual([null, 1, 2]);
  });

  it("rework visits are numbered per station", () => {
    const ivs = pairHistory(
      [
        ...pass(at("07:00"), at("07:10")),
        ...pass(at("07:20"), at("07:30"), { station: "Station 20", stationNo: 2 }),
        ...pass(at("08:00"), at("08:05")),
      ],
      { now: NOW }
    );
    expect(ivs.map((iv) => [iv.stationNo, iv.visit])).toEqual([[1, 1], [2, 1], [1, 2]]);
  });

  it("two elements open at one station: the earlier is a missing scan-out", () => {
    const a = scan("In", at("07:00"));
    const b = scan("In", at("07:30"), { barcode: "058556050102", piece: 2 });
    const ivs = pairHistory([a, b], { now: NOW });
    expect(ivs.map((iv) => [iv.id, iv.status])).toEqual([[a.id, "missing_out"], [b.id, "open"]]);
  });

  it("an open In older than another order's open In at the station is a missing scan-out", () => {
    const a = scan("In", at("07:00"));
    expect(pairHistory([a], { now: NOW, otherOpenInsByStation: { 1: [at("08:00")] } })[0]).toMatchObject({
      status: "missing_out",
      missingReason: "superseded",
    });
    expect(pairHistory([a], { now: NOW, otherOpenInsByStation: { 1: [at("06:00")], 2: [at("09:00")] } })[0].status).toBe("open");
    // A tie in time: the In handed in stays open, as before.
    expect(pairHistory([a], { now: NOW, otherOpenInsByStation: { 1: [at("07:00")] } })[0].status).toBe("open");
  });

  it("at a station with Max i gang 3, three elements are open at once and a fourth supersedes the oldest", () => {
    const el = (piece: number, time: number) =>
      scan("In", time, { barcode: `0585560501${String(piece).padStart(2, "0")}`, piece });
    const ins = [el(1, at("07:00")), el(2, at("07:10")), el(3, at("07:20"))];
    expect(pairHistory(ins, { now: NOW, maxOpen: { 1: 3 } }).map((iv) => iv.status)).toEqual(["open", "open", "open"]);
    // The other stations keep 1.
    expect(pairHistory(ins, { now: NOW, maxOpen: { 2: 3 } }).map((iv) => iv.status)).toEqual([
      "missing_out",
      "missing_out",
      "open",
    ]);
    const ivs = pairHistory([...ins, el(4, at("07:30"))], { now: NOW, maxOpen: { 1: 3 } });
    expect(ivs.map((iv) => [iv.piece, iv.status, iv.missingReason])).toEqual([
      [1, "missing_out", "superseded"],
      [2, "open", null],
      [3, "open", null],
      [4, "open", null],
    ]);
  });

  it("at a station with Max i gang 3, the open Ins of other orders take their places too", () => {
    const a = scan("In", at("07:00"));
    const b = scan("In", at("07:20"), { barcode: "058556050102", piece: 2 });
    const others = { 1: [at("07:10"), at("07:30")] };
    const ivs = pairHistory([a, b], { now: NOW, maxOpen: { 1: 3 }, otherOpenInsByStation: others });
    expect(ivs.map((iv) => [iv.id, iv.status])).toEqual([[a.id, "missing_out"], [b.id, "open"]]);
    expect(
      pairHistory([a, b], { now: NOW, maxOpen: { 1: 4 }, otherOpenInsByStation: others }).map((iv) => iv.status)
    ).toEqual(["open", "open"]);
  });

  it("an Out with no In is timed back from DurationSec, over any distance", () => {
    const out = scan("Out", at("07:00"), { durationSec: 5 * 86_400 });
    expect(pairHistory([out], { now: NOW })[0]).toMatchObject({
      start: at("07:00") - 5 * 86_400_000,
      end: at("07:00"),
      startEstimated: true,
      inScanId: null,
      outScanId: out.id,
    });
  });

  it("pairs over weeks: there is no read window", () => {
    const a = scan("In", at("07:00", "2026-09-01"));
    const b = scan("Out", at("07:00", "2026-10-20"));
    expect(pairHistory([a, b], { now: NOW })[0]).toMatchObject({ status: "done", start: a.time, end: b.time, startEstimated: false });
  });

  it("a scan with no station number gets station 0", () => {
    const [iv] = pairHistory(pass(at("07:00"), at("07:10"), { stationNo: null }), { now: NOW });
    expect(iv).toMatchObject({ stationNo: 0, status: "done" });
  });
});
