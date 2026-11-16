// The list and period queries on a few thousand orders: plans and timings.
//
// 2400 packed orders over 60 working days from Monday 3 August 2026 (40 a
// day), each one element through Station 10 and Pakning. PGlite runs in
// process and single threaded, so the timings are an upper bound for hosted
// Postgres. They are printed, and docs/reports.md quotes them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { addDays } from "@/lib/time";
import {
  findOrders,
  getBottleneck,
  getLeadTimeSeries,
  getPeriodKpis,
  getStationPerformance,
  listFinishedOrders,
  listInProgressOrders,
} from "./index";
import { local, seedConfig, seedScans, simpleOrder } from "./test-support";

const viewer = testClaims("viewer");
const DAYS = 60;
const PER_DAY = 40;
const FIRST_DAY = "2026-08-03";
const FIRST_ORDER = 60000;
const PERIOD = { from: "2026-08-01", to: "2026-10-31" };
const NOW = local("2026-11-16", "12:00", "+01:00");
/** Generous: the slowest call measured here was far below it. */
const LIMIT_MS = 3000;

function generate() {
  const orders = [];
  let day = FIRST_DAY;
  let orderNo = FIRST_ORDER;
  for (let d = 0; d < DAYS; d++) {
    // Skip the weekend. All days are before the clocks go back on 25 October.
    while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = addDays(day, 1);
    for (let i = 0; i < PER_DAY; i++) {
      const minute = String(i % 60).padStart(2, "0");
      const assemblyIn = local(day, `07:${minute}`);
      orders.push(
        simpleOrder({
          orderNo: orderNo++,
          assemblyIn,
          assemblyOut: assemblyIn + (20 + (i % 15)) * 60_000,
          packIn: assemblyIn + 120 * 60_000,
          packOut: assemblyIn + 130 * 60_000,
          customer: `Kunde ${i % 25}`,
          deliveryWeek: 40,
          deliveryYear: 2026,
        })
      );
    }
    day = addDays(day, 1);
  }
  return orders;
}

let db: TestDb;
const timings: [string, number][] = [];

async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  await run(); // warm up: the first call also plans
  const started = performance.now();
  const result = await run();
  const ms = performance.now() - started;
  timings.push([name, Math.round(ms)]);
  expect(ms, name).toBeLessThan(LIMIT_MS);
  return result;
}

async function explain(sql: string, params: unknown[] = []): Promise<string> {
  const plan = await db.withUser(viewer, (tx) => tx.query<{ "QUERY PLAN": string }>(`explain ${sql}`, params));
  return plan.map((line) => line["QUERY PLAN"]).join("\n");
}

beforeAll(async () => {
  db = await createTestDb();
  await db.reset();
  await seedConfig(db);
  const orders = generate();
  await seedScans(
    db,
    orders.flatMap((o) => o.scans),
    orders.map((o) => o.info),
    { now: NOW }
  );
  await db.withService((tx) => tx.query("analyze"));
}, 600_000);

afterAll(async () => {
  console.log(
    ["Report timings on 2400 orders (PGlite, second call):", ...timings.map(([name, ms]) => `  ${name.padEnd(46)} ${ms} ms`)].join(
      "\n"
    )
  );
  await db.close();
});

