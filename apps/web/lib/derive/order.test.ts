import { describe, expect, it } from "vitest";
import type { Scan } from "@/lib/scans";
import { at, pass, PACKING, scan } from "@/lib/test-helpers";
import { ALWAYS_OPEN, DEFAULT_CALENDAR } from "./calendar";
import { currentLabel } from "./forecast";
import { deriveOrder, deriveOrders, dueAtFor, roundParts } from "./order";
import {
  DEFAULT_PARAMS,
  STEP_KEYS,
  type DeriveContext,
  type DerivedOrder,
  type OrderInfo,
  type StepKey,
  type TypicalTimes,
} from "./types";

const MIN = 60;
const H = 3600;

/** Element `piece` of position 5 on order 58556. */
const el = (piece: number, position = 5): Partial<Scan> => ({
  barcode: `058556${String(position).padStart(2, "0")}01${String(piece).padStart(2, "0")}`,
  position,
  piece,
});
const S2: Partial<Scan> = { station: "Station 20", stationNo: 2 };

const info = (quantity: number, over: Partial<OrderInfo> = {}): OrderInfo => ({
  orderNo: 58556,
  customer: "Hansen Byg",
  deliveryWeek: 43,
  deliveryYear: 2026,
  expectedElements: [{ position: 5, quantity, elementTypeId: "vindue_1_fag" }],
  ...over,
});

const ctx = (now: number, over: Partial<DeriveContext> = {}): DeriveContext => ({
  now,
  calendar: DEFAULT_CALENDAR,
  ...over,
});

const derive = (scans: Scan[], i: OrderInfo | null, c: DeriveContext) => deriveOrder(scans, i, c) as DerivedOrder;
const step = (d: DerivedOrder, key: StepKey) => d.steps.find((s) => s.step === key)!;
const iso = (ms: number) => new Date(ms).toISOString();

/** The invariant every order must hold: the counted steps add up to the elapsed time, both ways of counting. */
function expectStepsAddUp(d: DerivedOrder) {
  const counted = d.steps.filter((s) => s.countsInLead && s.durationSeconds != null);
  const total = (f: (s: (typeof counted)[number]) => number | null) => counted.reduce((t, s) => t + (f(s) ?? 0), 0);
  expect(total((s) => s.durationSeconds)).toBe(d.order.elapsedSeconds);
  expect(total((s) => s.durationWorkingSeconds)).toBe(d.order.elapsedWorkingSeconds);
  expect(total((s) => s.workSeconds)).toBe(d.order.workSeconds);
  expect(total((s) => s.waitSeconds)).toBe(d.order.waitSeconds);
  expect(total((s) => s.workWorkingSeconds)).toBe(d.order.workWorkingSeconds);
  expect(total((s) => s.waitWorkingSeconds)).toBe(d.order.waitWorkingSeconds);
  expect(d.order.workSeconds + d.order.waitSeconds).toBe(d.order.elapsedSeconds);
  for (const s of counted) {
    expect((s.workSeconds ?? 0) + (s.waitSeconds ?? 0)).toBe(s.durationSeconds);
    expect((s.workWorkingSeconds ?? 0) + (s.waitWorkingSeconds ?? 0)).toBe(s.durationWorkingSeconds);
  }
  if (d.order.status === "packed") {
    expect(d.order.leadSeconds).toBe(d.order.elapsedSeconds);
    expect(d.order.leadWorkingSeconds).toBe(d.order.elapsedWorkingSeconds);
  } else {
    expect(d.order.leadSeconds).toBeNull();
  }
}

// Two elements, assembled side by side, packed one after the other.
const twoElements = () => [
  ...pass(at("07:00"), at("07:30"), el(1)),
  ...pass(at("07:10"), at("08:00"), { ...el(2), ...S2 }),
  ...pass(at("08:30"), at("08:40"), { ...el(1), ...PACKING }),
  ...pass(at("08:40"), at("08:50"), { ...el(2), ...PACKING }),
];

