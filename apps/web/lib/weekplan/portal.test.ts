// The week plan from the portal's production lists: the opening functions 3E
// prints, an order from its list, the 3E file on top, the week in the URL, and
// the route logic with rpt.week_plan_documents.

import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { DEFAULT_ELEMENT_TYPE_RULES } from "@/lib/orderdoc/element-types";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { documentFrameType } from "./classify";
import { handleWeekPlan } from "./handler";
import { readWeekPlanTables } from "./mdb";
import { initialsOf, mergeWeekPlans, orderFromDocument } from "./portal";
import { tables } from "./test-support";
import type { WeekPlan } from "./types";
import { defaultPlanWeek, mondayOf, parseWeekParam, shiftWeek, weekParam } from "./week";

/** A production list of week 48 as the parser leaves it: a two-leaf stable door, two top hung windows, a rail. */
function productionList(orderNo: number) {
  return {
    header: {
      orderNumber: orderNo,
      customer: ["Kongerslev Trælast Aps", "Syrenvej 6"],
      deliveryWeek: 48,
      date: "2026-10-22",
      caseHandler: "Flemming B. Vilhelmsen",
    },
    positions: [
      {
        number: 1,
        quantity: 1,
        system: "70 mm Industri",
        frameColour: "Hvid",
        sashColour: "Hvid",
        notes: ["Kogreb knop 2 sider"],
        fields: [
          { opening: "Industridør stående", frameSize: "800,0 * 2000,0" },
          { opening: "Industridør H.U. falle m/galv.trin", frameSize: "800,0 * 2000,0" },
        ],
      },
      {
        number: 2,
        quantity: 2,
        system: "DANLINE",
        frameColour: "Lightgrau/hvid",
        sashColour: "Lightgrau/hvid",
        notes: [],
        fields: [{ opening: "Topstyret ud", frameSize: "1000,0 * 900,0" }],
      },
      { number: 3, quantity: 1, system: "SOFTLINE", notes: [], fields: [{ opening: "Montageskinne", frameSize: null }] },
    ],
  };
}

