// Seeding for the report tests. Not imported by the app.
//
// Scans go through lib/derive exactly as the read model writer runs them and
// the rows are inserted as service, so the reports are tested on real derived
// rows without depending on lib/readmodel.

import type { TestDb } from "@/lib/db/testing";
import {
  DEFAULT_CALENDAR,
  deriveOrders,
  deriveStationDay,
  insertSql,
  stationDaysTouched,
  type CoreTable,
  type DerivedOrder,
  type OrderInfo,
  type StationIntervalRow,
  type WorkCalendar,
} from "@/lib/derive";
import type { Scan } from "@/lib/scans";
import { pass, PACKING, scan } from "@/lib/test-helpers";

export const TYPE_A = "vindue_1_fag";
export const TYPE_B = "doer";

/** Stations 1 and 2 (assembly) and 7 (packing), two element types, normal and calculated times. */
export async function seedConfig(db: TestDb): Promise<void> {
  await db.withService(async (tx) => {
    await tx.query(
      `insert into config.stations (station_no, name, kind, sort_order) values
         (1, 'Station 10', 'assembly', 10), (2, 'Station 20', 'assembly', 20), (7, 'Pakning', 'packing', 70)`
    );
    await tx.query(
      `insert into config.element_types (id, name, sort_order) values ($1, 'Vindue 1 fag', 1), ($2, 'Dør', 2)`,
      [TYPE_A, TYPE_B]
    );
    await tx.query(
      `insert into config.normal_times (station_no, element_type_id, seconds) values (1, $1, 1500), (7, $1, 600)`,
      [TYPE_A]
    );
    await tx.query(
      `insert into config.calculated_times (station_no, element_type_id, seconds) values (1, $1, 1200), (7, $1, 600)`,
      [TYPE_A]
    );
  });
}

