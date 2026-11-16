import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEMENT_TYPE_RULES,
  ELEMENT_TYPES,
  type ElementTypeRule,
  type OrderDocument,
  type OrderField,
  type OrderPosition,
  PARSER_VERSION,
  classifyElementType,
  elementTypeName,
  expectedElements,
  parseElementBarcode,
  parseOrderDocument,
  parseOrderFileName,
  positionFor,
  positionForBarcode,
  toSearchChunks,
} from "./index";

// ----- Made-up documents

const field = (number: string, opening: string | null, over: Partial<OrderField> = {}): OrderField => ({
  number,
  opening,
  frameSize: null,
  frameSizeMm: null,
  glassType: [],
  panes: [],
  seals: [],
  ...over,
});

const position = (number: number, openings: (string | null)[], over: Partial<OrderPosition> = {}): OrderPosition => ({
  label: String(number),
  number,
  subNumber: null,
  system: "SOFTLINE",
  frameColour: "Hvid",
  sashColour: "Hvid",
  sealColour: "Grå",
  quantity: 1,
  frameHoles: null,
  notes: [],
  fields: openings.map((o, i) => field(String(i + 1), o)),
  scale: "1:50",
  weightKg: null,
  sizeWithoutCoupling: null,
  cutting: [],
  fieldBars: [],
  hardware: [],
  accessories: [],
  pageIndex: 0,
  pageCount: 1,
  drawing: null,
  ...over,
});

const document = (positions: OrderPosition[], orderNumber: number | null = 58556): OrderDocument => ({
  parserVersion: PARSER_VERSION,
  fileName: null,
  pageCount: positions.length,
  header: {
    orderNumber,
    customer: ["Test Kunde A/S", "Prøvevej 1", "1234 Testby"],
    deliveryAddress: ["Byggeplads Øst", "Æblevej 2"],
    deliveryWeek: 43,
    date: "2026-10-01",
    caseHandler: "A. Person",
    packageInfo: null,
    glassDelivery: null,
    glassPallet: null,
  },
  positions,
  problems: [],
});

// ----- File names

describe("parseOrderFileName", () => {
  it.each([
    ["58721_20261022.pdf", 58721, "", "2026-10-22"],
    ["58721_20261022.PDF", 58721, "", "2026-10-22"],
    ["058721_20261022.pdf", 58721, "", "2026-10-22"],
    ["58721_20261022 (1).pdf", 58721, "", null],
    ["58721_x.pdf", 58721, "", null],
    ["58721_20261340.pdf", 58721, "", null],
    ["BE_58721_20261022.pdf", 58721, "BE", "2026-10-22"],
    ["TE_58721_20261105.pdf", 58721, "TE", "2026-11-05"],
    ["RKK_058721_20261022.pdf", 58721, "RKK", "2026-10-22"],
    ["order_58721_20261022.pdf", 58721, "order", "2026-10-22"],
    ["BE_X_58721_20261022.pdf", 58721, "BE_X", "2026-10-22"],
  ])("%s is an order document", (name, orderNumber, prefix, printDate) => {
    expect(parseOrderFileName(name)).toEqual({ orderNumber, prefix, printDate });
  });

  it.each([
    "58721.pdf",
    "BE_20261022.pdf",
    "BE_X_20261022.pdf",
    "58721_20261022.txt",
    // Two numbers before the date: which is the order? Not a guess at the first one.
    "2_58721_20261022.pdf",
    "BE_2_58721_20261022.pdf",
    "58721_2_20261022.pdf",
    "mappe/58721_20261022.pdf",
    "",
  ])("%s is not", (name) => {
    expect(parseOrderFileName(name)).toBeNull();
  });
});

// ----- Barcode to position

