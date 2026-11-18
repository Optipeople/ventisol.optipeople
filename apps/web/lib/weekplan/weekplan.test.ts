// The week plan: the element classifier on the position texts 3E writes, the
// MDB tables to the plan and the workbook. The production lists, the merge
// and the route logic are in portal.test.ts. The cases are
// orders from week 48 2026, checked against the office's own sheets.

import { readSheet } from "read-excel-file/node";
import { describe, expect, it } from "vitest";
import { foilText, frameFields, frameType, isFoilColour, orderFoil, parseParts, positionFrameTypes, productionGroup, type PositionFacts } from "./classify";
import { readWeekPlanTables, splitYearWeek } from "./mdb";
import { tables } from "./test-support";
import { columnLetter, infoLines, productionText, weekPlanFileName, weekPlanWorkbook } from "./workbook";

const facts = (firstLine: string, system: string, secondLine = "", typeNumber: string | null = null): PositionFacts => ({
  firstLine,
  secondLine,
  system,
  typeNumber,
});
const typeOf = (f: PositionFacts) => frameType(parseParts(f.firstLine), f)?.type ?? null;

describe("classify", () => {
  it("parses parts with repeats", () => {
    expect(parseParts("2 * FK / ID").map((p) => p.code)).toEqual(["FK", "FK", "ID"]);
    expect(parseParts("16 * FK / DK HI / DK VI")).toHaveLength(18);
    expect(parseParts("Fragt / forsendelse").map((p) => p.code)).toEqual([null, null]);
  });

  it("reads the fields of a frame", () => {
    expect(frameFields("00~00~04~00~08~00~09~00~16~00")).toEqual([0, 4, 8, 9, 16]);
    expect(frameFields("00~00")).toEqual([0]);
    expect(frameFields(null)).toEqual([]);
  });

  it("types single frames as the office does", () => {
    expect(typeOf(facts("TS", "70 mm DANLINE"))).toBe("TS");
    expect(typeOf(facts("TD", "70 mm softline", "TD HU 105T alu"))).toBe("TD");
    expect(typeOf(facts("TD HI  / TD ST V.I.", "70 mm softline"))).toBe("DB DK TD");
    expect(typeOf(facts("ID", "70 mm Industri", "ID F VU galv"))).toBe("SD");
    expect(typeOf(facts("ID", "70 mm Industri", "ID F VU alu"))).toBe("FD/ID");
    expect(typeOf(facts("ID / ID ST", "70 mm Industri", "ID F VU galv / ID 2.  HU galv"))).toBe("DB SD");
    expect(typeOf(facts("FD", "70 mm softline"))).toBe("FD/ID");
    expect(typeOf(facts("FK", "70 mm SV & SJV"))).toBe("FK S");
    expect(typeOf(facts("FK", "70 mm DANLINE"))).toBe("FK DL");
    expect(typeOf(facts("FK", "70 mm softline"))).toBe("FK");
    expect(typeOf(facts("BH", "70 mm SV & SJV"))).toBe("SV");
    expect(typeOf(facts("DK HI / DK VI", "70 mm softline"))).toBe("DB DK");
    expect(typeOf(facts("DK HI / FK", "70 mm Industri"))).toBe("DK");
    expect(typeOf(facts("SH V / FR / SH H", "70 mm DANLINE"))).toBe("DB SH");
    expect(typeOf(facts("SH H", "70 mm DANLINE"))).toBe("SH");
    expect(typeOf(facts("Sideh. VI", "70 mm Industri"))).toBe("DK");
    expect(typeOf(facts("3 * FK / TS", "70 mm DANLINE"))).toBe("TS");
    expect(typeOf(facts("DK VI", "70 mm Industri", "", "S70Scan type10B"))).toBe("T10");
    expect(typeOf(facts("Montage:", "70 mm DANLINE"))).toBeNull();
  });

  it("types each frame of a coupled element by its own fields", () => {
    const coupled = facts("16 * FK / DK HI / DK VI", "70 mm Industri");
    const frames = [
      "00~00~04~00~08~00~09~00~16~00",
      "01~00~05~00~10~00~11~00",
      "02~00~06~00~12~00~13~00",
      "03~00~07~00~14~00~15~00~17~00",
    ];
    expect(positionFrameTypes(coupled, frames).map((t) => t?.type)).toEqual(["DK", "FK", "FK", "DK"]);
    const door = facts("2 * FK / ID", "70 mm Industri", "ID F HU alu");
    expect(positionFrameTypes(door, ["00~00~02~00", "01~00"]).map((t) => t?.type)).toEqual(["FD/ID", "FK"]);
  });

  it("groups for the production sheet by the leading part", () => {
    expect(productionGroup({ type: "FD/ID", base: "ID" })).toBe("stableDoors");
    expect(productionGroup({ type: "FD/ID", base: "FD" })).toBe("facadeDoors");
    expect(productionGroup({ type: "DB DK TD", base: "TD" })).toBe("turnTiltFixed");
    expect(productionGroup({ type: "FK S", base: "FK" })).toBe("turnTiltFixed");
    expect(productionGroup({ type: "FK DL", base: "FK" })).toBe("danline");
    expect(productionGroup({ type: "T10", base: "T" })).toBe("scan");
  });
});

