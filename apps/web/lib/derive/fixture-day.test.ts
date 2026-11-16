// A realistic run: the five working days of fixtures/scans.json (about 4,400
// scans, 51 orders, 7 stations). Where the read model and the old reports
// (lib/report.ts) define a figure the same way, they must agree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeKpis,
  intervalsEndingIn,
  pairScans,
  stationKey,
  summarizeOrders,
  summarizeStations,
} from "@/lib/report";
import { parseScanRow, type MasterDataRow, type Scan } from "@/lib/scans";
import { dayEnd, dayStart, MS_PER_DAY } from "@/lib/time";
import { DEFAULT_CALENDAR } from "./calendar";
import { deriveOrders } from "./order";
import { pairHistory } from "./pairing";
import { affectedBy, stationDaysTouched } from "./plan";
import { deriveStationDay } from "./station";
import type { DerivedOrder, StationDayFactsRow } from "./types";

const file = fileURLToPath(new URL("../../fixtures/scans.json", import.meta.url));
const fixture = JSON.parse(readFileSync(file, "utf8")) as { referenceDay: string; rows: MasterDataRow[] };
const scans = fixture.rows.map(parseScanRow).filter((s): s is Scan => s != null);
const DAY = fixture.referenceDay;
const from = dayStart(DAY);
const to = dayEnd(DAY);

// Seen at the end of the reference day.
const now = to;
const ctx = { now, calendar: DEFAULT_CALENDAR };
const derived = deriveOrders(scans, [], ctx);
const rows = derived.flatMap((d) => d.intervals);
const old = pairScans(scans, now);

const key = (iv: { barcode: string; stationNo: number | null; start: number; end: number | null }) =>
  `${iv.barcode}|${iv.stationNo}|${iv.start}|${iv.end}`;

