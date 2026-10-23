import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  computeKpis,
  intervalsStartingIn,
  orderStatus,
  pairScans,
  sortOrders,
  STALE_OPEN_MS,
  summarizeElements,
  summarizeOrders,
  summarizeStations,
} from "@/lib/report";
import { at, PACKING, pass, scan } from "@/lib/test-helpers";
import { dayEnd, dayStart } from "@/lib/time";

const MIN = 60_000;

describe("pairScans", () => {
  it("pairs In and Out per station and barcode", () => {
    const ivs = pairScans(
      [...pass(at("07:00"), at("07:05")), ...pass(at("07:06"), at("07:16"), { station: "Station 20", stationNo: 2 })],
      at("12:00")
    );
    expect(ivs.map((iv) => [iv.station, iv.durationMs / MIN])).toEqual([
      ["Station 10", 5],
      ["Station 20", 10],
    ]);
    expect(ivs.every((iv) => !iv.inProgress && iv.visit === 1)).toBe(true);
  });

  it("keeps two elements at the same station apart", () => {
    const a = { barcode: "058556050101" };
    const b = { barcode: "058556050102" };
    const ivs = pairScans(
      [scan("In", at("07:00"), a), scan("In", at("07:01"), b), scan("Out", at("07:04"), a), scan("Out", at("07:09"), b)],
      at("12:00")
    );
    expect(ivs.map((iv) => [iv.barcode, iv.durationMs / MIN])).toEqual([
      ["058556050101", 4],
      ["058556050102", 8],
    ]);
  });

  it("counts a rework re-scan as another pass that adds time", () => {
    const ivs = pairScans([...pass(at("07:00"), at("07:05")), ...pass(at("09:00"), at("09:03"))], at("12:00"));
    expect(ivs.map((iv) => iv.visit)).toEqual([1, 2]);
    expect(ivs.reduce((t, iv) => t + iv.durationMs, 0)).toBe(8 * MIN);
  });

  it("counts an element in progress up to now", () => {
    const [iv] = pairScans([scan("In", at("10:00"))], at("10:25"));
    expect(iv.inProgress).toBe(true);
    expect(iv.end).toBe(at("10:25"));
    expect(iv.durationMs).toBe(25 * MIN);
  });

  it("ignores an In left open longer than the stale limit", () => {
    const ivs = pairScans([scan("In", at("06:00"))], at("06:00") + STALE_OPEN_MS + 1);
    expect(ivs).toEqual([]);
  });

  it("keeps an In open overnight in progress (the limit is 36 hours, as on the station)", () => {
    expect(STALE_OPEN_MS).toBe(36 * 3_600_000);
    const [iv] = pairScans([scan("In", at("15:00", "2026-10-20"))], at("09:00"));
    expect(iv.inProgress).toBe(true);
    expect(iv.durationMs).toBe(18 * 60 * MIN);
  });

  it("has at most one element in progress per station: the latest In", () => {
    const ivs = pairScans(
      [scan("In", at("07:00"), { barcode: "058556050101" }), scan("In", at("07:30"), { barcode: "058556050102" })],
      at("08:00")
    );
    expect(ivs.map((iv) => [iv.barcode, iv.inProgress])).toEqual([["058556050102", true]]);
  });

  it("pairs by station number, not by name", () => {
    // The station was renamed between In and Out: still the same station.
    const ivs = pairScans(
      [scan("In", at("07:00"), { station: "Station 10" }), scan("Out", at("07:05"), { station: "Svejs 1" })],
      at("12:00")
    );
    expect(ivs).toHaveLength(1);
    expect(ivs[0].durationMs).toBe(5 * MIN);
    expect(ivs[0].inProgress).toBe(false);
  });

  it("keeps two stations with the same name but different numbers apart", () => {
    const ivs = pairScans(
      [
        scan("In", at("07:00"), { stationNo: 1 }),
        scan("In", at("07:01"), { stationNo: 2 }),
        scan("Out", at("07:04"), { stationNo: 1 }),
        scan("Out", at("07:09"), { stationNo: 2 }),
      ],
      at("12:00")
    );
    expect(ivs.map((iv) => [iv.stationNo, iv.durationMs / MIN, iv.visit])).toEqual([
      [1, 4, 1],
      [2, 8, 1],
    ]);
    expect(summarizeStations(ivs).map((l) => l.stationNo)).toEqual([1, 2]);
  });

  it("pairs by name when a row has no station number", () => {
    const ivs = pairScans(
      [scan("In", at("07:00"), { stationNo: null }), scan("Out", at("07:05"), { stationNo: null })],
      at("12:00")
    );
    expect(ivs).toHaveLength(1);
  });

  it("lets the later In win when a second In comes at the same station", () => {
    const ivs = pairScans(
      [scan("In", at("07:00")), scan("In", at("07:30")), scan("Out", at("07:40"))],
      at("12:00")
    );
    expect(ivs).toHaveLength(1);
    expect(ivs[0].start).toBe(at("07:30"));
    expect(ivs[0].durationMs).toBe(10 * MIN);
  });

  it("puts the start of an Out without an In back from DurationSec", () => {
    const [iv] = pairScans([scan("Out", at("06:10"), { durationSec: 600 })], at("12:00"));
    expect(iv.start).toBe(at("06:00"));
    expect(iv.startEstimated).toBe(true);
  });

  it("skips an Out with neither an In nor DurationSec", () => {
    expect(pairScans([scan("Out", at("06:10"))], at("12:00"))).toEqual([]);
  });

  it("counts a scan sent twice (same ScanId) once", () => {
    const [i, o] = pass(at("07:00"), at("07:05"));
    const ivs = pairScans([i, o, { ...o }, { ...i }], at("12:00"));
    expect(ivs).toHaveLength(1);
  });

  it("does not depend on the order the rows arrive in", () => {
    const scans = [...pass(at("07:00"), at("07:05")), ...pass(at("08:00"), at("08:02"))];
    const forward = pairScans(scans, at("12:00"));
    const backward = pairScans([...scans].reverse(), at("12:00"));
    expect(backward).toEqual(forward);
  });

  it("pairs In and Out with the same timestamp as a zero-length pass", () => {
    const t = at("07:00");
    const ivs = pairScans([scan("Out", t), scan("In", t)], at("12:00"));
    expect(ivs).toHaveLength(1);
    expect(ivs[0].durationMs).toBe(0);
  });
});