export async function setSetting(db: TestDb, key: string, value: unknown): Promise<void> {
  await db.withService((tx) =>
    tx.query(
      `insert into config.settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)]
    )
  );
}

export interface SeedOptions {
  now: number;
  calendar?: WorkCalendar;
}

/** Derives the scans and stores orders, elements, passes, steps and the station days they touch. */
export async function seedScans(
  db: TestDb,
  scans: Scan[],
  infos: OrderInfo[],
  { now, calendar = DEFAULT_CALENDAR }: SeedOptions
): Promise<DerivedOrder[]> {
  const ctx = { now, calendar };
  const derived = deriveOrders(scans, infos, ctx);
  const intervals: StationIntervalRow[] = derived.flatMap((d) => d.intervals);
  const facts = stationDaysTouched(intervals, now)
    .map((d) => deriveStationDay(d.stationNo, d.localDay, intervals, ctx))
    .filter((f) => f != null);

  await db.withService(async (tx) => {
    const insert = async (table: CoreTable, row: object) => {
      const { sql, values } = insertSql(table, row);
      await tx.query(sql, values);
    };
    for (const d of derived) {
      await insert("orders", d.order);
      for (const row of d.elements) await insert("elements", row);
      for (const row of d.intervals) await insert("stationIntervals", row);
      for (const row of d.steps) await insert("orderSteps", row);
    }
    for (const row of facts) await insert("stationDayFacts", row);
  });
  return derived;
}

/** Epoch ms of a Copenhagen wall clock time with an explicit offset ("+02:00" in summer, "+01:00" in winter). */
export function local(day: string, hhmm: string, offset = "+02:00"): number {
  return Date.parse(`${day}T${hhmm}:00${offset}`);
}

/** The barcode of one piece: order (6), position (2), sub position (2), piece (2). */
export function barcode(orderNo: number, piece = 1, position = 1): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${String(orderNo).padStart(6, "0")}${p2(position)}01${p2(piece)}`;
}

export function element(orderNo: number, piece = 1, position = 1): Partial<Scan> {
  return { barcode: barcode(orderNo, piece, position), orderNo, position, subPosition: 1, piece };
}

export interface SimpleOrder {
  orderNo: number;
  /** In at station 1. */
  assemblyIn: number;
  assemblyOut: number;
  packIn: number;
  packOut: number;
  customer?: string;
  caseName?: string;
  deliveryWeek?: number;
  deliveryYear?: number;
  elementTypeId?: string;
}

/** One element through Station 10 and Pakning, with a document that expects exactly that element. */
export function simpleOrder(o: SimpleOrder): { scans: Scan[]; info: OrderInfo } {
  const el = element(o.orderNo);
  return {
    scans: [...pass(o.assemblyIn, o.assemblyOut, el), ...pass(o.packIn, o.packOut, { ...el, ...PACKING })],
    info: {
      orderNo: o.orderNo,
      customer: o.customer ?? `Kunde ${o.orderNo}`,
      caseName: o.caseName ?? `Sag ${o.orderNo}`,
      deliveryWeek: o.deliveryWeek ?? null,
      deliveryYear: o.deliveryYear,
      expectedElements: [{ position: 1, quantity: 1, elementTypeId: o.elementTypeId ?? TYPE_A }],
    },
  };
}

// ---------------------------------------------------------------------------
// The shared scenario: five packed orders around the end of October 2026.
// The hand-computed figures are in the header of overview.test.ts.
// ---------------------------------------------------------------------------

export const CET = "+01:00";
export const NOW = local("2026-11-16", "12:00", CET);

export const OCTOBER_ORDERS = [
  simpleOrder({
    orderNo: 50001,
    assemblyIn: local("2026-10-21", "07:00"),
    assemblyOut: local("2026-10-21", "07:30"),
    packIn: local("2026-10-21", "08:30"),
    packOut: local("2026-10-21", "08:40"),
    deliveryWeek: 43,
    deliveryYear: 2026,
  }),
  simpleOrder({
    orderNo: 50002,
    assemblyIn: local("2026-10-30", "12:00", CET),
    assemblyOut: local("2026-10-30", "13:00", CET),
    packIn: local("2026-10-31", "23:20", CET),
    packOut: local("2026-10-31", "23:30", CET),
    deliveryWeek: 43,
    deliveryYear: 2026,
  }),
  simpleOrder({
    orderNo: 50003,
    assemblyIn: local("2026-10-30", "08:00", CET),
    assemblyOut: local("2026-10-30", "08:20", CET),
    packIn: local("2026-11-01", "00:05", CET),
    packOut: local("2026-11-01", "00:10", CET),
  }),
  simpleOrder({
    orderNo: 50004,
    assemblyIn: local("2026-10-23", "13:00"),
    assemblyOut: local("2026-10-23", "13:30"),
    packIn: local("2026-10-26", "06:30", CET),
    packOut: local("2026-10-26", "07:00", CET),
    deliveryWeek: 44,
    deliveryYear: 2026,
  }),
  simpleOrder({
    orderNo: 50005,
    assemblyIn: local("2026-09-15", "07:00"),
    assemblyOut: local("2026-09-15", "08:00"),
    packIn: local("2026-09-15", "09:00"),
    packOut: local("2026-09-15", "09:30"),
  }),
];

export async function seedOctober(db: TestDb, extra: { scans: Scan[]; info: OrderInfo | null }[] = [], now = NOW): Promise<void> {
  const all = [...OCTOBER_ORDERS, ...extra];
  await seedScans(
    db,
    all.flatMap((o) => o.scans),
    all.flatMap((o) => (o.info ? [o.info] : [])),
    { now }
  );
}

/**
 * Three orders in progress at NOW (Monday 16 November 2026, 12:00):
 *   50006  two elements, one assembled 07:00-07:40, one on Station 20 since 11:00. Week 45: the deadline has passed.
 *   50007  one element assembled 08:00-08:30, waiting for packing. Week 48.
 *   50008  no document. Scanned In on 10 November and never Out.
 */
export const IN_PROGRESS_ORDERS: { scans: Scan[]; info: OrderInfo | null }[] = [
  {
    scans: [
      ...pass(local("2026-11-16", "07:00", CET), local("2026-11-16", "07:40", CET), element(50006, 1)),
      scan("In", local("2026-11-16", "11:00", CET), { ...element(50006, 2), station: "Station 20", stationNo: 2 }),
    ],
    info: {
      orderNo: 50006,
      customer: "Hansen Byg",
      caseName: "Skolevej 12",
      deliveryWeek: 45,
      deliveryYear: 2026,
      expectedElements: [{ position: 1, quantity: 2, elementTypeId: TYPE_A }],
    },
  },
  {
    scans: [...pass(local("2026-11-16", "08:00", CET), local("2026-11-16", "08:30", CET), element(50007, 1))],
    info: {
      orderNo: 50007,
      customer: "Jensen Tømrer",
      caseName: "Havnegade 3",
      deliveryWeek: 48,
      deliveryYear: 2026,
      expectedElements: [{ position: 1, quantity: 1, elementTypeId: TYPE_A }],
    },
  },
  { scans: [scan("In", local("2026-11-10", "07:00", CET), element(50008, 1))], info: null },
];