describe("fixture days: the read model against lib/report.ts", () => {
  it("reads the fixture", () => {
    expect(scans.length).toBe(fixture.rows.length);
    expect(scans.length).toBeGreaterThan(4000);
    expect(derived.length).toBe(new Set(scans.map((s) => s.orderNo)).size);
  });

  it("pairs the same done and in-progress intervals", () => {
    const mine = pairHistory(scans, { now });
    const done = (list: { barcode: string; stationNo: number | null; start: number; end: number | null }[]) => list.map(key).sort();
    expect(done(mine.filter((iv) => iv.status === "done"))).toEqual(done(old.filter((iv) => !iv.inProgress)));
    expect(done(mine.filter((iv) => iv.status === "open").map((iv) => ({ ...iv, end: null })))).toEqual(
      done(old.filter((iv) => iv.inProgress).map((iv) => ({ ...iv, end: null })))
    );
    // Visits are numbered the same way.
    const visits = new Map(old.map((iv) => [`${iv.barcode}|${iv.stationNo}|${iv.start}`, iv.visit]));
    for (const iv of mine.filter((m) => m.status !== "missing_out")) {
      expect(iv.visit).toBe(visits.get(`${iv.barcode}|${iv.stationNo}|${iv.start}`));
    }
  });

  it("per order: time, rework and element count agree", () => {
    const summaries = new Map(summarizeOrders(old, scans).map((o) => [o.orderNo, o]));
    expect(summaries.size).toBe(derived.length);
    for (const d of derived) {
      const o = summaries.get(d.order.orderNo)!;
      // touchSeconds is rounded per station kind, totalMs is exact.
      expect(Math.abs(d.order.touchSeconds - o.totalMs / 1000)).toBeLessThanOrEqual(1);
      expect(d.order.reworkCount).toBe(o.reworkPasses);
      expect(d.order.elementsSeen).toBe(o.elements);
      expect(Date.parse(d.order.firstScanAt)).toBe(o.firstScan);
      expect(d.order.openCount > 0).toBe(o.status === "active");
    }
  });

  it("per station on the reference day: count and mean time agree", () => {
    const today = intervalsEndingIn(old, from, to);
    const stations = summarizeStations(today, { from, until: now });
    expect(stations.length).toBe(7);
    for (const s of stations) {
      const f = deriveStationDay(s.stationNo as number, DAY, rows, ctx) as StationDayFactsRow;
      expect(f.countThrough).toBe(s.done);
      expect(f.station).toBe(s.station);
      expect(Math.abs((f.meanPieceSeconds as number) - (s.averageMs as number) / 1000)).toBeLessThanOrEqual(1);
      expect(f.openCount).toBe(s.active);
      // The median is the headline; it can never be above the largest pass.
      expect(f.timePerPieceSeconds).toBeGreaterThan(0);
      expect(f.busyInShiftSeconds).toBeLessThanOrEqual(f.availableSeconds);
      expect(f.busySeconds + f.idleSeconds).toBeGreaterThan(0);
    }
  });

  it("the day's KPIs agree", () => {
    const today = intervalsEndingIn(old, from, to);
    const kpis = computeKpis(today, summarizeOrders(today, scans.filter((s) => s.time >= from && s.time < to)));
    const todayRows = rows.filter((r) => r.status !== "missing_out" && r.localDay === DAY);
    expect(new Set(todayRows.map((r) => r.barcode)).size).toBe(kpis.elements);
    expect(new Set(todayRows.map((r) => r.orderNo)).size).toBe(kpis.orders);
    expect(new Set(todayRows.filter((r) => r.status === "done" && r.stationKind === "packing").map((r) => r.orderNo)).size).toBe(
      kpis.ordersAtPacking
    );
    const facts = [1, 2, 3, 4, 5, 6, 7].map((no) => deriveStationDay(no, DAY, rows, ctx) as StationDayFactsRow);
    expect(facts.reduce((t, f) => t + f.countThrough, 0)).toBe(today.filter((iv) => !iv.inProgress).length);
  });

  it("every order's steps add up to its elapsed time, on the wall clock and in shift time", () => {
    const check = (d: DerivedOrder) => {
      const counted = d.steps.filter((s) => s.countsInLead && s.durationSeconds != null);
      expect(counted.reduce((t, s) => t + (s.durationSeconds as number), 0)).toBe(d.order.elapsedSeconds);
      expect(counted.reduce((t, s) => t + (s.durationWorkingSeconds as number), 0)).toBe(d.order.elapsedWorkingSeconds);
      expect(d.order.workSeconds + d.order.waitSeconds).toBe(d.order.elapsedSeconds);
      expect(d.steps).toHaveLength(7);
    };
    derived.forEach(check);
    // Two days later the quiet orders count as packed (no documents in the fixture).
    const later = deriveOrders(scans, [], { now: now + 2 * MS_PER_DAY, calendar: DEFAULT_CALENDAR });
    later.forEach(check);
    const packed = later.filter((d) => d.order.status === "packed");
    expect(packed.length).toBeGreaterThan(20);
    for (const d of packed) {
      expect(d.order.packedSource).toBe("scans");
      expect(d.order.leadSeconds).toBe(Math.round((Date.parse(d.order.packedAt as string) - Date.parse(d.order.startAt)) / 1000));
      // Shift time can never be more than wall clock.
      expect(d.order.leadWorkingSeconds as number).toBeLessThanOrEqual(d.order.leadSeconds as number);
      expect(d.order.elementsPacked).toBe(d.order.elementsSeen);
    }
  });

  it("an order derived alone equals the same order derived with all the others", () => {
    // What the incremental writer relies on: only the affected orders' scans are loaded.
    for (const d of derived.slice(0, 12)) {
      const alone = deriveOrders(scans.filter((s) => s.orderNo === d.order.orderNo), [], ctx)[0];
      if (d.order.openCount === 0 && d.order.missingScanOutCount === 0) expect(alone).toEqual(d);
      else expect(alone.order.orderNo).toBe(d.order.orderNo);
    }
  });

  it("the plan for the last hour of scans covers the orders and station days they changed", () => {
    const cut = Math.max(...scans.map((s) => s.time)) - 3_600_000;
    const fresh = scans.filter((s) => s.time > cut);
    const plan = affectedBy(fresh);
    const before = deriveOrders(scans.filter((s) => s.time <= cut), [], ctx);
    const changed = derived.filter((d) => JSON.stringify(d) !== JSON.stringify(before.find((b) => b.order.orderNo === d.order.orderNo)));
    for (const d of changed) expect(plan.orderNos).toContain(d.order.orderNo);
    const touched = new Set(
      stationDaysTouched(derived.filter((d) => plan.orderNos.includes(d.order.orderNo)).flatMap((d) => d.intervals), now).map(
        (sd) => `${sd.stationNo}:${sd.localDay}`
      )
    );
    for (const sd of plan.stationDays) expect(touched.has(`${sd.stationNo}:${sd.localDay}`)).toBe(true);
    expect(new Set(fresh.map(stationKey)).size).toBe(new Set(plan.stationDays.map((sd) => sd.stationNo)).size);
  });
});
