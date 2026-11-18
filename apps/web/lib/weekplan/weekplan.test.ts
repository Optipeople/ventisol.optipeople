// The week plan: the element classifier on the position texts 3E writes, the
// MDB tables to the plan, the workbook, and the route logic. The cases are
// orders from week 48 2026, checked against the office's own sheets.

import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { frameFields, frameType, parseParts, positionFrameTypes, productionGroup, type PositionFacts } from "./classify";
import { handleWeekPlan } from "./handler";
import { readWeekPlanTables, splitYearWeek, type WeekPlanTables } from "./mdb";
import type { WeekPlan } from "./types";
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

/** Order 58781 as 3E holds it: three top hung Danline windows and a terrace door. */
function tables(): WeekPlanTables {
  const id = "K1";
  const pos = (Position: number, Stueck: number, extra: Record<string, unknown>) => ({
    ID_A_Kopf: id,
    Position,
    Stueck,
    SerieNr: 0,
    PosZeit: 0,
    AnzFlg: 0,
    FSystem: "70 mm DANLINE",
    Typnummer: null,
    P_Art: 0,
    ...extra,
  });
  return {
    A_Kopf: [
      { ID: id, AuNummer: 58781, A_Summe: 21528, Sachbearb1: "Flemming B" },
      { ID: "K2", AuNummer: 58790, A_Summe: 6663, Sachbearb1: "Flemming B" },
    ],
    A_KopfFreie: [{ ID_A_Kopf: id, Feld2: "ja", Feld3: "ja", Feld4: null, Feld6: "Kogreb knop begge sider" }],
    A_Adresse: [
      { ID_A_Kopf: id, Nummer: 0, Firma: "Kongerslev Trælast Aps" },
      { ID_A_Kopf: id, Nummer: 1, Firma: "Leveringsadresse" },
    ],
    A_Planung: [
      { ID_A_Kopf: id, WocheW: "2648" },
      { ID_A_Kopf: "K2", WocheW: "2649" },
    ],
    A_Vorgang: [
      { ID_A_Kopf: id, Nummer: "_AufAnlage", Benutzer: "FBV" },
      { ID_A_Kopf: id, Nummer: "_AufDruck", Benutzer: "mub" },
      { ID_A_Kopf: "K2", Nummer: "_AngAnlage", Benutzer: "FBV" },
    ],
    P_Allgemein: [
      { ID_A_Kopf: id, Position: 0, Positionstext: "TD \r\nTD HU 105T alu" },
      { ID_A_Kopf: id, Position: 1, Positionstext: "TS\r\nTopstyret" },
      { ID_A_Kopf: id, Position: 2, Positionstext: "TD \r\nTD HU 105T alu" },
      { ID_A_Kopf: id, Position: 3, Positionstext: "Fragt / forsendelse\r\n" },
    ],
    P_Technik: [
      pos(0, 1, { PosZeit: 999 }),
      pos(1, 4, { SerieNr: 260825, PosZeit: 85.4, AnzFlg: 1 }),
      pos(2, 1, { SerieNr: 260827, PosZeit: 132.86, AnzFlg: 1, FSystem: "70 mm softline" }),
      pos(3, 1, { P_Art: 3, Typnummer: "Fragt:" }),
    ],
    P_Element: [
      { ID_A_Kopf: id, Position: 1, Ez: 1, Feldnummer: "00~00" },
      { ID_A_Kopf: id, Position: 2, Ez: 1, Feldnummer: "00~00" },
    ],
  };
}

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
      htm: null,
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
    expect(plan.orders[1]).toMatchObject({ customer: "", foilApproved: false, elements: 0, responsible: "fbv" });
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

  it("names the file and the production state", () => {
    expect(weekPlanFileName({ year: 2026, week: 48, fileName: null, orders: [] })).toBe("ugeplan-uge-48-2026.xlsx");
    expect(productionText(undefined)).toBe("Ikke startet");
    expect(productionText({ status: "in_progress", elementsExpected: 5, elementsPacked: 2, packedDay: null })).toBe(
      "I gang, 2 af 5 pakket"
    );
  });
});

describe("handleWeekPlan", () => {
  let db: TestDb;
  const admin = testClaims("admin");
  const viewer = testClaims("viewer");
  const as = (claims: Claims | null, allow = true) => ({
    getAccess: async () => (claims ? { claims } : null),
    now: () => NOW,
    allow: async () => allow,
  });
  const post = (body: unknown) =>
    new Request("http://localhost/api/ugeplan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    await db.reset();
    await seedConfig(db);
    await seedOctober(db, IN_PROGRESS_ORDERS);
  });
  afterAll(() => db.close());

  it("returns the workbook with the portal's status and leaves an audit row", async () => {
    const [known] = await db.withService((tx) =>
      tx.query<{ order_no: number; status: string }>("select order_no, status from core.orders where status = 'packed' order by order_no limit 1")
    );
    const plan: WeekPlan = readWeekPlanTables(tables(), "Uge 48.MDB");
    plan.orders[0].orderNo = known.order_no;

    const res = await handleWeekPlan(post(plan), as(viewer));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="ugeplan-uge-48-2026.xlsx"');
    const bks = await readSheet(Buffer.from(await res.arrayBuffer()), "BKS");
    const row = bks.find((r) => r[1] === known.order_no)!;
    expect(String(row[bks[7].indexOf("Prod.")])).toMatch(/^Pakket/);

    const log = await db.withService((tx) => tx.query<{ action: string; subject: string }>("select action, subject from app.audit_log"));
    expect(log).toEqual([{ action: "export.weekplan", subject: "ugeplan-uge-48-2026.xlsx" }]);
  });

  it("refuses: 401 signed out, 429 over the limit, 400 for no plan, 413 too big", async () => {
    const plan = readWeekPlanTables(tables(), null);
    expect((await handleWeekPlan(post(plan), as(null))).status).toBe(401);
    expect((await handleWeekPlan(post(plan), as(admin, false))).status).toBe(429);
    expect((await handleWeekPlan(post("not json"), as(admin))).status).toBe(400);
    expect((await handleWeekPlan(post({ ...plan, orders: [{ orderNo: "x" }] }), as(admin))).status).toBe(400);
    expect((await handleWeekPlan(post("x".repeat(2_000_001)), as(admin))).status).toBe(413);
  });
});