describe("order route: the steps add up to the lead time", () => {
  it("splits start to packed into Montage, Venter før pakning and Pakning", () => {
    const d = derive(twoElements(), info(2), ctx(at("12:00")));
    expect(d.order).toMatchObject({
      status: "packed",
      packedSource: "document",
      startAt: iso(at("07:00")),
      packedAt: iso(at("08:50")),
      startLocalDay: "2026-10-21",
      packedLocalDay: "2026-10-21",
      leadSeconds: 110 * MIN,
      leadWorkingSeconds: 110 * MIN,
      workSeconds: 80 * MIN,
      waitSeconds: 30 * MIN,
      touchSeconds: 100 * MIN, // 30 + 50 + 10 + 10: side-by-side work counts twice here
      currentStep: null,
    });
    expect(step(d, "assembly")).toMatchObject({
      seq: 5, kind: "work", source: "scans", countsInLead: true, isOpen: false,
      startAt: iso(at("07:00")), endAt: iso(at("08:00")),
      durationSeconds: 60 * MIN, workSeconds: 60 * MIN, waitSeconds: 0, touchSeconds: 80 * MIN,
    });
    expect(step(d, "wait_packing")).toMatchObject({
      kind: "wait", startAt: iso(at("08:00")), endAt: iso(at("08:30")),
      durationSeconds: 30 * MIN, workSeconds: 0, waitSeconds: 30 * MIN,
    });
    expect(step(d, "packing")).toMatchObject({
      startAt: iso(at("08:30")), endAt: iso(at("08:50")), durationSeconds: 20 * MIN, workSeconds: 20 * MIN, waitSeconds: 0,
    });
    expectStepsAddUp(d);
  });

  it("always gives the seven steps, in route order", () => {
    const d = derive(twoElements(), info(2), ctx(at("12:00")));
    expect(d.steps.map((s) => s.step)).toEqual([...STEP_KEYS]);
    expect(d.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("the steps before assembly have no data, never a number", () => {
    const d = derive(twoElements(), info(2), ctx(at("12:00")));
    for (const key of ["schirmer", "wait_kmw", "kmw", "buffer"] as const) {
      expect(step(d, key)).toMatchObject({
        source: "none", durationSeconds: null, workSeconds: null, waitSeconds: null,
        startAt: null, endAt: null, countsInLead: false,
      });
    }
  });

  it("an assumed Schirmer time is marked assumed and stays out of the lead time", () => {
    const d = derive(twoElements(), info(2), ctx(at("12:00"), { params: { schirmerAssumedSeconds: 3600 } }));
    expect(step(d, "schirmer")).toMatchObject({ source: "assumed", durationSeconds: 3600, countsInLead: false, startAt: null });
    expect(d.order.leadSeconds).toBe(110 * MIN);
    expectStepsAddUp(d);
  });

  it("idle time between elements in assembly is waiting inside Montage", () => {
    const d = derive(
      [
        ...pass(at("07:00"), at("07:10"), el(1)),
        ...pass(at("07:30"), at("07:40"), el(2)),
        ...pass(at("08:00"), at("08:05"), { ...el(1), ...PACKING }),
        ...pass(at("08:05"), at("08:10"), { ...el(2), ...PACKING }),
      ],
      info(2),
      ctx(at("12:00"))
    );
    expect(step(d, "assembly")).toMatchObject({ durationSeconds: 40 * MIN, workSeconds: 20 * MIN, waitSeconds: 20 * MIN });
    expect(step(d, "wait_packing").durationSeconds).toBe(20 * MIN);
    expect(d.order).toMatchObject({ leadSeconds: 70 * MIN, workSeconds: 30 * MIN, waitSeconds: 40 * MIN });
    expectStepsAddUp(d);
  });

  it("overlap: while one element is assembled and another packed, the time is Montage", () => {
    const d = derive(
      [
        ...pass(at("07:00"), at("07:30"), el(1)),
        ...pass(at("07:10"), at("07:50"), { ...el(2), ...S2 }),
        ...pass(at("07:40"), at("08:00"), { ...el(1), ...PACKING }), // starts before element 2 leaves assembly
        ...pass(at("08:10"), at("08:20"), { ...el(2), ...PACKING }),
      ],
      info(2),
      ctx(at("12:00"))
    );
    expect(step(d, "assembly")).toMatchObject({ durationSeconds: 50 * MIN, workSeconds: 50 * MIN, endAt: iso(at("07:50")) });
    // Packing only gets what assembly did not take: 07:50 to 08:00 and 08:10 to 08:20.
    expect(step(d, "packing")).toMatchObject({
      durationSeconds: 20 * MIN, startAt: iso(at("07:50")), endAt: iso(at("08:20")), touchSeconds: 30 * MIN,
    });
    // The idle ten minutes come after the last assembly Out: waiting for packing.
    expect(step(d, "wait_packing")).toMatchObject({ durationSeconds: 10 * MIN, startAt: iso(at("08:00")), endAt: iso(at("08:10")) });
    expect(d.order.leadSeconds).toBe(80 * MIN);
    expectStepsAddUp(d);
  });

  it("adds up to the second with millisecond scan times", () => {
    const t = (hhmm: string, extraMs: number) => at(hhmm) + extraMs;
    const d = derive(
      [
        ...pass(t("07:00", 499), t("07:10", 501), el(1)),
        ...pass(t("07:10", 999), t("07:20", 1), { ...el(2), ...S2 }),
        ...pass(t("07:30", 333), t("07:31", 667), { ...el(1), ...PACKING }),
        ...pass(t("07:33", 250), t("07:34", 750), { ...el(2), ...PACKING }),
      ],
      info(2),
      ctx(at("12:00"))
    );
    expect(d.order.leadSeconds).toBe(Math.round((t("07:34", 750) - t("07:00", 499)) / 1000));
    expectStepsAddUp(d);
  });

  it("roundParts keeps the sum", () => {
    expect(roundParts([500, 500, 500, 500], 2).reduce((a, b) => a + b)).toBe(2);
    expect(roundParts([1400, 1400, 1400], 4)).toEqual([2, 1, 1]);
    expect(roundParts([0, 0, 0], 0)).toEqual([0, 0, 0]);
  });
});

describe("working time: nights and weekends", () => {
  // Assembled Friday 13:00 to 13:30, packed Monday 06:30 to 07:00.
  const overWeekend = () => [
    ...pass(at("13:00", "2026-10-16"), at("13:30", "2026-10-16"), el(1)),
    ...pass(at("06:30", "2026-10-19"), at("07:00", "2026-10-19"), { ...el(1), ...PACKING }),
  ];

  it("stores wall clock and shift time side by side", () => {
    const d = derive(overWeekend(), info(1), ctx(at("12:00")));
    expect(d.order).toMatchObject({
      leadSeconds: 66 * H,
      leadWorkingSeconds: 2 * H, // one hour Friday, one hour Monday
      workSeconds: 1 * H,
      workWorkingSeconds: 1 * H,
      waitSeconds: 65 * H,
      waitWorkingSeconds: 1 * H,
    });
    expect(step(d, "wait_packing")).toMatchObject({ durationSeconds: 65 * H, durationWorkingSeconds: 1 * H });
    expectStepsAddUp(d);
  });

  it("with an always-open calendar the two are the same", () => {
    const d = derive(overWeekend(), info(1), ctx(at("12:00"), { calendar: ALWAYS_OPEN }));
    expect(d.order.leadWorkingSeconds).toBe(d.order.leadSeconds);
    expect(d.order.waitWorkingSeconds).toBe(d.order.waitSeconds);
    expectStepsAddUp(d);
  });

  it("an element left on the station overnight: the night is work on the wall clock, not in shift time", () => {
    const d = derive(
      [
        ...pass(at("13:00", "2026-10-20"), at("07:00"), el(1)),
        ...pass(at("07:30"), at("07:40"), { ...el(1), ...PACKING }),
      ],
      info(1),
      ctx(at("12:00"))
    );
    expect(step(d, "assembly")).toMatchObject({ workSeconds: 18 * H, workWorkingSeconds: 2 * H });
    expect(d.intervals[0]).toMatchObject({ durationSeconds: 18 * H, durationWorkingSeconds: 2 * H, localDay: "2026-10-21" });
    expectStepsAddUp(d);
  });

  it("over the autumn clock change the lead time is real elapsed time", () => {
    // Friday 2026-10-23 13:00 CEST to Monday 2026-10-26 07:00 CET.
    const from = Date.parse("2026-10-23T13:00:00+02:00");
    const to = Date.parse("2026-10-26T07:00:00+01:00");
    const d = derive(
      [...pass(from, from + 30 * 60_000, el(1)), ...pass(to - 30 * 60_000, to, { ...el(1), ...PACKING })],
      info(1, { deliveryWeek: 44 }),
      ctx(to + 1000)
    );
    expect(d.order.leadSeconds).toBe(67 * H); // 66 hours on the clock face, 67 real ones
    expect(d.order.leadWorkingSeconds).toBe(2 * H);
    expect(d.order.packedLocalDay).toBe("2026-10-26");
    expectStepsAddUp(d);
  });
});

describe("packed", () => {
  it("with a document: only when every expected element has a packing Out", () => {
    const d = derive(twoElements(), info(3), ctx(at("12:00")));
    expect(d.order).toMatchObject({
      status: "in_progress",
      packedSource: null,
      packedAt: null,
      expectedSource: "document",
      elementsExpected: 3,
      elementsSeen: 2,
      elementsAssembled: 2,
      elementsPacked: 2,
      missingElements: [{ position: 5, subPosition: 1, expected: 3, seen: 2, packed: 2 }],
      currentStep: "assembly", // the third element still has assembly ahead
      onTime: null,
    });
    expectStepsAddUp(d);
  });

  it("with a document: packed at the last packing Out, at once", () => {
    const d = derive(twoElements(), info(2), ctx(at("08:50")));
    expect(d.order).toMatchObject({ status: "packed", packedSource: "document", missingElements: [], elementsPacked: 2 });
  });

  it("with a document: counts per position", () => {
    const scans = [
      ...pass(at("07:00"), at("07:10"), el(1, 1)),
      ...pass(at("07:20"), at("07:25"), { ...el(1, 1), ...PACKING }),
      ...pass(at("07:30"), at("07:35"), { ...el(2, 1), ...PACKING }), // a second piece of position 1, not position 2
    ];
    const twoPositions = info(0, {
      expectedElements: [
        { position: 1, quantity: 1, elementTypeId: "dør" },
        { position: 2, quantity: 1, elementTypeId: "vindue_1_fag" },
      ],
    });
    const d = derive(scans, twoPositions, ctx(at("12:00")));
    expect(d.order.status).toBe("in_progress");
    expect(d.order.missingElements).toEqual([{ position: 2, subPosition: 1, expected: 1, seen: 0, packed: 0 }]);
  });

  it("an element the document does not list never blocks packed", () => {
    const d = derive(
      [...twoElements(), ...pass(at("09:00"), at("09:10"), el(1, 9))],
      info(2),
      ctx(at("12:00"))
    );
    expect(d.order).toMatchObject({ status: "packed", elementsSeen: 3, elementsPacked: 2 });
    expect(d.elements.find((e) => e.position === 9)).toMatchObject({ inDocument: false, elementTypeId: null });
    // Work after the packing does not stretch the lead time.
    expect(d.order.leadSeconds).toBe(110 * MIN);
    expectStepsAddUp(d);
  });

  it("an element still on a station keeps the order open", () => {
    const d = derive([...twoElements(), scan("In", at("09:00"), { ...el(1), ...PACKING })], info(2), ctx(at("09:05")));
    expect(d.order).toMatchObject({ status: "in_progress", currentStep: "packing", currentStationNos: [7], elementsPacked: 1 });
    expectStepsAddUp(d);
  });

  it("without a document: packed when all seen elements are packed and the order has been quiet", () => {
    const soon = derive(twoElements(), null, ctx(at("08:50") + 12 * H * 1000 - 1));
    expect(soon.order).toMatchObject({
      status: "in_progress",
      expectedSource: "scans",
      elementsExpected: null,
      missingElements: null,
      currentStep: "wait_packing",
    });
    const later = derive(twoElements(), null, ctx(at("08:50") + 12 * H * 1000));
    expect(later.order).toMatchObject({
      status: "packed",
      packedSource: "scans",
      expectedSource: "scans",
      packedAt: iso(at("08:50")),
      leadSeconds: 110 * MIN,
      onTime: null,
    });
    expectStepsAddUp(later);
  });

  it("without a document: the quiet time is a parameter, and one unpacked element keeps it open", () => {
    expect(derive(twoElements(), null, ctx(at("09:00"), { params: { packedQuietSeconds: 0 } })).order.status).toBe("packed");
    const d = derive(twoElements().slice(0, 6), null, ctx(at("12:00", "2026-10-30")));
    expect(d.order).toMatchObject({ status: "in_progress", elementsPacked: 1, currentStep: "wait_packing" });
  });

  it("the document arriving later turns a scans-packed order into a document one", () => {
    const now = at("12:00", "2026-10-23");
    expect(derive(twoElements(), null, ctx(now)).order.packedSource).toBe("scans");
    expect(derive(twoElements(), info(2), ctx(now)).order.packedSource).toBe("document");
    expect(derive(twoElements(), info(4), ctx(now)).order.status).toBe("in_progress");
  });
});

describe("on time", () => {
  it("the deadline is the end of the delivery week, Copenhagen time", () => {
    // Week 43 of 2026 ends Sunday 25 October, the day of the clock change: Monday 00:00 CET.
    expect(dueAtFor({ deliveryWeek: 43, deliveryYear: 2026 }, 0, DEFAULT_PARAMS)).toEqual({
      dueAt: Date.parse("2026-10-26T00:00:00+01:00"),
      year: 2026,
    });
  });

  it("packed inside the week is on time, after it is late", () => {
    expect(derive(twoElements(), info(2), ctx(at("12:00"))).order).toMatchObject({ onTime: true, dueAt: "2026-10-25T23:00:00.000Z" });
    expect(derive(twoElements(), info(2, { deliveryWeek: 42 }), ctx(at("12:00"))).order.onTime).toBe(false);
  });

  it("the target week and the grace are parameters", () => {
    // Target the week before Lev. uge: due Monday 19 October 00:00, packed Wednesday 21: late.
    const early = derive(twoElements(), info(2), ctx(at("12:00"), { params: { onTimeWeekOffset: -1 } }));
    expect(early.order).toMatchObject({ onTime: false, dueAt: "2026-10-18T22:00:00.000Z" });
    // Three days of grace on top of that: due Thursday 22 October 00:00: on time.
    const grace = derive(twoElements(), info(2), ctx(at("12:00"), { params: { onTimeWeekOffset: -1, onTimeGraceDays: 3 } }));
    expect(grace.order.onTime).toBe(true);
  });

  it("without a year the nearest such week is used, also across New Year", () => {
    expect(dueAtFor({ deliveryWeek: 2 }, at("09:00", "2026-12-15"), DEFAULT_PARAMS)?.year).toBe(2027);
    expect(dueAtFor({ deliveryWeek: 51 }, Date.parse("2027-01-05T09:00:00+01:00"), DEFAULT_PARAMS)?.year).toBe(2026);
    expect(dueAtFor({ deliveryWeek: 44 }, at("09:00"), DEFAULT_PARAMS)?.year).toBe(2026);
  });

  it("no delivery week: no deadline and no verdict", () => {
    const d = derive(twoElements(), info(2, { deliveryWeek: null }), ctx(at("12:00")));
    expect(d.order).toMatchObject({ dueAt: null, onTime: null, atRisk: null, status: "packed" });
    expect(dueAtFor(null, 0, DEFAULT_PARAMS)).toBeNull();
  });
});

describe("in progress", () => {
  it("an element on a station: time so far, the open step, no lead time yet", () => {
    const d = derive([scan("In", at("07:00"), el(1))], info(2), ctx(at("07:20")));
    expect(d.order).toMatchObject({
      status: "in_progress",
      leadSeconds: null,
      elapsedSeconds: 20 * MIN,
      workSeconds: 20 * MIN,
      waitSeconds: 0,
      currentStep: "assembly",
      currentStationNos: [1],
      openCount: 1,
      touchSeconds: 20 * MIN,
    });
    expect(step(d, "assembly")).toMatchObject({ isOpen: true, durationSeconds: 20 * MIN, startAt: iso(at("07:00")) });
    // Not reached yet: no data, not zero.
    expect(step(d, "wait_packing")).toMatchObject({ durationSeconds: null, isOpen: false, source: "scans" });
    expect(step(d, "packing").durationSeconds).toBeNull();
    expect(d.elements[0]).toMatchObject({ inProgress: true, currentStationNo: 1, stationPath: [1], packedAt: null });
    expect(d.intervals[0]).toMatchObject({ status: "open", endAt: null, durationSeconds: null, localDay: "2026-10-21" });
    expectStepsAddUp(d);
  });

  it("says where it is now", () => {
    const names = { 1: "Station 10", 7: "Pakning" };
    const onStation = derive([scan("In", at("07:00"), el(1))], info(1), ctx(at("07:20")));
    expect(currentLabel(onStation.order, names)).toBe("Station 10");
    expect(currentLabel(onStation.order)).toBe("Station nr. 1");

    const waiting = derive(pass(at("07:00"), at("07:10"), el(1)), info(1), ctx(at("07:20")));
    expect(waiting.order.currentStep).toBe("wait_packing");
    expect(currentLabel(waiting.order, names)).toBe("Venter før pakning");
    expect(step(waiting, "wait_packing")).toMatchObject({ isOpen: true, durationSeconds: 10 * MIN });

    const between = derive(pass(at("07:00"), at("07:10"), el(1)), info(2), ctx(at("07:20")));
    expect(between.order.currentStep).toBe("assembly");
    expect(currentLabel(between.order, names)).toBe("Montage, venter");
    expect(step(between, "assembly")).toMatchObject({ workSeconds: 10 * MIN, waitSeconds: 10 * MIN, isOpen: true });

    expect(currentLabel(derive(twoElements(), info(2), ctx(at("12:00"))).order, names)).toBe("Pakket");
  });

  it("an In never scanned out stops counting after 36 hours and is listed", () => {
    const scans = [scan("In", at("07:00", "2026-10-19"), el(1)), ...pass(at("07:00"), at("07:10"), el(2))];
    const d = derive(scans, info(2), ctx(at("12:00")));
    expect(d.order).toMatchObject({ missingScanOutCount: 1, openCount: 0, touchSeconds: 10 * MIN, currentStationNos: [] });
    expect(d.intervals.map((iv) => [iv.status, iv.missingReason, iv.durationSeconds, iv.localDay])).toEqual([
      ["missing_out", "stale", null, "2026-10-19"],
      ["done", null, 10 * MIN, "2026-10-21"],
    ]);
    expect(d.elements.find((e) => e.piece === 1)).toMatchObject({
      missingScanOutCount: 1, inProgress: false, touchSeconds: 0, totalSeconds: null, stationPath: [],
    });
    // The order still starts at its first scan.
    expect(d.order.startAt).toBe(iso(at("07:00", "2026-10-19")));
    expectStepsAddUp(d);
  });
});

describe("elements and intervals", () => {
  it("rework is counted and shows in the path", () => {
    const d = derive(
      [
        ...pass(at("07:00"), at("07:10"), el(1)),
        ...pass(at("07:20"), at("07:25"), { ...el(1), ...PACKING }),
        ...pass(at("08:00"), at("08:05"), el(1)), // back to the station
        ...pass(at("08:10"), at("08:12"), { ...el(1), ...PACKING }),
      ],
      info(1),
      ctx(at("12:00"))
    );
    expect(d.order).toMatchObject({ reworkCount: 2, status: "packed", packedAt: iso(at("08:12")) });
    expect(d.elements[0]).toMatchObject({
      stationPath: [1, 7, 1, 7],
      reworkCount: 2,
      touchSeconds: 22 * MIN,
      totalSeconds: 72 * MIN,
      assembledAt: iso(at("08:05")),
      packedAt: iso(at("08:12")),
      elementTypeId: "vindue_1_fag",
      inDocument: true,
    });
    expect(d.intervals.map((iv) => [iv.stationNo, iv.visit, iv.isRework])).toEqual([
      [1, 1, false], [7, 1, false], [1, 2, true], [7, 2, true],
    ]);
    expectStepsAddUp(d);
  });

  it("each pass knows how long the element waited since its previous Out", () => {
    const d = derive(
      [
        ...pass(at("13:00", "2026-10-20"), at("13:30", "2026-10-20"), el(1)),
        ...pass(at("07:00"), at("07:10"), { ...el(1), ...S2 }),
      ],
      info(1),
      ctx(at("12:00"))
    );
    expect(d.intervals[0]).toMatchObject({ waitBeforeSeconds: null, waitBeforeWorkingSeconds: null });
    expect(d.intervals[1]).toMatchObject({ waitBeforeSeconds: 17.5 * H, waitBeforeWorkingSeconds: 1.5 * H, elementTypeId: "vindue_1_fag" });
  });

  it("element details come from the document line of its position", () => {
    const d = derive(
      twoElements(),
      info(0, { expectedElements: [{ position: 5, quantity: 2, elementTypeId: "dør", system: "Rationel", widthMm: 948, heightMm: 2100 }] }),
      ctx(at("12:00"))
    );
    expect(d.elements[0]).toMatchObject({ elementTypeId: "dør", system: "Rationel", widthMm: 948, heightMm: 2100 });
  });

  it("derives several orders from one scan set, each from its own scans", () => {
    const other: Partial<Scan> = { barcode: "058557010101", orderNo: 58557, position: 1, piece: 1 };
    const all = deriveOrders([...twoElements(), ...pass(at("09:00"), at("09:10"), other)], [info(2)], ctx(at("12:00")));
    expect(all.map((d) => [d.order.orderNo, d.order.status, d.intervals.length])).toEqual([
      [58556, "packed", 4],
      [58557, "in_progress", 1],
    ]);
    expect(deriveOrder([], null, ctx(at("12:00")))).toBeNull();
  });

  it("is deterministic and JSON friendly", () => {
    const a = derive(twoElements(), info(2), ctx(at("12:00")));
    const b = derive([...twoElements()].reverse(), info(2), ctx(at("12:00")));
    const strip = (d: DerivedOrder) => JSON.parse(JSON.stringify({ ...d, intervals: d.intervals.map((iv) => ({ ...iv, intervalId: "", inScanId: "", outScanId: "" })) }));
    expect(strip(a)).toEqual(strip(b));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe("forecast v1", () => {
  const typical: TypicalTimes = {
    stations: [
      { stationNo: 1, kind: "assembly", seconds: 600 },
      { stationNo: 7, kind: "packing", seconds: 120 },
    ],
    waitBeforePackingSeconds: 300,
  };

  it("remaining elements times typical station times, in shift time from now", () => {
    // Element 1 packed, element 2 assembled, element 3 not seen yet.
    const scans = [
      ...pass(at("07:00"), at("07:10"), el(1)),
      ...pass(at("07:10"), at("07:20"), el(2)),
      ...pass(at("07:30"), at("07:32"), { ...el(1), ...PACKING }),
    ];
    const d = derive(scans, info(3), ctx(at("09:00"), { typical }));
    // Station 1 still owes element 3: 600. Packing owes elements 2 and 3: 240.
    // Bottleneck 600, plus one piece through packing 120. Packing has begun: no extra wait.
    expect(d.order).toMatchObject({
      forecastRemainingSeconds: 720,
      forecastReadyAt: iso(at("09:12")),
      forecastBasis: "document",
      atRisk: false,
    });
  });

  it("rolls into the next shift, and flags an order that will miss its week", () => {
    const d = derive([scan("In", at("13:55"), el(1))], info(1, { deliveryWeek: 43 }), ctx(at("13:58"), { typical }));
    // 600 - 180 left at station 1, then 300 wait and 120 packing: 840 s, 120 of them today.
    expect(d.order.forecastRemainingSeconds).toBe(840);
    expect(d.order.forecastReadyAt).toBe(iso(at("06:12", "2026-10-22")));
    expect(d.order.atRisk).toBe(false);

    const late = derive([scan("In", at("13:55"), el(1))], info(1, { deliveryWeek: 42 }), ctx(at("13:58"), { typical }));
    expect(late.order.atRisk).toBe(true);
  });

  it("without a document it can only speak for the elements seen", () => {
    const d = derive(pass(at("07:00"), at("07:10"), el(1)), null, ctx(at("09:00"), { typical }));
    expect(d.order).toMatchObject({ forecastBasis: "seen_elements", forecastRemainingSeconds: 420, atRisk: null });
  });

  it("no typical times: no forecast, never a guess", () => {
    const d = derive(pass(at("07:00"), at("07:10"), el(1)), info(2), ctx(at("09:00")));
    expect(d.order).toMatchObject({ forecastReadyAt: null, forecastRemainingSeconds: null, forecastBasis: null, atRisk: null });
    const unknown: TypicalTimes = { stations: [{ stationNo: 1, kind: "assembly", seconds: null }], waitBeforePackingSeconds: null };
    expect(derive(pass(at("07:00"), at("07:10"), el(1)), info(2), ctx(at("09:00"), { typical: unknown })).order.forecastReadyAt).toBeNull();
  });

  it("uses the time of the element's type when there is one, and the share of elements that pass a station", () => {
    const byType: TypicalTimes = {
      stations: [
        { stationNo: 1, kind: "assembly", seconds: 600, secondsByType: { vindue_1_fag: 900 } },
        { stationNo: 5, kind: "assembly", seconds: 400, share: 0.5 },
        { stationNo: 7, kind: "packing", seconds: 120 },
      ],
      waitBeforePackingSeconds: null,
    };
    // Two unseen elements: station 1 load 1800, station 5 load 400 over one piece's worth, packing 240.
    const d = derive([scan("In", at("07:00"), el(1, 9))], info(2), ctx(at("07:00"), { typical: byType }));
    // The seen element (not on the list, no type): 600 at station 1, 200 at station 5, 120 at packing.
    // Loads: station 1 = 600 + 1800 = 2400 (bottleneck); station 5 = 600 over 1.5 pieces = 400; packing = 360 over 3 = 120.
    expect(d.order.forecastRemainingSeconds).toBe(2400 + 400 + 120);
  });

  it("a packed order has no forecast", () => {
    expect(derive(twoElements(), info(2), ctx(at("12:00"), { typical })).order).toMatchObject({ forecastReadyAt: null, atRisk: null });
  });
});
