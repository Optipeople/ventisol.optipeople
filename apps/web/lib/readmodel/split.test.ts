// "Max i gang" and split time through the read model writer, against the real
// migrations (PGlite): several elements of different orders in progress at
// once at one station, their shares, and the figures built on them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { at } from "@/lib/test-helpers";
import { applyScanChanges, onMaxOpenChanged, rebuildAll } from "./index";
import { loadConfig } from "./config";
import { replaceOrders, replaceStationDays } from "./write";
import { dayKey } from "@/lib/time";

const NOW = at("10:00");
const MIN = 60;

let db: TestDb;

const query = <T>(sql: string, params: unknown[] = []) => db.withService((q) => q.query<T>(sql, params));

/** One scan into raw.scans, at glazing station 3 unless told otherwise. */
async function scan(id: string, orderNo: number, direction: "In" | "Out", time: number, durationSec: number | null = null) {
  await query(
    `insert into raw.scans (scan_id, barcode, order_no, position, sub_position, piece, station, station_no,
                            station_kind, direction, scan_time, duration_sec, device)
     values ($1, $2, $3, 1, 1, 1, 'Glas', 3, 'Assembly', $4, $5, $6, 'PC')`,
    [id, `0${orderNo}010101`, orderNo, direction, new Date(time).toISOString(), durationSec]
  );
}

async function passes() {
  return query<{ order_no: number; status: string; missing_reason: string | null; duration_seconds: number | null; allocated_seconds: number | null }>(
    `select order_no, status, missing_reason, duration_seconds, allocated_seconds
       from core.station_intervals order by order_no`
  );
}

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

beforeEach(async () => {
  await db.reset();
  await query("insert into config.stations (station_no, name, kind, sort_order, max_open) values (3, 'Glas', 'assembly', 30, 6)");
  // Two elements 08:00 to 09:00, a third in from 08:30 and still in at 10:00.
  await scan("a-in", 58001, "In", at("08:00"));
  await scan("a-out", 58001, "Out", at("09:00"), 3600);
  await scan("b-in", 58002, "In", at("08:00"));
  await scan("b-out", 58002, "Out", at("09:00"), 3600);
  await scan("c-in", 58003, "In", at("08:30"));
});

afterAll(() => db?.close());