describe("positionForBarcode", () => {
  const doc = document([position(1, ["Fast karm"]), position(2, ["Fast karm"]), position(5, ["Fast karm"])]);

  it("reads the label barcode", () => {
    expect(parseElementBarcode("058556050103")).toEqual({ orderNumber: 58556, position: 5, subPosition: 1, piece: 3 });
    expect(parseElementBarcode("58556050103")).toEqual({ orderNumber: 58556, position: 5, subPosition: 1, piece: 3 });
    expect(parseElementBarcode("05855605010")).toBeNull();
    expect(parseElementBarcode("0585560501031")).toBeNull();
    expect(parseElementBarcode("05855605010x")).toBeNull();
  });

  it("finds the position whatever the sub-position and piece", () => {
    expect(positionForBarcode(doc, "058556010103")?.number).toBe(1);
    expect(positionForBarcode(doc, "058556020201")?.number).toBe(2);
    expect(positionForBarcode(doc, " 058556050101 ")?.number).toBe(5);
    expect(positionForBarcode(doc, "058556090101")).toBeNull();
    expect(positionForBarcode(doc, "not a barcode")).toBeNull();
  });

  it("does not answer for a barcode of another order", () => {
    expect(positionForBarcode(doc, "058557010101")).toBeNull();
    expect(positionForBarcode(document(doc.positions, null), "058557010101")?.number).toBe(1);
  });

  it("picks a printed sub-position by the barcode's sub-position", () => {
    const coupled = document([position(5, ["Fast karm"]), position(5, ["Fast karm"], { label: "5.1", subNumber: 1 })]);
    expect(positionFor(coupled, 5)?.label).toBe("5");
    expect(positionFor(coupled, 5, 1)?.label).toBe("5");
    expect(positionFor(coupled, 5, 2)?.label).toBe("5.1");
    // A sub-position the document does not print falls back to the position itself.
    expect(positionFor(coupled, 5, 3)?.label).toBe("5");
    expect(positionFor(document([position(5, [], { label: "5.1", subNumber: 1 })]), 5)?.label).toBe("5.1");
    expect(positionFor(coupled, 4)).toBeNull();
  });
});

// ----- Element types

describe("classifyElementType", () => {
  // Every opening function in the 26 samples, as the fields of a position, and its type.
  it.each<[string[], string]>([
    [["Bundhængt SV"], "vindue-1-fag"],
    [["Drej Kip H.I."], "vindue-1-fag"],
    [["Drej Kip V.I."], "vindue-1-fag"],
    [["Fast karm"], "vindue-1-fag"],
    [["Sidehængt højre ud"], "vindue-1-fag"],
    [["Topstyret ud"], "vindue-1-fag"],
    [["Drej Kip V.I.", "Fast karm"], "vindue-2-fag"],
    [["Fast karm", "Drej Kip H.I.", "Fast karm"], "vindue-3-fag"],
    [["Sidehængt V.U. med anverfer", "Sidehængt H.U. med anverfer", "Sidehængt H.U. med anverfer"], "vindue-3-fag"],
    [["Fast karm", "Fast karm", "Fast karm", "Fast karm"], "vindue-3-fag"],
    [["Facadedør V.I. falle/rigle med alutrin"], "doer"],
    [["Fast karm", "Facadedør V.I. falle/rigle med alutrin", "Fast karm"], "doer"],
    [["Industri dør V.I. falle m/galv.trin"], "doer"],
    [["Industridør H.U. falle m/galv.trin"], "doer"],
    [["Industridør H.U. falle m/alu.trin"], "doer"],
    [["Industridør V.U. falle m/galv.trin"], "doer"],
    [["Industridør V.U. falle m/galv.trin", "Industridør stående"], "doer"],
    [["Industridør stående", "Industridør H.U. falle m/galv.trin"], "doer"],
    [["Terrassedør V.U. m/iso. trin"], "terrassedoer"],
    [["Terrassedør d/k H.I."], "terrassedoer"],
    [["Fast karm", "TERRASSEDØR d/k H.I."], "terrassedoer"],
    [[], "andet"],
  ])("%j is %s", (openings, type) => {
    expect(classifyElementType(position(1, openings))).toBe(type);
  });

  it("names every type the default rules can give, in Danish", () => {
    const ids = ELEMENT_TYPES.map((t) => t.id);
    for (const rule of DEFAULT_ELEMENT_TYPE_RULES) expect(ids).toContain(rule.type);
    expect(ids).toContain("andet");
    expect(elementTypeName("doer")).toBe("Dør");
    expect(elementTypeName("terrassedoer")).toBe("Terrassedør");
    expect(elementTypeName("vindue-2-fag")).toBe("Vindue 2 fag");
    expect(elementTypeName("skydedoer")).toBe("skydedoer");
  });

  it("takes rules as data: they survive JSON and can be replaced", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_ELEMENT_TYPE_RULES)) as ElementTypeRule[];
    expect(stored).toEqual(DEFAULT_ELEMENT_TYPE_RULES);
    expect(classifyElementType(position(1, ["Terrassedør d/k H.I."]), stored)).toBe("terrassedoer");

    const own: ElementTypeRule[] = [
      { type: "fast", anyOpeningContains: ["fast karm"], noOpeningContains: ["dør", "kip"], maxFields: 2 },
      { type: "oplukkeligt", minFields: 1 },
    ];
    expect(classifyElementType(position(1, ["Fast karm"]), own)).toBe("fast");
    expect(classifyElementType(position(1, ["Fast karm", "Drej Kip V.I."]), own)).toBe("oplukkeligt");
    expect(classifyElementType(position(1, ["Fast karm", "Fast karm", "Fast karm"]), own)).toBe("oplukkeligt");
    expect(classifyElementType(position(1, []), own)).toBe("andet");
    expect(classifyElementType(position(1, ["Fast karm"]), [])).toBe("andet");
  });

  it("passes over a rule that is not well formed", () => {
    const broken = [null, { anyOpeningContains: ["dør"] }, { type: "doer", anyOpeningContains: "dør" }, { type: "x", anyOpeningContains: [""] }];
    expect(classifyElementType(position(1, ["Facadedør"]), broken as unknown as ElementTypeRule[])).toBe("andet");
  });
});