describe("from the production lists", () => {
  it("types the openings 3E prints", () => {
    const t = (openings: string[], system: string) =>
      documentFrameType(openings.map((opening) => ({ opening })), system)?.type ?? null;
    expect(t(["Bundhængt SV"], "70 mm SV & SJV")).toBe("SV");
    expect(t(["Fast karm"], "70 mm SV & SJV")).toBe("FK S");
    expect(t(["Industridør H.U. falle m/galv.trin"], "70 mm Industri")).toBe("SD");
    expect(t(["Industridør stående", "Industridør H.U. falle m/alu.trin"], "70 mm Industri")).toBe("DB FD/ID");
    expect(t(["Industri dør V.I. falle m/galv.trin"], "70 mm Industri")).toBe("SD");
    expect(t(["Drej Kip V.I."], "SOFTLINE")).toBe("DK");
    expect(t(["Dreje/kip højre"], "SOFTLINE")).toBe("DK");
    expect(t(["Dreje venstre", "Fast karm", "Dreje højre"], "SOFTLINE")).toBe("DB DK");
    expect(t(["Fast karm", "Drej Kip H.I.", "Fast karm"], "SOFTLINE")).toBe("DK");
    expect(t(["Topstyret ud"], "DANLINE")).toBe("TS");
    expect(t(["Terrassedør d/k H.I."], "SOFTLINE")).toBe("DK TD");
    expect(t(["Terrassedør V.U. m/iso. trin"], "SOFTLINE")).toBe("TD");
    expect(t(["Terrassedør drej/kip"], "SOFTLINE")).toBe("DK TD");
    expect(t(["Terrassedør h.i."], "SOFTLINE")).toBe("DK TD");
    expect(t(["Industridør H.U. med alutrin"], "70 mm Industri")).toBe("FD/ID");
    expect(t(["Fast karm", "Facadedør V.I. falle/rigle med alutrin", "Fast karm"], "SOFTLINE")).toBe("FD/ID");
    expect(t(["Sidehængt V.U. med anverfer", "Sidehængt H.U. med anverfer"], "DANLINE")).toBe("DB SH");
    expect(t(["Sidehængt højre ud"], "70 mm Industri")).toBe("DK");
    expect(t(["Fast karm"], "DANLINE")).toBe("FK DL");
    // Bente, 27-11-2026: orders 58830, 59000 and 58774.
    expect(t(["Topvende"], "DANLINE")).toBe("TV");
    expect(t(["Fast karm", "Kip / skydedør mod højre (indefra)", "Fast karm"], "SOFTLINE")).toBe("KS dør");
    expect(t(["Kip / skydedør mod venstre (indefra)"], "SOFTLINE")).toBe("KS dør");
    // Orders 58859, 58579 and 58725: counted as SD for now.
    expect(t(["Indv. dør venstre wc"], "70 mm Industri")).toBe("SD");
    expect(t(["Indv. dør venstre hængt"], "70 mm Industri")).toBe("SD");
    expect(t(["Hesteboks greb udv VU"], "70 mm Industri")).toBe("SD");
    expect(t(["Montageskinne"], "SOFTLINE")).toBeNull();
  });

  it("takes initials from the case handler's name", () => {
    expect(initialsOf("Flemming B. Vilhelmsen")).toBe("fbv");
    expect(initialsOf("Mai-Britt Undall-Behrend")).toBe("mub");
    expect(initialsOf("Vibeke Lyberth Nielsen")).toBe("vln");
    expect(initialsOf("Vibeke")).toBe("Vibeke");
    expect(initialsOf(null)).toBe("");
  });

  it("reads an order from its list, with hours from the calculated times", () => {
    const seconds = new Map([
      ["doer", 3600],
      ["vindue-1-fag", 1800],
    ]);
    const o = orderFromDocument({ order_no: 58781, ...productionList(58781) }, seconds, DEFAULT_ELEMENT_TYPE_RULES, 2648);
    expect(o).toMatchObject({
      customer: "Kongerslev Trælast Aps",
      responsible: "fbv",
      amount: null,
      remark: "Kogreb knop 2 sider",
      // The door 1 h, two windows 0.5 h each, and the rail a 1-light window to the portal's rules.
      hours: 2.5,
      // The rail has no element type but is an element of the list.
      elements: 4,
      welds: 3 + 2 * 2 + 1,
      // Two Lightgrau/hvid windows, a white door and a rail without colours.
      foil: "delvis",
      freeFields: {},
      source: "portal",
    });
    expect(o.types).toEqual([
      { type: "DB SD", base: "ID", count: 1 },
      { type: "TS", base: "TS", count: 2 },
    ]);
    expect(o.unknown).toEqual(["Pos. 3: Montageskinne"]);
    expect(orderFromDocument({ order_no: 1, ...productionList(1) }, null, DEFAULT_ELEMENT_TYPE_RULES, 2648).hours).toBeNull();
  });

  it("puts the 3E file on top of the lists", () => {
    const portal: WeekPlan = {
      year: 2026,
      week: 48,
      fileName: null,
      orders: [
        orderFromDocument({ order_no: 58700, ...productionList(58700) }, null, DEFAULT_ELEMENT_TYPE_RULES, 2648),
        orderFromDocument({ order_no: 58781, ...productionList(58781) }, null, DEFAULT_ELEMENT_TYPE_RULES, 2648),
      ],
    };
    const merged = mergeWeekPlans(portal, readWeekPlanTables(tables(), "Uge 48.MDB"));
    expect(merged.fileName).toBe("Uge 48.MDB");
    expect(merged.orders.map((o) => [o.orderNo, o.source])).toEqual([
      [58700, "portal"],
      [58781, "begge"],
      [58790, "3e"],
    ]);
    expect(merged.orders[1]).toMatchObject({ amount: 21528, hours: 7.9, batches: [260825, 260827], remark: "Kogreb knop begge sider" });
    expect(mergeWeekPlans(portal, null)).toBe(portal);
  });

  it("reads and moves the week in the URL", () => {
    expect(parseWeekParam("2026-48")).toEqual({ year: 2026, week: 48 });
    expect(parseWeekParam("2026-53")).toEqual({ year: 2026, week: 53 });
    expect(parseWeekParam("2027-53")).toBeNull();
    expect(parseWeekParam("2026-5")).toEqual({ year: 2026, week: 5 });
    expect(parseWeekParam("48")).toBeNull();
    expect(weekParam({ year: 2026, week: 5 })).toBe("2026-05");
    expect(shiftWeek({ year: 2026, week: 53 }, 1)).toEqual({ year: 2027, week: 1 });
    expect(shiftWeek({ year: 2027, week: 1 }, -1)).toEqual({ year: 2026, week: 53 });
    expect(mondayOf({ year: 2026, week: 48 })).toBe("2026-11-23");
    expect(defaultPlanWeek(NOW)).toEqual({ year: 2026, week: 48 });
  });
});

