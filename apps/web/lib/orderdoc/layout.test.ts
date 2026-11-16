import { describe, expect, it } from "vitest";
import { type PageInput, parseDecimal, parseLeadingInt, parseSize, readPages } from "./layout";
import { type RunOptions, run, runUp } from "./test-support";
import type { Glyph } from "./text";

// Two pages laid out like the real thing, with made-up content: a door position on the first, its
// accessories going on on the second. Bold text is drawn twice, as 3E does.
function syntheticProductionList(): PageInput[] {
  const page = (index: number, side: number): { input: PageInput; t: (s: string, x: number, y: number, o?: RunOptions) => void } => {
    const glyphs: Glyph[] = [];
    const t = (s: string, x: number, y: number, o: RunOptions = {}) => {
      glyphs.push(...run(s, x, y, o));
      if (o.bold) glyphs.push(...run(s, x, y, o));
    };
    const bold = { bold: true };
    t("Produktionsliste", 42.5, 534.3, { bold: true, size: 15.6 });
    t("Kunde:", 183.7, 540.1);
    t("Test Kunde A/S", 226.4, 540.1);
    t("Lev. adr.:", 395.4, 540.1);
    t("Byggeplads Øst", 452.2, 540.1);
    t("Side:", 650.3, 540.1);
    t(String(side), 706.3, 540.1);
    t("Glas lev.:", 650.3, 535.6, bold);
    t("Prøvevej 1", 226.4, 528.9);
    t("Æblevej 2", 452.2, 528.9);
    t("Ordrer nr.:", 42.5, 520.6);
    t("58556", 91, 520.6, bold);
    t("Glas palle:", 650.3, 521.4, bold);
    t("_____", 706.3, 521.4);
    t("1234 Testby", 226.4, 517.7);
    t("Lev. uge:", 42.5, 507.3);
    t("43", 91, 507.3, bold);
    t("Dato:", 42.5, 493.8);
    t("01-10-2026", 91, 493.8);
    t("Sagsbeh.:", 42.5, 480.5);
    t("A. Person", 91, 480.5);
    t("Pakke info.:", 395.4, 480.5);
    t("_".repeat(144), 39.5, 467.1);
    t(".", 284, 455.8);
    return { input: { index, width: 839, height: 592, glyphs, strokes: [], images: [] }, t };
  };
  const bold = { bold: true };
  const narrow = { font: "narrow" };

  const { input: p1, t } = page(0, 1);
  t("System", 34.2, 443.8);
  t("70 mm Industri", 99.2, 442.3, bold);
  t("Felt oplysninger", 198.7, 443.1, bold);
  t("Felt", 198.7, 429.7, bold);
  t("Åbningsfunktion", 222.6, 429.7, bold);
  t("Rammemål", 364.6, 430.3, bold);
  t("Glastype", 439.3, 429.7, bold);
  t("Stk", 593.4, 429.7, bold);
  t("Glasmål", 627.8, 429.7, bold);
  t("Glasliste", 701.2, 429.7, bold);
  t("Tætning", 756.4, 429.7, bold);
  t("Position:", 34.2, 423.0);
  t("5", 99.2, 423.0, bold);
  // Field 1: a door with glass above a panel. Its second Glasliste sits lower than its Glasmål.
  t("1", 201.4, 417.0);
  t("Industridør H.U. falle", 222.6, 417.0, narrow);
  t("900,0 * 2000,0", 364.6, 417.0);
  t("Energi 4-16-4", 439.3, 417.0, narrow);
  t("1", 593.4, 417.0);
  t("675 * 952", 627.8, 417.0);
  t("107.214_G", 696.5, 417.0);
  t("112.253", 756.4, 417.0);
  t("Farve karm:", 34.2, 408.8);
  t("Hvid", 99.2, 408.8, bold);
  t("m/galv.trin", 222.6, 405.5, narrow);
  t("indv. 4 mm glas", 439.3, 405.5, narrow);
  t("1", 593.4, 405.5);
  t("675 * 800", 627.8, 405.5);
  t("Farve ramme:", 34.2, 395.3);
  t("Lightgrau/hvid", 99.2, 395.3, bold);
  t("Fyldning 23 mm, Hvid", 439.3, 394.0, narrow);
  t("Farve tætning:", 34.2, 382.0);
  t("Grå", 99.2, 382.0, bold);
  t("107.208_G", 696.5, 376.0);
  // Field 2: fixed, so no Rammemål.
  t("2", 201.4, 369.8);
  t("Fast karm", 222.6, 369.8, narrow);
  t("Ingen glas", 439.3, 369.8, narrow);
  t("Antal:", 34.2, 364.9);
  t("12", 99.2, 364.9, bold);
  t("Karmhuller:", 34.2, 346.2);
  t("d=6,5 ve/hø", 99.2, 346.2, bold);
  // A bold note that runs on into the Felt column.
  t("Karm og ramme pakkes særskilt, husk", 34.2, 333.0, bold);
  t("Løs karm", 34.2, 326.0, bold);
  t("1:50", 582.4, 321.7, bold);
  t("Ca. 84,5 kg pr.element", 636.8, 321.7);
  t("-".repeat(96), 28.2, 320.3);
  t("Afkortning", 32, 309.9, bold);
  t("Stk.:", 136.7, 309.9, bold);
  t("Længde:", 180.7, 309.9, bold);
  t("Stål:", 317.6, 309.9, bold);
  t("Længde: Felt nr.: Lysm. T/V", 366.1, 310.7, bold);
  t("Mål u/kobling: 1183,0 * 2139,0", 593.4, 305.9, { bold: true, size: 11.3 });
  t("Karm", 32, 296.3, bold);
  t("101.282_G", 32, 284.8);
  t("2", 145.7, 284.8);
  t("1189,0", 188.3, 284.8);
  t("Un", 230.2, 284.8);
  t("113.002", 316.2, 284.8);
  t("1090", 372.2, 284.8);
  t("galv.20x50", 32, 273.7);
  t("1", 145.7, 273.7);
  t("1704,0", 188.3, 273.7);
  t("Un", 230.2, 273.7);
  t("Ramme", 32, 262.0, bold);
  t("103.232 Z_G", 32, 250.4);
  t("2", 145.7, 250.4);
  t("1106,0", 188.3, 250.4);
  t("Ov", 230.9, 250.4);
  t("**113.368.2", 311.0, 250.4);
  t("950", 372.2, 250.4);
  t("1", 426.8, 250.4);
  t("Sprosse", 32, 238.5, bold);
  t("Bredde", 97, 238.5, bold);
  t("109.590.2 2s", 32, 227.0);
  t("85,0", 97, 227.7, { size: 9 });
  t("2", 145.7, 227.0);
  t("344,7", 188.3, 227.0);
  t("Van.", 230.9, 227.0);
  t("1", 426.8, 227.0);
  t("924,0", 455.0, 227.0);
  t("Felt", 32, 212.0, bold);
  t("Beskrivelse", 60, 212.0, bold);
  t("Farve", 163, 212.0, bold);
  t("1", 34, 200.5);
  t("26 mm. ilagt", 60, 200.5);
  t("Hvid", 163, 200.5);
  t("Lod.", 230, 200.5);
  t("303,3", 290, 200.5);
  t("-".repeat(96), 28.2, 188.0);
  t("Beskrivelse", 32, 174.3, bold);
  t("Farve", 187.6, 174.3, bold);
  t("Antal", 257.8, 174.3, bold);
  t("Mål", 300, 174.3, bold);
  t("Mont./Løs", 357, 174.3, bold);
  t("Placering", 427.6, 174.3, bold);
  t("Haps hængsel P100 Hvid", 32, 162.8);
  t("Hvid", 187.6, 162.8);
  t("6", 257.8, 162.8);
  // A description so long that its colour is printed on top of its end.
  t("Anverfer m/pladeøsken IPA 2139610212", 32, 151.3);
  t("Eloxeret", 187.6, 151.3);
  t("2", 257.8, 151.3);
  t("Tilbehør", 32, 38.8, bold);
  // The drawing: a frame and a sash, the width below it and the height turned beside it.
  p1.strokes.push({ left: 578, bottom: 200.8, right: 658, top: 278.8 }, { left: 584.6, bottom: 207.3, right: 651.6, top: 272.3 });
  p1.images.push({ left: 590, bottom: 210, right: 640, top: 270 });
  t("1183,0", 605, 186.9, { size: 9 });
  p1.glyphs.push(...runUp("2139,0", 674.6, 224.8));

  const { input: p2, t: u } = page(1, 2);
  u("Skrue 5x45 mm", 32, 433.3);
  u("40", 245, 433.3);
  u("Tilsætningsprofil", 32, 420.0, bold);
  u("8 mm notl. vand", 32, 408.5);
  u("Hvid", 188, 408.5);
  u("1", 245, 408.5);
  u("1244,0", 287, 408.5);
  u("Monteret", 344, 408.5);
  u("nederst", 413, 408.5);
  return [p1, p2];
}