describe("parallel work at a station with Max i gang 6", () => {
  it("keeps every element in progress and shares the station's time between them", async () => {
    await rebuildAll(NOW, { restart: true });
    // 08:00-08:30 a and b share (15 each), 08:30-09:00 all three (10 each), then c alone to now.
    expect(await passes()).toEqual([
      { order_no: 58001, status: "done", missing_reason: null, duration_seconds: 3600, allocated_seconds: 25 * MIN },
      { order_no: 58002, status: "done", missing_reason: null, duration_seconds: 3600, allocated_seconds: 25 * MIN },
      { order_no: 58003, status: "open", missing_reason: null, duration_seconds: null, allocated_seconds: 70 * MIN },
    ]);

    // Time per piece and the pass-time total are split time; busy time stays wall clock (once).
    const [day] = await query<{ time_per_piece_seconds: number; pass_seconds_total: number; busy_seconds: number; open_count: number }>(
      "select time_per_piece_seconds, pass_seconds_total, busy_seconds, open_count from core.station_day_facts where station_no = 3"
    );
    expect(day).toEqual({ time_per_piece_seconds: 25 * MIN, pass_seconds_total: 50 * MIN, busy_seconds: 120 * MIN, open_count: 1 });

    // Order touch time is split time too; lead and work time stay wall clock.
    const orders = await query<{ order_no: number; touch_seconds: number; work_seconds: number }>(
      "select order_no, touch_seconds, work_seconds from core.orders order by order_no"
    );
    expect(orders).toEqual([
      { order_no: 58001, touch_seconds: 25 * MIN, work_seconds: 60 * MIN },
      { order_no: 58002, touch_seconds: 25 * MIN, work_seconds: 60 * MIN },
      { order_no: 58003, touch_seconds: 70 * MIN, work_seconds: 90 * MIN },
    ]);
    const elements = await query<{ touch_seconds: number }>("select touch_seconds from core.elements order by barcode");
    expect(elements.map((e) => e.touch_seconds)).toEqual([25 * MIN, 25 * MIN, 70 * MIN]);
    const steps = await query<{ touch_seconds: number }>(
      "select touch_seconds from core.order_steps where step = 'assembly' order by order_no"
    );
    expect(steps.map((s) => s.touch_seconds)).toEqual([25 * MIN, 25 * MIN, 70 * MIN]);

    // The timeline gives both clocks per pass.
    const timeline = await query<{ duration_seconds: number | null; allocated_seconds: number }>(
      "select duration_seconds, allocated_seconds from rpt.station_timeline(3, $1::timestamptz, $2::timestamptz)",
      [new Date(at("00:00")).toISOString(), new Date(at("00:00") + 86_400_000).toISOString()]
    );
    expect(timeline.map((t) => [t.duration_seconds, t.allocated_seconds])).toEqual([
      [3600, 25 * MIN],
      [3600, 25 * MIN],
      [null, 70 * MIN],
    ]);
  });

  it("gives the same rows on an incremental run, and moves the open share with the clock", async () => {
    await rebuildAll(NOW, { restart: true });
    const rebuilt = await passes();
    await applyScanChanges([], NOW);
    expect(await passes()).toEqual(rebuilt);

    await applyScanChanges([], NOW + 30 * MIN * 1000);
    const later = await passes();
    expect(later.map((p) => p.allocated_seconds)).toEqual([25 * MIN, 25 * MIN, 100 * MIN]);
    const [order] = await query<{ touch_seconds: number }>("select touch_seconds from core.orders where order_no = 58003");
    expect(order.touch_seconds).toBe(100 * MIN);
  });

  it("a late pass changes the share of a pass over midnight, and that past day's figures follow", async () => {
    // Yesterday's midnight: Q runs 21:00 the day before to 01:00 yesterday, so it counts yesterday.
    const midnight = at("00:00") - 86_400_000;
    const yesterday = new Date(midnight + 12 * 3600_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
    await scan("q-in", 58005, "In", midnight - 3 * 3600_000);
    await scan("q-out", 58005, "Out", midnight + 3600_000, 4 * 3600);
    await rebuildAll(NOW, { restart: true });
    const total = async () =>
      (
        await query<{ pass_seconds_total: number }>(
          "select pass_seconds_total from core.station_day_facts where station_no = 3 and local_day = $1::date",
          [yesterday]
        )
      )[0].pass_seconds_total;
    expect(await total()).toBe(240 * MIN);

    // P arrives late: 22:00 to 23:00 the day before yesterday, beside Q. Rebuild only P's order and
    // the one day P touches, as a sync run may do; Q's day must follow.
    await scan("p-in", 58006, "In", midnight - 2 * 3600_000);
    await scan("p-out", 58006, "Out", midnight - 3600_000, 3600);
    await db.withService(async (q) => {
      const config = await loadConfig(q, NOW);
      await replaceOrders(q, [58006], config, NOW);
      await replaceStationDays(q, [{ stationNo: 3, localDay: dayKey(midnight - 2 * 3600_000) }], config, NOW);
    });
    // Q now shares an hour with P: 210 min.
    expect(await total()).toBe(210 * MIN);
  });

  it("at Max i gang 1, an older open element of another order is a missing scan-out with no share", async () => {
    await scan("d-in", 58004, "In", at("08:45"));
    await rebuildAll(NOW, { restart: true });
    expect((await passes()).map((p) => p.status)).toEqual(["done", "done", "open", "open"]);

    await query("update config.stations set max_open = 1 where station_no = 3");
    await onMaxOpenChanged(NOW);
    const after = await passes();
    expect(after.map((p) => [p.order_no, p.status, p.missing_reason, p.allocated_seconds])).toEqual([
      // 08:00-08:45 a and b share (22.5 each), 08:45-09:00 a, b and d (5 each).
      [58001, "done", null, 27.5 * MIN],
      [58002, "done", null, 27.5 * MIN],
      [58003, "missing_out", "superseded", null],
      [58004, "open", null, 5 * MIN + 60 * MIN],
    ]);
  });
});