describe("order status", () => {
  it("is packed when it has an Out at packing and nothing is in progress", () => {
    const scans = [...pass(at("07:00"), at("07:05")), ...pass(at("07:10"), at("07:12"), PACKING)];
    expect(orderStatus(pairScans(scans, at("12:00")))).toBe("packed");
  });

  it("is not packed while another element is still in progress", () => {
    const scans = [
      ...pass(at("07:10"), at("07:12"), PACKING),
      scan("In", at("07:00"), { barcode: "058556050101" }),
    ];
    expect(orderStatus(pairScans(scans, at("07:30")))).toBe("active");
  });

  it("stays packed after a finished rework pass (the last scan need not be the packing Out)", () => {
    const scans = [...pass(at("07:10"), at("07:12"), PACKING), ...pass(at("08:00"), at("08:05"))];
    expect(orderStatus(pairScans(scans, at("12:00")))).toBe("packed");
  });

  it("is active, not packed, while a rework pass after packing is in progress", () => {
    const scans = [...pass(at("07:10"), at("07:12"), PACKING), scan("In", at("08:00"))];
    expect(orderStatus(pairScans(scans, at("08:30")))).toBe("active");
  });

  it("is not packed by an In at packing alone, nor by an untimed Out there", () => {
    const scans = [
      ...pass(at("07:00"), at("07:05")),
      scan("In", at("07:10"), PACKING),
      // An Out with neither an In nor DurationSec is no pass, so it packs nothing.
      scan("Out", at("07:20"), { ...PACKING, barcode: "058556050101" }),
    ];
    expect(orderStatus(pairScans(scans, at("07:10") + STALE_OPEN_MS + 1))).toBe("waiting");
  });

  it("is waiting between stations", () => {
    const scans = pass(at("07:00"), at("07:05"));
    expect(orderStatus(pairScans(scans, at("12:00")))).toBe("waiting");
  });
});

describe("summarizeOrders", () => {
  const scans = [
    ...pass(at("07:00"), at("07:05")),
    ...pass(at("07:06"), at("07:16"), { station: "Station 20", stationNo: 2 }),
    ...pass(at("07:20"), at("07:22"), PACKING),
    ...pass(at("07:01"), at("07:04"), { barcode: "058556050101" }),
    ...pass(at("08:00"), at("08:04"), { orderNo: 58557, barcode: "058557010101" }),
    scan("In", at("09:00"), { orderNo: 58557, barcode: "058557010101", station: "Station 20", stationNo: 2 }),
  ];
  const ivs = pairScans(scans, at("09:30"));
  const orders = summarizeOrders(ivs, scans);

  it("sums time over elements and stations", () => {
    const o = orders.find((x) => x.orderNo === 58556)!;
    expect(o.elements).toBe(2);
    expect(o.totalMs).toBe((5 + 10 + 2 + 3) * MIN);
    expect(o.stations).toEqual(["Station 10", "Station 20", "Pakning"]);
    expect(o.status).toBe("packed");
    expect(o.firstScan).toBe(at("07:00"));
    expect(o.lastScan).toBe(at("07:22"));
  });

  it("includes in-progress time and lists where", () => {
    const o = orders.find((x) => x.orderNo === 58557)!;
    expect(o.status).toBe("active");
    expect(o.activeAt).toEqual(["Station 20"]);
    expect(o.totalMs).toBe((4 + 30) * MIN);
  });

  it("puts the most recent activity first", () => {
    expect(orders.map((o) => o.orderNo)).toEqual([58557, 58556]);
  });

  it("computes the KPIs", () => {
    const k = computeKpis(ivs, orders);
    expect(k.elements).toBe(3);
    expect(k.orders).toBe(2);
    expect(k.ordersPacked).toBe(1);
    expect(k.inProgress).toBe(1);
    expect(k.totalWorkedMs).toBe((5 + 10 + 2 + 3 + 4 + 30) * MIN);
    // Finished passes only: 5, 10, 2, 3, 4 minutes.
    expect(k.averagePassMs).toBe(4.8 * MIN);
  });
});

