import { describe, expect, it } from "vitest";
import { getValue, parseBarcode, parseScanRow, parseScanTime, positionLabel } from "@/lib/scans";

describe("positionLabel", () => {
  it("treats sub-position 01 as the position itself", () => {
    expect(positionLabel(5, 1)).toBe("Pos. 5");
    expect(positionLabel(4, null)).toBe("Pos. 4");
  });
  it("numbers the sub-positions from .1", () => {
    expect(positionLabel(5, 2)).toBe("Pos. 5.1");
    expect(positionLabel(5, 3)).toBe("Pos. 5.2");
  });
});

describe("parseBarcode", () => {
  it("splits the 12-digit label", () => {
    expect(parseBarcode("058556050103")).toEqual({ orderNo: 58556, position: 5, subPosition: 1, piece: 3 });
  });
  it("reads the start of the 14-digit form the same way", () => {
    expect(parseBarcode("05866002010301")?.orderNo).toBe(58660);
  });
  it("rejects anything else", () => {
    expect(parseBarcode("12345")).toBeNull();
    expect(parseBarcode("05855605010X")).toBeNull();
  });
});

describe("parseScanTime", () => {
  it("reads ISO with and without a zone as UTC", () => {
    expect(parseScanTime("2026-10-21T05:00:00Z")).toBe(Date.UTC(2026, 9, 21, 5));
    expect(parseScanTime("2026-10-21T05:00:00")).toBe(Date.UTC(2026, 9, 21, 5));
    expect(parseScanTime("2026-10-21T07:00:00+02:00")).toBe(Date.UTC(2026, 9, 21, 5));
  });
  it("returns null for junk", () => {
    expect(parseScanTime("")).toBeNull();
    expect(parseScanTime(null)).toBeNull();
    expect(parseScanTime("not a date")).toBeNull();
  });
});

describe("getValue", () => {
  it("matches column names case-insensitively", () => {
    expect(getValue({ scanTime: "x" }, "ScanTime")).toBe("x");
    expect(getValue({ ScanTime: "y" }, "ScanTime")).toBe("y");
    expect(getValue({}, "ScanTime")).toBeUndefined();
  });
});

describe("parseScanRow", () => {
  const values = {
    scanId: "abc",
    barcode: "058556050103",
    orderNo: 58556,
    position: 5,
    subPosition: 1,
    piece: 3,
    station: "Pakning",
    stationNo: 7,
    stationKind: "Packing",
    machineId: "",
    direction: "Out",
    scanTime: "2026-10-21T05:00:00Z",
    durationSec: 90,
    device: "PC01",
  };

  it("reads a camelCased row", () => {
    expect(parseScanRow({ id: "row1", values })).toEqual({
      id: "abc",
      barcode: "058556050103",
      orderNo: 58556,
      position: 5,
      subPosition: 1,
      piece: 3,
      station: "Pakning",
      stationNo: 7,
      stationKind: "Packing",
      direction: "Out",
      time: Date.UTC(2026, 9, 21, 5),
      durationSec: 90,
      device: "PC01",
    });
  });

  it("reads PascalCase columns and string numbers", () => {
    const s = parseScanRow({
      id: "row2",
      values: { Barcode: "058556050103", Station: "Station 10", Direction: "in", ScanTime: "2026-10-21T05:00:00Z", OrderNo: "58556", DurationSec: "" },
    });
    expect(s?.direction).toBe("In");
    expect(s?.orderNo).toBe(58556);
    expect(s?.durationSec).toBeNull();
    expect(s?.id).toBe("row2");
  });

  it("falls back to the barcode for order and position", () => {
    const s = parseScanRow({
      id: "row3",
      values: { barcode: "058556050203", station: "Station 10", direction: "In", scanTime: "2026-10-21T05:00:00Z" },
    });
    expect([s?.orderNo, s?.position, s?.subPosition, s?.piece]).toEqual([58556, 5, 2, 3]);
    expect(s?.stationKind).toBe("Assembly");
  });

  it("rejects a row without direction, time or station", () => {
    expect(parseScanRow({ id: "a", values: { ...values, direction: "Sideways" } })).toBeNull();
    expect(parseScanRow({ id: "b", values: { ...values, scanTime: null } })).toBeNull();
    expect(parseScanRow({ id: "c", values: { ...values, station: "" } })).toBeNull();
  });
});