describe("readWeekPlanTables", () => {
  it("reads an order the way the office sheets count it", () => {
    const plan = readWeekPlanTables(tables(), "Uge 48.MDB");
    expect(plan.week).toBe(48);
    expect(plan.year).toBe(2026);
    expect(plan.orders.map((o) => o.orderNo)).toEqual([58781, 58790]);
    const [o] = plan.orders;
    expect(o).toMatchObject({
      customer: "Kongerslev Trælast Aps",
      responsible: "fbv",
      amount: 21528,
      remark: "Kogreb knop begge sider",
      foilApproved: true,
      foil: "delvis",
      htm: null,
      freeFields: { "1": "2", "2": "ja", "3": "ja", "6": "Kogreb knop begge sider" },
      hours: 7.9,
      batches: [260825, 260827],
      freight: "Fragt / forsendelse",
      elements: 5,
      welds: 10,
      week: 2648,
      unknown: [],
    });
    expect(o.types).toEqual([
      { type: "TS", base: "TS", count: 4 },
      { type: "TD", base: "TD", count: 1 },
    ]);
    expect(plan.orders[1]).toMatchObject({
      customer: "",
      foilApproved: false,
      foil: null,
      elements: 0,
      responsible: "fbv",
      htm: "HTM bestilt",
      freeFields: { "4": "Bestilt", "36": "sidste felt" },
    });
    // An older export without colours and articles still reads.
    const bare = readWeekPlanTables({ ...tables(), P_Werkstoffe: undefined, P_Artikel: undefined }, null);
    expect(bare.orders[0]).toMatchObject({ foil: null, htm: null });
    expect(bare.orders[1].htm).toBe("HTM bestilt");
  });

  it("splits yyww", () => {
    expect(splitYearWeek(2648)).toEqual([2026, 48]);
    expect(splitYearWeek(2660)).toBeNull();
    expect(splitYearWeek(0)).toBeNull();
  });
});

describe("workbook", () => {
  it("names columns past Z", () => {
    expect([0, 25, 26, 47].map(columnLetter)).toEqual(["A", "Z", "AA", "AV"]);
  });

  it("writes the three sheets with the office columns and the portal status", async () => {
    const plan = readWeekPlanTables(tables(), "Uge 48.MDB");
    const status = new Map([[58781, { status: "packed" as const, elementsExpected: 5, elementsPacked: 5, packedDay: "2026-11-20" }]]);
    const buffer = await weekPlanWorkbook({ plan, status, generated: "Dannet 18-11-2026 11:00" });

    const kontor = await readSheet(buffer, "Kontor");
    expect(kontor[0][0]).toBe("Kontor, uge 48 2026");
    expect(kontor[7].slice(0, 4)).toEqual(["Kunde", "Ordre", "Ansv.", "Beløb"]);
    expect(kontor[8].slice(0, 4)).toEqual(["Kongerslev Trælast Aps", 58781, "fbv", 21528]);
    expect(kontor[8][kontor[7].indexOf("Folie")]).toBe("Folie godkendt (delvis)");
    expect(kontor[9][kontor[7].indexOf("HTM")]).toBe("HTM bestilt");

    const free = await readSheet(buffer, "Frie felter");
    expect(free[1]).toEqual(["Kunde", "Ordre", "Frit felt 1", "Frit felt 2", "Frit felt 3", "Frit felt 4", "Frit felt 6", "Frit felt 36"]);
    expect(free[2].slice(1, 4)).toEqual([58781, "2", "ja"]);
    expect(free[3][free[1].indexOf("Frit felt 36")]).toBe("sidste felt");

    const bks = await readSheet(buffer, "BKS");
    const head = bks[7];
    const row = bks[8];
    expect(row[head.indexOf("TS")]).toBe(4);
    expect(row[head.indexOf("TD")]).toBe(1);
    expect(row[head.indexOf("Batch nr.")]).toBe("260825, 260827");
    expect(row[head.indexOf("Svejs i alt")]).toBe(10);
    expect(row[head.indexOf("Prod.")]).toBe("Pakket 20-11-2026");

    const kim = await readSheet(buffer, "Kim_Produktion");
    expect(kim[1][0]).toBe("Kunde");
    const kimRow = kim[2];
    expect(kimRow[kim[1].indexOf("Danline")]).toBe(4);
    expect(kimRow[kim[1].indexOf("FD-døre")]).toBe(1);
    expect(kimRow[kim[1].indexOf("Batch nr.")]).toBe("260825/260827");
  });

  it("says what to check by hand", () => {
    const plan = readWeekPlanTables(tables(), "Uge 48.MDB");
    const lines = infoLines(plan, new Map(), "Dannet");
    expect(lines).toContain("  58790 : uge 49 2026");
    expect(lines.at(-1)).toBe("Ikke set i produktionen endnu: 58781, 58790");
    // No en or em dashes in any text (docs/portal-architecture.md).
    expect(lines.join("\n")).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  it("says Folie from approval and colours", () => {
    expect(foilText({ foilApproved: true, foil: "folie" })).toBe("Folie godkendt");
    expect(foilText({ foilApproved: false, foil: "folie" })).toBe("Folie");
    expect(foilText({ foilApproved: false, foil: "delvis" })).toBe("Delvis folie");
    expect(foilText({ foilApproved: false, foil: null })).toBeNull();
    expect(isFoilColour("Lightgrau/hvid")).toBe(true);
    expect(isFoilColour("Grå")).toBe(false);
    expect(orderFoil(2, 0)).toBe("folie");
    expect(orderFoil(2, 1)).toBe("delvis");
    expect(orderFoil(0, 3)).toBeNull();
  });

  it("names the file and the production state", () => {
    expect(weekPlanFileName({ year: 2026, week: 48, fileName: null, orders: [] })).toBe("ugeplan-uge-48-2026.xlsx");
    expect(productionText(undefined)).toBe("Ikke startet");
    expect(productionText({ status: "in_progress", elementsExpected: 5, elementsPacked: 2, packedDay: null })).toBe(
      "I gang, 2 af 5 pakket"
    );
  });
});
