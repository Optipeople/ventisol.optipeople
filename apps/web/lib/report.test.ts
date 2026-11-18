import { describe, expect, it } from "vitest";
import {
  computeKpis,
  intervalsEndingIn,
  orderStatus,
  pairScans,
  STALE_OPEN_MS,
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

  it("has at most one element in progress at a station with Max i gang 1: the latest In", () => {
    const ivs = pairScans(
      [scan("In", at("07:00"), { barcode: "058556050101" }), scan("In", at("07:30"), { barcode: "058556050102" })],
      at("08:00")
    );
    expect(ivs.map((iv) => [iv.barcode, iv.inProgress])).toEqual([["058556050102", true]]);
  });

  it("has at most Max i gang elements in progress at a station: the latest Ins", () => {
    const ins = [
      scan("In", at("07:00"), { barcode: "058556050101" }),
      scan("In", at("07:10"), { barcode: "058556050102" }),
      scan("In", at("07:20"), { barcode: "058556050103" }),
    ];
    const two = pairScans(ins, at("08:00"), { 1: 2 });
    expect(two.map((iv) => [iv.barcode, iv.inProgress])).toEqual([
      ["058556050102", true],
      ["058556050103", true],
    ]);
    // Another station's max does not apply here.
    expect(pairScans(ins, at("08:00"), { 2: 6 }).map((iv) => iv.barcode)).toEqual(["058556050103"]);
    expect(pairScans(ins, at("08:00"), { 1: 6 })).toHaveLength(3);
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
  it("is active while something on the order is in progress", () => {
    const scans = [...pass(at("07:10"), at("07:12"), PACKING), scan("In", at("07:00"), { barcode: "058556050101" })];
    expect(orderStatus(pairScans(scans, at("07:30")))).toBe("active");
  });

  it("is only idle, never packed, when nothing is in progress, even after packing", () => {
    const scans = [...pass(at("07:00"), at("07:05")), ...pass(at("07:10"), at("07:12"), PACKING)];
    expect(orderStatus(pairScans(scans, at("12:00")))).toBe("idle");
  });

  it("is idle between stations", () => {
    expect(orderStatus(pairScans(pass(at("07:00"), at("07:05")), at("12:00")))).toBe("idle");
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
    expect(o.status).toBe("idle");
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

  it("counts elements the same way per order and in the KPI: barcodes with a timed pass", () => {
    // An Out with no In and no DurationSec cannot be timed. Its order is
    // listed (it was scanned), but the barcode is not an element worked on.
    const untimed = scan("Out", at("07:30"), { barcode: "058556050109" });
    const lost = scan("Out", at("07:40"), { orderNo: 58558, barcode: "058558010101" });
    const all = [...scans, untimed, lost];
    const intervals = pairScans(all, at("09:30"));
    const lines = summarizeOrders(intervals, all);
    expect(lines.find((x) => x.orderNo === 58556)!.elements).toBe(2);
    expect(lines.find((x) => x.orderNo === 58558)).toMatchObject({ elements: 0, totalMs: 0, days: [] });
    const k = computeKpis(intervals, lines);
    expect(k.elements).toBe(3);
    expect(k.elements).toBe(lines.reduce((t, o) => t + o.elements, 0));
  });

  it("counts the days worked by the day a pass ended, as the day and period views do", () => {
    const overnight = [
      ...pass(at("15:00", "2026-10-20"), at("07:00")),
      ...pass(at("08:00"), at("08:10"), { station: "Station 20", stationNo: 2 }),
    ];
    const [o] = summarizeOrders(pairScans(overnight, at("12:00")), overnight);
    expect(o.days).toEqual(["2026-10-21"]);
  });

  it("computes the KPIs", () => {
    const k = computeKpis(ivs, orders);
    expect(k.elements).toBe(3);
    expect(k.orders).toBe(2);
    expect(k.ordersAtPacking).toBe(1);
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
    const lines = summarizeStations(pairScans(scans, at("09:00")), { until: at("09:00") });
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

  describe("with a pass left overnight", () => {
    const from = dayStart("2026-10-21");
    const scans = [
      // Left at station 1 at 15:00 the day before, finished at 07:00.
      ...pass(at("15:00", "2026-10-20"), at("07:00")),
      // Station 2 works 08:00 to 10:00.
      ...pass(at("08:00"), at("10:00"), { barcode: "058556050101", station: "Station 20", stationNo: 2 }),
    ];
    const ivs = pairScans(scans, at("12:00"));

    it("starts the span at the first scan of the day, not at yesterday's In or at midnight", () => {
      const [one, two] = summarizeStations(ivs, { from, until: at("12:00") });
      // The first scan today is the Out at 07:00: 07:00 to 12:00 is 5 hours.
      // Station 1 only scanned out then, so the night is not work on this day.
      expect(one.utilisation).toBe(0);
      expect(two.utilisation).toBeCloseTo(2 / 5, 10);
    });

    it("does not dilute the other stations or credit the night to the overnight one", () => {
      // In 15:00 yesterday, Out 07:10 today; station 2 works 07:00 to 14:00; seen at 15:00.
      const day = pairScans(
        [
          ...pass(at("15:00", "2026-10-20"), at("07:10")),
          ...pass(at("07:00"), at("14:00"), { barcode: "058556050101", station: "Station 20", stationNo: 2 }),
        ],
        at("15:00")
      );
      const [one, two] = summarizeStations(day, { from, until: at("15:00") });
      // The span is 07:00 to 15:00, 8 hours: 7 of 8, not 7 of 15.
      expect(two.utilisation).toBeCloseTo(7 / 8, 10);
      // Station 1 gets its ten minutes after 07:00, not the night.
      expect(one.utilisation).toBeCloseTo(10 / (8 * 60), 10);
      expect(one.busyMs).toBe((16 * 60 + 10) * MIN);
    });

    it("starts at an In of the day that comes before the overnight Out", () => {
      const day = pairScans(
        [
          ...pass(at("15:00", "2026-10-20"), at("09:00")),
          ...pass(at("06:00"), at("08:00"), { barcode: "058556050101", station: "Station 20", stationNo: 2 }),
        ],
        at("10:00")
      );
      const [one, two] = summarizeStations(day, { from, until: at("10:00") });
      // 06:00 to 10:00; station 1 is at work on the overnight pass until 09:00.
      expect(one.utilisation).toBeCloseTo(3 / 4, 10);
      expect(two.utilisation).toBeCloseTo(2 / 4, 10);
    });

    it("was distorted without the day start: the span ran back to yesterday", () => {
      const [one, two] = summarizeStations(ivs, { until: at("12:00") });
      expect(one.utilisation).toBeCloseTo(16 / 21, 10);
      expect(two.utilisation).toBeCloseTo(2 / 21, 10);
    });

    it("keeps the whole pass in the time worked and the average", () => {
      const [one] = summarizeStations(ivs, { from, until: at("12:00") });
      expect(one.busyMs).toBe(16 * 60 * MIN);
      expect(one.averageMs).toBe(16 * 60 * MIN);
      expect(one.done).toBe(1);
    });

    it("ends a finished day at its last scan", () => {
      const [one, two] = summarizeStations(ivs, { from });
      // 07:00 to 10:00.
      expect(one.utilisation).toBe(0);
      expect(two.utilisation).toBeCloseTo(2 / 3, 10);
    });

    it("starts the span at the first scan when that is later than midnight", () => {
      const day = pairScans(pass(at("08:00"), at("09:00")), at("12:00"));
      const [line] = summarizeStations(day, { from, until: at("12:00") });
      expect(line.utilisation).toBeCloseTo(1 / 4, 10);
    });

    it("has no span yet when the only work is in progress since yesterday: no scan today", () => {
      const open = pairScans([scan("In", at("20:00", "2026-10-20"))], at("06:00"));
      const [line] = summarizeStations(open, { from, until: at("06:00") });
      expect(line.utilisation).toBe(0);
      expect(line.busyMs).toBe(10 * 60 * MIN);
      expect(line.active).toBe(1);
    });

    it("counts an element in progress since yesterday from the day's first scan", () => {
      const day = pairScans(
        [
          scan("In", at("20:00", "2026-10-20")),
          ...pass(at("07:00"), at("08:00"), { barcode: "058556050101", station: "Station 20", stationNo: 2 }),
        ],
        at("09:00")
      );
      const [one, two] = summarizeStations(day, { from, until: at("09:00") });
      expect(one.utilisation).toBe(1);
      expect(two.utilisation).toBeCloseTo(1 / 2, 10);
    });

    it("gives no utilisation to a span of no length", () => {
      const open = pairScans([scan("In", from)], from);
      expect(summarizeStations(open, { from, until: from })[0].utilisation).toBe(0);
    });
  });
});

describe("intervalsEndingIn", () => {
  it("gives an interval to the day it ended", () => {
    const scans = [scan("In", at("23:50", "2026-10-20")), scan("Out", at("00:10"))];
    const ivs = pairScans(scans, at("12:00"));
    expect(intervalsEndingIn(ivs, dayStart("2026-10-20"), dayEnd("2026-10-20"))).toHaveLength(0);
    expect(intervalsEndingIn(ivs, dayStart("2026-10-21"), dayEnd("2026-10-21"))).toHaveLength(1);
  });
});