describe("readPages on a synthetic production list", () => {
  const problems: string[] = [];
  const { header, positions } = readPages(syntheticProductionList(), problems);
  const p = positions[0];

  it("reads the header", () => {
    expect(problems).toEqual([]);
    expect(header).toEqual({
      orderNumber: 58556,
      customer: ["Test Kunde A/S", "Prøvevej 1", "1234 Testby"],
      deliveryAddress: ["Byggeplads Øst", "Æblevej 2"],
      deliveryWeek: 43,
      date: "2026-10-01",
      caseHandler: "A. Person",
      packageInfo: null,
      glassDelivery: null,
      glassPallet: null,
    });
  });

  it("reads the left column, the notes, scale, weight and size", () => {
    expect(positions).toHaveLength(1);
    expect(p).toMatchObject({
      label: "5",
      number: 5,
      subNumber: null,
      system: "70 mm Industri",
      frameColour: "Hvid",
      sashColour: "Lightgrau/hvid",
      sealColour: "Grå",
      quantity: 12,
      frameHoles: "d=6,5 ve/hø",
      notes: ["Karm og ramme pakkes særskilt, husk", "Løs karm"],
      scale: "1:50",
      weightKg: 84.5,
      sizeWithoutCoupling: { width: 1183, height: 2139, text: "1183,0 * 2139,0" },
      pageIndex: 0,
      pageCount: 2,
    });
  });

  it("reads the fields, pairing a door's second Glasliste with its second pane", () => {
    expect(p.fields).toEqual([
      {
        number: "1",
        opening: "Industridør H.U. falle m/galv.trin",
        frameSize: "900,0 * 2000,0",
        frameSizeMm: { width: 900, height: 2000 },
        glassType: ["Energi 4-16-4", "indv. 4 mm glas", "Fyldning 23 mm, Hvid"],
        panes: [
          { quantity: 1, size: "675 * 952", sizeMm: { width: 675, height: 952 }, glassList: "107.214_G" },
          { quantity: 1, size: "675 * 800", sizeMm: { width: 675, height: 800 }, glassList: "107.208_G" },
        ],
        seals: ["112.253"],
      },
      { number: "2", opening: "Fast karm", frameSize: null, frameSizeMm: null, glassType: ["Ingen glas"], panes: [], seals: [] },
    ]);
  });

  it("reads the cutting list with its sections and the width column of Sprosse", () => {
    const row = { width: null, side: null, steel: null, steelLength: null, field: null, clearance: null };
    expect(p.cutting).toEqual([
      { ...row, section: "Karm", profile: "101.282_G", quantity: 2, length: "1189,0", lengthMm: 1189, side: "Un", steel: "113.002", steelLength: "1090" },
      { ...row, section: "Karm", profile: "galv.20x50", quantity: 1, length: "1704,0", lengthMm: 1704, side: "Un" },
      { ...row, section: "Ramme", profile: "103.232 Z_G", quantity: 2, length: "1106,0", lengthMm: 1106, side: "Ov", steel: "**113.368.2", steelLength: "950", field: "1" },
      { ...row, section: "Sprosse", profile: "109.590.2 2s", width: "85,0", quantity: 2, length: "344,7", lengthMm: 344.7, side: "Van.", field: "1", clearance: "924,0" },
    ]);
    expect(p.fieldBars).toEqual([{ field: "1", description: "26 mm. ilagt", colour: "Hvid", side: "Lod.", length: "303,3" }]);
  });

  it("reads hardware, also where a description is printed over its colour", () => {
    const row = { group: "Beskrivelse", colour: null, quantity: null, size: null, mounting: null, placement: null };
    expect(p.hardware).toEqual([
      { ...row, description: "Haps hængsel P100 Hvid", colour: "Hvid", quantity: "6" },
      { ...row, description: "Anverfer m/pladeøsken IPA 2139610212", colour: "Eloxeret", quantity: "2" },
    ]);
  });

  it("goes on with the accessories on the next page, and takes a new heading as its own group", () => {
    expect(p.accessories).toEqual([
      { group: "Tilbehør", description: "Skrue 5x45 mm", colour: null, quantity: "40", size: null, mounting: null, placement: null },
      { group: "Tilsætningsprofil", description: "8 mm notl. vand", colour: "Hvid", quantity: "1", size: "1244,0", mounting: "Monteret", placement: "nederst" },
    ]);
  });

  it("boxes the drawing: lines, image, the width below and the turned height", () => {
    const d = p.drawing!;
    expect(d.left).toBeCloseTo(575);
    expect(d.top).toBeCloseTo(281.8);
    expect(d.bottom).toBeCloseTo(183.9);
    expect(d.right).toBeGreaterThan(674.6);
    expect(d.right).toBeLessThan(690);
    expect([d.pageWidth, d.pageHeight]).toEqual([839, 592]);
  });
});