describe("handleWeekPlan", () => {
  let db: TestDb;
  let packed: number;
  let otherPacked: number;
  const admin = testClaims("admin");
  const viewer = testClaims("viewer");
  const as = (claims: Claims | null, allow = true) => ({
    getAccess: async () => (claims ? { claims } : null),
    now: () => NOW,
    allow: async () => allow,
  });
  const get = (week = "2026-48") =>
    new Request(`http://localhost/api/ugeplan?uge=${week}`, { headers: { "x-real-ip": "10.0.0.1" } });
  const post = (body: unknown, week: string | null = "2026-48") =>
    new Request(`http://localhost/api/ugeplan${week ? `?uge=${week}` : ""}`, {
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
    [{ order_no: packed }] = await db.withService((tx) =>
      tx.query<{ order_no: number }>("select order_no from core.orders where status = 'packed' order by order_no limit 1")
    );
    // Week 48 lists of a packed order and of one not scanned yet, and a week 48 list a year older.
    const docs: { file_name: string; order_no: number; print_date: string | null; parsed: unknown }[] = [
      { file_name: "a.pdf", order_no: packed, print_date: "2026-11-18", parsed: productionList(packed) },
      { file_name: "b.pdf", order_no: 58999, print_date: "2026-11-17", parsed: productionList(58999) },
      { file_name: "c.pdf", order_no: 40001, print_date: "2025-11-17", parsed: productionList(40001) },
      // Moved: the newer list says week 50, so the order leaves week 48.
      { file_name: "d1.pdf", order_no: 58998, print_date: "2026-10-22", parsed: productionList(58998) },
      {
        file_name: "d2.pdf",
        order_no: 58998,
        print_date: "2026-11-10",
        parsed: { ...productionList(58998), header: { ...productionList(58998).header, deliveryWeek: 50 } },
      },
      // Odd parsed values must not break the call.
      {
        file_name: "e.pdf",
        order_no: 58997,
        print_date: null,
        parsed: { ...productionList(58997), header: { deliveryWeek: 48.5, date: "2026-02-30" } },
      },
    ];
    // derive takes the week from the list; the seed gave the order another. The second packed order keeps
    // its seeded week although a list says 48: the week core.orders gives an order wins.
    await db.withService((tx) =>
      tx.query("update core.orders set delivery_year = 2026, delivery_week = 48 where order_no = $1", [packed])
    );
    [{ order_no: otherPacked }] = await db.withService((tx) =>
      tx.query<{ order_no: number }>(
        "select order_no from core.orders where status = 'packed' and order_no <> $1 order by order_no limit 1",
        [packed]
      )
    );
    docs.push({ file_name: "f.pdf", order_no: otherPacked, print_date: "2026-11-18", parsed: productionList(otherPacked) });
    await db.withService((tx) =>
      tx.query(
        `insert into raw.order_documents (file_name, order_no, print_date, parsed)
         select file_name, order_no, print_date, parsed
           from jsonb_to_recordset($1::jsonb) as d(file_name text, order_no integer, print_date date, parsed jsonb)`,
        [JSON.stringify(docs)]
      )
    );
  });
  afterAll(() => db.close());

  it("builds the week from the production lists, without a file", async () => {
    const res = await handleWeekPlan(get(), as(viewer));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="ugeplan-uge-48-2026.xlsx"');
    const buffer = Buffer.from(await res.arrayBuffer());
    const bks = await readSheet(buffer, "BKS");
    const head = bks[7];
    const orderRows = bks.filter((r) => typeof r[1] === "number");
    expect(orderRows.map((r) => r[1])).toEqual([packed, 58999].sort((a, b) => a - b));
    const row = orderRows.find((r) => r[1] === packed)!;
    expect(String(row[head.indexOf("Prod.")])).toMatch(/^Pakket/);
    expect(row[head.indexOf("DB SD")]).toBe(1);
    expect(row[head.indexOf("TS")]).toBe(2);
    // The colours come through rpt.week_plan_documents.
    expect(row[head.indexOf("Folie")]).toBe("Delvis folie");
    expect(orderRows.find((r) => r[1] === 58999)![head.indexOf("Prod.")]).toBe("Ikke startet");
    // A viewer may not see the calculated times.
    const info = (await readSheet(buffer, "Om udtrækket")).map((r) => r[0]);
    expect(info).toContain("Timer er tomme: der er ingen kalkulerede tider, eller din rolle må ikke se dem (kun planlægger, ledelse og admin).");

    const log = await db.withService((tx) =>
      tx.query<{ action: string; subject: string }>("select action, subject from app.audit_log")
    );
    expect(log).toEqual([{ action: "export.weekplan", subject: "ugeplan-uge-48-2026.xlsx" }]);
  });

  it("puts the 3E file on top, and takes its week when the URL has none", async () => {
    const plan: WeekPlan = readWeekPlanTables(tables(), "Uge 48.MDB");
    plan.orders[0].orderNo = packed;
    const res = await handleWeekPlan(post(plan, null), as(admin));
    expect(res.status).toBe(200);
    const kontor = await readSheet(Buffer.from(await res.arrayBuffer()), "Kontor");
    expect(kontor.find((r) => r[1] === packed)![3]).toBe(21528);
    expect(kontor.some((r) => r[1] === 58999)).toBe(true);
    expect(kontor.some((r) => r[1] === 58790)).toBe(true);
  });

  it("refuses: 401 signed out, 429 over the limit, 400 for no plan or no week, 413 too big", async () => {
    const plan = readWeekPlanTables(tables(), null);
    expect((await handleWeekPlan(get(), as(null))).status).toBe(401);
    expect((await handleWeekPlan(get(), as(admin, false))).status).toBe(429);
    expect((await handleWeekPlan(get("2026-60"), as(admin))).status).toBe(400);
    expect((await handleWeekPlan(post("not json"), as(admin))).status).toBe(400);
    expect((await handleWeekPlan(post({ ...plan, orders: [{ orderNo: "x" }] }), as(admin))).status).toBe(400);
    expect((await handleWeekPlan(post({ ...plan, year: null, week: null }, null), as(admin))).status).toBe(400);
    // A 3E file of another week than the one asked for.
    const otherWeek = await handleWeekPlan(post(plan, "2026-47"), as(admin));
    expect(otherWeek.status).toBe(400);
    expect(await otherWeek.text()).toContain("uge 48 2026, ikke uge 47 2026");
    expect((await handleWeekPlan(post("x".repeat(2_000_001)), as(admin))).status).toBe(413);
  });
});