describe("summarizeStations", () => {
  it("gives done, average and utilisation over the span so far", () => {
    const scans = [
      ...pass(at("08:00"), at("08:10")),
      ...pass(at("08:10"), at("08:30"), { barcode: "058556050101" }),
      scan("In", at("08:40"), { station: "Station 20", stationNo: 2 }),
    ];
    const lines = summarizeStations(pairScans(scans, at("09:00")), at("09:00"));
    expect(lines.map((l) => l.station)).toEqual(["Station 10", "Station 20"]);
    const s10 = lines[0];
    expect(s10.done).toBe(2);
    expect(s10.averageMs).toBe(15 * MIN);
    expect(s10.utilisation).toBeCloseTo(30 / 60);
    const s20 = lines[1];
    expect(s20.done).toBe(0);
    expect(s20.averageMs).toBeNull();
    expect(s20.active).toBe(1);
    expect(s20.utilisation).toBeCloseTo(20 / 60);
  });

  it("returns nothing for no work", () => {
    expect(summarizeStations([])).toEqual([]);
  });
});

describe("intervalsStartingIn", () => {
  it("gives an interval to the day it started", () => {
    const scans = [scan("In", at("23:50", "2026-10-20")), scan("Out", at("00:10"))];
    const ivs = pairScans(scans, at("12:00"));
    expect(intervalsStartingIn(ivs, dayStart("2026-10-20"), dayEnd("2026-10-20"))).toHaveLength(1);
    expect(intervalsStartingIn(ivs, dayStart("2026-10-21"), dayEnd("2026-10-21"))).toHaveLength(0);
  });
});

describe("summarizeElements", () => {
  it("labels positions and sorts by position, sub-position, piece", () => {
    const scans = [
      ...pass(at("07:00"), at("07:05"), { barcode: "058556050203", position: 5, subPosition: 2, piece: 3 }),
      ...pass(at("07:00"), at("07:04"), { barcode: "058556040101", position: 4, subPosition: 1, piece: 1 }),
      ...pass(at("08:00"), at("08:01"), { barcode: "058556040101", position: 4, subPosition: 1, piece: 1 }),
    ];
    const els = summarizeElements(pairScans(scans, at("12:00")));
    expect(els.map((e) => [e.label, e.piece, e.totalMs / MIN, e.reworkPasses])).toEqual([
      ["Pos. 4", 1, 5, 1],
      ["Pos. 5.1", 3, 5, 0],
    ]);
  });
});

describe("buildTimeline", () => {
  it("splits by day, one lane per station, axis on whole hours", () => {
    const scans = [
      ...pass(at("07:10", "2026-10-20"), at("07:20", "2026-10-20")),
      ...pass(at("13:10", "2026-10-20"), at("13:40", "2026-10-20"), PACKING),
      ...pass(at("06:30"), at("06:45"), { station: "Station 20", stationNo: 2 }),
    ];
    const days = buildTimeline(pairScans(scans, at("12:00")));
    expect(days.map((d) => d.day)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(days[0].lanes.map((l) => l.station)).toEqual(["Station 10", "Pakning"]);
    expect(days[0].axisStart).toBe(at("07:00", "2026-10-20"));
    expect(days[0].axisEnd).toBe(at("14:00", "2026-10-20"));
    expect(days[0].totalMs).toBe(40 * MIN);
    expect(days[1].lanes[0].bars).toHaveLength(1);
  });
});

describe("sortOrders", () => {
  const scans = [
    ...pass(at("07:00"), at("07:30"), { orderNo: 1, barcode: "000001010101" }),
    ...pass(at("08:00"), at("08:10"), { orderNo: 2, barcode: "000002010101" }),
    ...pass(at("08:10"), at("08:20"), { orderNo: 2, barcode: "000002010102" }),
  ];
  const orders = summarizeOrders(pairScans(scans, at("12:00")), scans);

  it("sorts by total time", () => {
    expect(sortOrders(orders, "total", "desc").map((o) => o.orderNo)).toEqual([1, 2]);
    expect(sortOrders(orders, "total", "asc").map((o) => o.orderNo)).toEqual([2, 1]);
  });

  it("sorts by time per element", () => {
    expect(sortOrders(orders, "perElement", "asc").map((o) => o.orderNo)).toEqual([2, 1]);
  });

  it("breaks ties by order number", () => {
    expect(sortOrders(orders, "stations", "desc").map((o) => o.orderNo)).toEqual([1, 2]);
  });
});