describe("readPages on other input", () => {
  it("gives an empty model for pages of another kind", () => {
    const problems: string[] = [];
    const letter: PageInput = { index: 0, width: 595, height: 842, glyphs: run("Bare et brev", 50, 700), strokes: [], images: [] };
    const { header, positions } = readPages([letter], problems);
    expect(positions).toEqual([]);
    expect(header.orderNumber).toBeNull();
    expect(problems).toEqual(["Header: no order number", "No positions found"]);
  });

  it("counts a page that could not be read to the position before it", () => {
    const [first, second] = syntheticProductionList();
    const problems: string[] = [];
    const { positions } = readPages([first, null, { ...second, index: 2 }], problems);
    expect(positions).toHaveLength(1);
    expect(positions[0].pageCount).toBe(3);
    expect(positions[0].accessories).toHaveLength(2);
  });

  it("keeps a printed sub-position", () => {
    const [first] = syntheticProductionList();
    const at = first.glyphs.findIndex((g) => g.text === "5" && g.x === 99.2 && g.y === 423.0);
    const glyphs = [...first.glyphs.slice(0, at), ...run("5.1", 99.2, 423.0, { bold: true }), ...first.glyphs.slice(at + 2)];
    const { positions } = readPages([{ ...first, glyphs }], []);
    expect(positions[0]).toMatchObject({ label: "5.1", number: 5, subNumber: 1 });
  });
});

describe("numbers as printed", () => {
  it("reads Danish decimals", () => {
    expect(parseDecimal("84,5")).toBe(84.5);
    expect(parseDecimal("1.485,0")).toBe(1485);
    expect(parseDecimal("1390")).toBe(1390);
    expect(parseDecimal("kg")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });

  it("reads a leading whole number and a size", () => {
    expect(parseLeadingInt("12 stk")).toBe(12);
    expect(parseLeadingInt("stk")).toBeNull();
    expect(parseSize("1415,0 * 1310,0")).toEqual({ width: 1415, height: 1310 });
    expect(parseSize("Ingen")).toBeNull();
    expect(parseSize(null)).toBeNull();
  });
});