describe("list queries on 2400 orders", () => {
  it("finished orders: first page, deep page, search and sort", async () => {
    const first = await timed("listFinishedOrders first page", () => listFinishedOrders(viewer, {}));
    expect(first.total).toBe(DAYS * PER_DAY);
    expect(first.rows).toHaveLength(50);

    const deep = await timed("listFinishedOrders page 40", () => listFinishedOrders(viewer, { page: 40 }));
    expect(deep.rows).toHaveLength(50);
    expect(deep.total).toBe(DAYS * PER_DAY);

    const period = await timed("listFinishedOrders one month", () =>
      listFinishedOrders(viewer, { from: "2026-09-01", to: "2026-09-30" })
    );
    // September 2026 has 22 working days.
    expect(period.total).toBe(22 * PER_DAY);

    const search = await timed("listFinishedOrders search customer", () => listFinishedOrders(viewer, { search: "kunde 7" }));
    // Customers repeat every 25 orders: "Kunde 7" is two of the 40 a day.
    expect(search.total).toBe(2 * DAYS);

    const byNumber = await timed("listFinishedOrders search number", () => listFinishedOrders(viewer, { search: "6012" }));
    expect(byNumber.total).toBe(10);

    const sorted = await timed("listFinishedOrders sort lead asc", () =>
      listFinishedOrders(viewer, { sort: "lead", dir: "asc", pageSize: 200 })
    );
    expect(sorted.rows).toHaveLength(200);
  });

  it("in progress and find", async () => {
    const open = await timed("listInProgressOrders", () => listInProgressOrders(viewer, { now: NOW }));
    expect(open.total).toBe(0);
    const exact = await timed("findOrders exact number", () => findOrders(viewer, { query: "61234" }));
    expect(exact.map((f) => [f.orderNo, f.match])).toEqual([[61234, "order_no"]]);
    const prefix = await timed("findOrders number prefix", () => findOrders(viewer, { query: "612" }));
    expect(prefix).toHaveLength(10);
    const customer = await timed("findOrders customer", () => findOrders(viewer, { query: "kunde 24" }));
    expect(customer).toHaveLength(10);
  });

  it("period queries over three months", async () => {
    const kpis = await timed("getPeriodKpis three months", () => getPeriodKpis(viewer, PERIOD));
    expect(kpis.current.ordersPacked).toBe(DAYS * PER_DAY);
    // Every order: assembly In to packing Out is 130 minutes.
    expect(kpis.current.lead.wallSeconds).toBe(7800);

    const weeks = await timed("getLeadTimeSeries weeks", () => getLeadTimeSeries(viewer, { ...PERIOD, bucket: "week" }));
    expect(weeks.reduce((sum, w) => sum + w.ordersPacked, 0)).toBe(DAYS * PER_DAY);

    const bottleneck = await timed("getBottleneck three months", () => getBottleneck(viewer, PERIOD));
    expect(bottleneck.ordersPacked).toBe(DAYS * PER_DAY);

    const stations = await timed("getStationPerformance three months", () => getStationPerformance(viewer, PERIOD));
    expect(stations.rows.find((r) => r.stationNo === 1)?.countThrough).toBe(DAYS * PER_DAY);
  });
});

describe("plans", () => {
  it("the function call is one function scan (plpgsql hides the inner plan)", async () => {
    const plan = await explain("select * from rpt.orders_finished()");
    expect(plan).toContain("Function Scan on orders_finished");
  });

  it("the default finished list walks orders_packed_at_idx and stops at the limit", async () => {
    // The statement rpt.orders_finished runs for the default sort, without the total.
    const plan = await explain(
      `select o.order_no from core.orders o
       where o.status = 'packed'
       order by o.packed_at desc nulls last, o.order_no desc
       limit 50`
    );
    console.log(`Plan, finished orders newest first:\n${plan}`);
    expect(plan).toContain("orders_packed_at_idx");
  });

  it("the text search reads core.orders once: there is no index for it", async () => {
    const plan = await explain(
      `select o.order_no from core.orders o
       where o.customer ilike '%' || 'kunde 7' || '%' or (o.order_no::text) like '6123' || '%'`
    );
    console.log(`Plan, text search:\n${plan}`);
    expect(plan).toContain("Seq Scan on orders");
  });

  it("station passes of a period use station_intervals_local_day_idx", async () => {
    const plan = await explain(
      `select count(*) from core.station_intervals i
       where i.status = 'done' and i.local_day between date '2026-09-01' and date '2026-09-03'`
    );
    console.log(`Plan, passes of three days:\n${plan}`);
    expect(plan).toContain("station_intervals_local_day_idx");
  });
});