describe("expectedElements", () => {
  it("lists a line per position and sums Antal", () => {
    const doc = document([
      position(1, ["Drej Kip V.I."], { quantity: 4 }),
      position(2, ["Industridør stående", "Industridør H.U. falle m/galv.trin"], { quantity: 50 }),
      position(4, ["Terrassedør d/k H.I."], { quantity: 1 }),
    ]);
    expect(expectedElements(doc)).toEqual({
      elements: [
        { position: 1, subNumber: null, label: "1", quantity: 4, type: "vindue-1-fag" },
        { position: 2, subNumber: null, label: "2", quantity: 50, type: "doer" },
        { position: 4, subNumber: null, label: "4", quantity: 1, type: "terrassedoer" },
      ],
      total: 55,
    });
  });

  it("has no total when it cannot be known", () => {
    expect(expectedElements(document([])).total).toBeNull();
    const doc = document([position(1, ["Fast karm"], { quantity: 2 }), position(2, ["Fast karm"], { quantity: null })]);
    expect(expectedElements(doc).total).toBeNull();
    expect(expectedElements(doc).elements).toHaveLength(2);
  });
});

// ----- Search chunks

describe("toSearchChunks", () => {
  const hardwareRow = (description: string, group = "Beskrivelse") => ({
    group,
    description,
    colour: null,
    quantity: "2",
    size: null,
    mounting: null,
    placement: null,
  });
  const window = position(1, [], {
    quantity: 4,
    frameHoles: "d=6,5 ve/hø",
    weightKg: 84.5,
    notes: ["Karm og ramme pakkes særskilt"],
    sizeWithoutCoupling: { width: 1485, height: 1380, text: "1485,0 * 1380,0" },
    fields: [
      field("1", "Drej Kip V.I.", {
        frameSize: "1415,0 * 1310,0",
        glassType: ["Energi ECLAZ 0,6 4-14-4-14-4 varm kant", "indv. 4 mm Energi ECLAZ"],
        panes: [{ quantity: 1, size: "1283 * 1178", sizeMm: { width: 1283, height: 1178 }, glassList: "107.208_G" }],
        seals: ["112.253"],
      }),
    ],
    fieldBars: [{ field: "1", description: "26 mm. ilagt", colour: "Hvid", side: "Lod.", length: "303,3" }],
    hardware: [hardwareRow("Dreje-kip greb")],
    accessories: [hardwareRow("Drænkappe fra Veka", "Tilbehør")],
    cutting: [
      {
        section: "Karm",
        profile: "101.282_G",
        width: null,
        quantity: 1,
        length: "1491,0",
        lengthMm: 1491,
        side: "Un",
        steel: "113.002",
        steelLength: "1390",
        field: null,
        clearance: null,
      },
    ],
  });
  const door = position(2, ["Terrassedør d/k H.I."], { system: "DANLINE" });
  const chunks = toSearchChunks(document([window, door]));

  it("gives each position its chunks, numbered from 0", () => {
    expect(chunks.map((c) => [c.position, c.chunkIndex])).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
    ]);
  });

  it("repeats the header facts and the position in every chunk, so a chunk stands alone", () => {
    for (const c of chunks) {
      expect(c.content).toContain("Ordre 58556");
      expect(c.content).toContain("Lev. uge 43");
      expect(c.content).toContain("Dato 01-10-2026");
      expect(c.content).toContain("Kunde: Test Kunde A/S, Prøvevej 1, 1234 Testby");
      expect(c.content).toContain("Lev. adr.: Byggeplads Øst, Æblevej 2");
      expect(c.content).toContain(`Position ${c.position}. `);
      expect(c.content).not.toMatch(/[\u2013\u2014]|undefined|null/);
    }
    expect(chunks[0].content).toContain("Position 1. Vindue 1 fag. System SOFTLINE. Antal 4");
    expect(chunks[3].content).toContain("Position 2. Terrassedør. System DANLINE. Antal 1");
  });

  it("holds the element, then hardware and accessories, then the cutting list", () => {
    const [element, hardware, cutting] = chunks.map((c) => c.content);
    expect(element).toContain("Farve karm: Hvid. Farve ramme: Hvid. Farve tætning: Grå");
    expect(element).toContain("Mål u/kobling: 1485,0 * 1380,0. Ca. 84,5 kg pr. element. Karmhuller: d=6,5 ve/hø");
    expect(element).toContain("Bemærkning: Karm og ramme pakkes særskilt");
    expect(element).toContain(
      "Felt 1: Drej Kip V.I.. Rammemål 1415,0 * 1310,0. Glastype: Energi ECLAZ 0,6 4-14-4-14-4 varm kant, indv. 4 mm Energi ECLAZ. 1 stk glasmål 1283 * 1178 glasliste 107.208_G. Tætning 112.253",
    );
    expect(element).toContain("Sprosse felt 1: 26 mm. ilagt Hvid Lod. 303,3");
    expect(element).not.toContain("Dreje-kip greb");
    expect(hardware).toContain("Beslag:\nDreje-kip greb, 2 stk\nTilbehør:\nDrænkappe fra Veka, 2 stk");
    expect(cutting).toContain("Afkortning:\nKarm 101.282_G 1 stk længde 1491,0 Un stål 113.002 1390");
  });

  it("cuts a long list into more chunks, between lines", () => {
    const many = position(3, ["Fast karm"], {
      hardware: Array.from({ length: 120 }, (_, i) => hardwareRow(`Getr. 15 Titan AF Gr. 120 TS 2RS 700 nr. ${i + 1}`)),
    });
    const parts = toSearchChunks(document([many]));
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.map((c) => c.chunkIndex)).toEqual(parts.map((_, i) => i));
    for (const c of parts) {
      expect(c.content.length).toBeLessThan(2000);
      expect(c.content).toContain("Position 3. Vindue 1 fag");
    }
    const all = parts.map((c) => c.content).join("\n");
    for (let i = 1; i <= 120; i++) expect(all).toContain(`nr. ${i}, 2 stk`);
  });

  it("gives nothing for a document without positions, and does not change its input", () => {
    expect(toSearchChunks(document([]))).toEqual([]);
    const doc = document([window, door]);
    const before = JSON.stringify(doc);
    toSearchChunks(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

// ----- Bytes that are no production list

describe("parseOrderDocument on bad input", () => {
  it("gives a problem, not an exception, for garbage", async () => {
    const doc = await parseOrderDocument(new TextEncoder().encode("not a pdf at all"), "x.pdf");
    expect(doc.positions).toEqual([]);
    expect(doc.problems.length).toBeGreaterThan(0);
    expect(doc.header.orderNumber).toBeNull();
    expect(doc).toMatchObject({ fileName: "x.pdf", pageCount: 0, parserVersion: PARSER_VERSION });

    expect((await parseOrderDocument(new Uint8Array())).problems.length).toBeGreaterThan(0);
    expect((await parseOrderDocument(new TextEncoder().encode("%PDF-1.4\n%%EOF\n"))).problems.length).toBeGreaterThan(0);
  });
});

// ----- Against the 26 real samples, when present
//
// The order PDFs are customer data and stay out of the repo. When the untracked folder orderdocs/
// is at the repo root (as on the developer's PC), these tests read it. Elsewhere they are skipped.
// Nothing here may name a customer, an address or a phone number.

const samplesFolder = fileURLToPath(new URL("../../../../orderdocs", import.meta.url));
const sampleFiles = existsSync(samplesFolder) ? readdirSync(samplesFolder).filter((f) => f.toLowerCase().endsWith(".pdf")) : [];

// Order: pages, positions, elements (the sum of Antal).
const SAMPLES: Record<number, [pages: number, positions: number, elements: number]> = {
  58721: [4, 2, 2],
  58731: [1, 1, 1],
  58763: [4, 2, 5],
  58782: [3, 3, 10],
  58786: [3, 3, 105],
  58792: [1, 1, 1],
  58794: [1, 1, 2],
  58797: [1, 1, 1],
  58799: [1, 1, 3],
  58800: [2, 1, 1],
  58801: [3, 3, 8],
  58802: [23, 19, 31],
  58803: [2, 1, 1],
  58804: [2, 2, 11],
  58805: [1, 1, 2],
  58807: [1, 1, 1],
  58808: [2, 2, 5],
  58810: [2, 1, 1],
  58813: [5, 3, 3],
  58814: [1, 1, 1],
  58815: [1, 1, 4],
  58820: [1, 1, 6],
  58822: [2, 1, 1],
  58823: [2, 1, 1],
  58826: [2, 1, 2],
  58829: [3, 2, 2],
};

describe.skipIf(sampleFiles.length === 0)("the real samples", () => {
  const parsed = new Map<number, Promise<OrderDocument>>();
  const sample = (order: number) => {
    let doc = parsed.get(order);
    if (!doc) {
      const file = sampleFiles.find((f) => parseOrderFileName(f)?.orderNumber === order);
      if (!file) throw new Error(`No sample for order ${order}`);
      doc = parseOrderDocument(new Uint8Array(readFileSync(join(samplesFolder, file))), file);
      parsed.set(order, doc);
    }
    return doc;
  };
  const orders = sampleFiles.map((f) => parseOrderFileName(f)?.orderNumber).filter((o): o is number => o !== undefined);

  it("parses every sample whole, with no problems", async () => {
    expect(orders).toHaveLength(sampleFiles.length);
    for (const order of orders) {
      const doc = await sample(order);
      expect(doc.problems, String(order)).toEqual([]);
      expect(doc.header.orderNumber).toBe(order);
      expect(doc.header.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.header.deliveryWeek).not.toBeNull();
      expect(doc.header.customer.length).toBeGreaterThan(0);
      expect(doc.positions.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

      let next = 0;
      for (const p of doc.positions) {
        expect(p.number).toBeGreaterThan(0);
        expect(p.pageIndex).toBe(next);
        next = p.pageIndex + p.pageCount;
        expect(p.system).not.toBeNull();
        expect(p.quantity).not.toBeNull();
        expect(p.fields.length).toBeGreaterThan(0);
        for (const f of p.fields) {
          expect(f.number).toMatch(/^\d+$/);
          expect(f.opening).not.toBeNull();
          expect(f.frameSizeMm === null).toBe(f.frameSize === null);
        }
        expect(p.sizeWithoutCoupling).not.toBeNull();
        expect(p.drawing).not.toBeNull();
        const d = p.drawing!;
        expect(d.left).toBeGreaterThanOrEqual(500);
        expect(d.left).toBeLessThanOrEqual(620);
        expect(d.right - d.left).toBeGreaterThanOrEqual(30);
        expect(d.right - d.left).toBeLessThanOrEqual(200);
        expect(d.top - d.bottom).toBeGreaterThanOrEqual(40);
        expect(d.top - d.bottom).toBeLessThanOrEqual(200);
        for (const c of p.cutting) {
          expect(c.profile).not.toBe("");
          expect(c.quantity).not.toBeNull();
          expect(c.length).not.toBeNull();
          expect(c.lengthMm).not.toBeNull();
        }
        for (const h of [...p.hardware, ...p.accessories]) {
          expect(h.description).not.toBe("");
          expect(h.quantity).not.toBeNull();
        }
      }
      expect(next).toBe(doc.pageCount);
    }
  });

  it("finds the pages, positions and elements of each order", async () => {
    for (const order of orders) {
      const known = SAMPLES[order];
      if (!known) continue;
      const doc = await sample(order);
      const expected = expectedElements(doc);
      expect([doc.pageCount, doc.positions.length, expected.total], String(order)).toEqual(known);
      expect(expected.elements.map((e) => e.position)).toEqual(doc.positions.map((p) => p.number));
    }
  });

  it("gives every position a type other than andet", async () => {
    const counts: Record<string, number> = {};
    for (const order of Object.keys(SAMPLES).map(Number)) {
      if (!orders.includes(order)) return;
      for (const e of expectedElements(await sample(order)).elements) counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    expect(counts).toEqual({ "vindue-1-fag": 29, "vindue-3-fag": 2, doer: 24, terrassedoer: 2 });
  });

  it("makes chunks for every position, each with the order and its position", async () => {
    for (const order of orders) {
      const doc = await sample(order);
      const chunks = toSearchChunks(doc);
      expect(new Set(chunks.map((c) => c.position))).toEqual(new Set(doc.positions.map((p) => p.number)));
      for (const c of chunks) {
        expect(c.content).toContain(`Ordre ${order}`);
        expect(c.content).toContain(`Position ${c.position}. `);
        expect(c.content.length).toBeLessThan(2600);
      }
    }
  });

  it("reads a window with its cutting list, hardware and accessories on the next page", async () => {
    if (!orders.includes(58721)) return;
    const doc = await sample(58721);
    expect(doc.header.deliveryWeek).toBe(46);
    expect(doc.header.date).toBe("2026-10-22");
    expect(doc.header.customer).toHaveLength(3);
    expect(doc.header.glassPallet).toBeNull();

    const p = positionFor(doc, 1)!;
    expect(p).toMatchObject({
      pageIndex: 0,
      pageCount: 2,
      system: "SOFTLINE",
      frameColour: "Hvid",
      sashColour: "Hvid",
      sealColour: "Grå",
      quantity: 1,
      frameHoles: "d=6,5 ve/hø",
      scale: "1:50",
      weightKg: 84.5,
      sizeWithoutCoupling: { width: 1485, height: 1380, text: "1485,0 * 1380,0" },
    });
    expect(p.fields).toEqual([
      {
        number: "1",
        opening: "Drej Kip V.I.",
        frameSize: "1415,0 * 1310,0",
        frameSizeMm: { width: 1415, height: 1310 },
        glassType: ["Energi ECLAZ 0,6 4-14-4-14-4 varm kant", "indv. 4 mm Energi ECLAZ", "midt. 4 mm Energi ECLAZ", "udv. 4 mm glas"],
        panes: [{ quantity: 1, size: "1283 * 1178", sizeMm: { width: 1283, height: 1178 }, glassList: "107.208_G" }],
        seals: [],
      },
    ]);
    expect(p.cutting).toHaveLength(8);
    expect(p.cutting[0]).toMatchObject({ section: "Karm", profile: "101.282_G", quantity: 1, length: "1491,0", side: "Un", steel: "113.002", steelLength: "1390", field: null });
    expect(p.cutting[7]).toMatchObject({ section: "Ramme", profile: "103.232 Z_G", length: "1316,0", side: "Hø", steel: "113.292", steelLength: "1150", field: "1" });
    expect(p.hardware).toHaveLength(11);
    expect(p.hardware[9]).toMatchObject({ group: "Beskrivelse", description: "Getr. 15 Titan AF Gr. 120 TS 2RS 700 TGMK4160", colour: null, quantity: "1" });
    expect(p.accessories.map((a) => a.description)).toEqual(["Drænkappe fra Veka", "Dreje-kip greb", "Skrue 5x45 mm"]);

    const two = positionForBarcode(doc, "058721020201")!;
    expect([two.number, two.pageIndex, two.pageCount]).toEqual([2, 2, 2]);
    expect(two.accessories).toContainEqual(expect.objectContaining({ description: "Vandnæse", quantity: "1", size: "800,0" }));
    expect(positionForBarcode(doc, "058721010103")?.number).toBe(1);
    expect(positionForBarcode(doc, "058721090101")).toBeNull();
  });

  it("reads a double door with two panes per field and glazing bars", async () => {
    if (!orders.includes(58802)) return;
    const p = positionFor(await sample(58802), 18)!;
    expect(p.fields.map((f) => f.opening)).toEqual(["Industridør stående", "Industridør H.U. falle m/galv.trin"]);
    for (const f of p.fields) {
      expect(f.panes.map((g) => [g.quantity, g.size, g.glassList])).toEqual([
        [1, "675 * 952", "107.214_G"],
        [1, "675 * 952", "107.214_G"],
      ]);
      expect(f.seals).toEqual(["112.253"]);
      expect(f.glassType).toContain("Fyldning 23 mm, Hvid");
    }
    expect(p.cutting).toContainEqual(expect.objectContaining({ section: "Karm", profile: "galv.20x50", quantity: 1, length: "1704,0", side: "Un", steel: null }));
    expect(p.cutting.some((c) => c.steel === "**113.368.2" && c.field === "2")).toBe(true);
    expect(p.cutting.filter((c) => c.section === "Sprosse" && c.width === "85,0" && c.side === "Van." && c.clearance === "924,0")).toHaveLength(2);
    expect(p.hardware[0]).toMatchObject({ description: "Haps hængsel P100 Hvid", colour: "Hvid", quantity: "6" });
    expect(p.pageCount).toBe(2);
    expect(classifyElementType(p)).toBe("doer");
  });

  it("reads three fields in one frame, overprinted text and tables that go on over a page", async () => {
    if (![58813, 58826, 58800].every((o) => orders.includes(o))) return;
    const three = positionFor(await sample(58813), 1)!;
    expect(three.fields.map((f) => f.opening)).toEqual(["Fast karm", "Drej Kip H.I.", "Fast karm"]);
    expect(three.fields[0].frameSize).toBeNull();
    expect(three.fields[1].frameSize).toBe("828,7 * 1390,0");
    expect(three.sizeWithoutCoupling?.width).toBe(2610);
    expect(classifyElementType(three)).toBe("vindue-3-fag");

    const sw = positionFor(await sample(58826), 1)!;
    expect(sw.fields.map((f) => f.opening)).toEqual(["Sidehængt V.U. med anverfer", "Sidehængt H.U. med anverfer", "Sidehængt H.U. med anverfer"]);
    expect(sw.hardware).toContainEqual(expect.objectContaining({ description: "Anverfer m/pladeøsken IPA 2139610212", colour: "Eloxeret" }));
    expect(sw.cutting.filter((c) => c.section === "Sprosse" && c.profile === "109.590.2 2s sw" && c.width === "25,0")).toHaveLength(6);

    const add = positionFor(await sample(58800), 1)!;
    const profiles = add.accessories.filter((a) => a.group === "Tilsætningsprofil");
    expect(profiles).toHaveLength(4);
    expect(profiles[0]).toEqual({ group: "Tilsætningsprofil", description: "8 mm notl. vand", colour: "Hvid", quantity: "1", size: "1244,0", mounting: "Monteret", placement: "nederst" });
  });

  it("reads glazing bars, notes and gaps in the position numbers", async () => {
    if (![58815, 58829, 58763].every((o) => orders.includes(o))) return;
    expect(positionFor(await sample(58815), 1)!.fieldBars[0]).toEqual({ field: "1", description: "26 mm. ilagt", colour: "Hvid", side: "Lod.", length: "303,3" });

    const doc = await sample(58829);
    expect(doc.positions.map((p) => p.number)).toEqual([3, 5]);
    expect(positionFor(doc, 3)!.notes).toEqual(["Tilbudt med 55 mm påklæbet sprosse", "lodret udv. & indv."]);
    expect(positionFor(doc, 4)).toBeNull();

    expect(positionFor(await sample(58763), 1)!.notes).toContain("Som type G m/alm FD greb og med åbningsbegrænser");
  });
});
