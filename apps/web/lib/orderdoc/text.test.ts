import { describe, expect, it } from "vitest";
import { type OpGlyph, readOperators } from "./pdf";
import { run, runUp } from "./test-support";
import { cellsFromWords, dedupeGlyphs, glyphBox, groupLines, isHorizontal, linesFromGlyphs, wordsFromGlyphs } from "./text";

const texts = (glyphs: ReturnType<typeof run>) => wordsFromGlyphs(dedupeGlyphs(glyphs)).map((w) => w.text);

describe("words from glyphs", () => {
  it("splits at spaces and keeps where each word starts and ends", () => {
    const words = wordsFromGlyphs(run("Drej Kip V.I.", 222.6, 417));
    expect(words.map((w) => w.text)).toEqual(["Drej", "Kip", "V.I."]);
    expect(words[0].left).toBeCloseTo(222.6);
    expect(words[0].right).toBeCloseTo(222.6 + 4 * 4.85);
    expect(words[1].left).toBeCloseTo(222.6 + 4 * 4.85 + 2.425);
    expect(words.every((w) => w.bottom === 417 && !w.bold)).toBe(true);
  });

  it("reads bold text drawn twice on the same spot once", () => {
    const twice = [...run("46", 91, 507.3, { bold: true }), ...run("46", 91, 507.3, { bold: true })];
    expect(texts(twice)).toEqual(["46"]);
    // Read naively, sorted by x, it would be "4466".
    expect(
      [...twice]
        .sort((a, b) => a.x - b.x)
        .map((g) => g.text)
        .join(""),
    ).toBe("4466");

    const word = [...run("Terrassedør", 222.6, 417, { bold: true }), ...run("Terrassedør", 222.6, 417, { bold: true })];
    expect(texts(word)).toEqual(["Terrassedør"]);
  });

  it("drops a second draw that is a hair off, and keeps the same letter elsewhere", () => {
    const off = [...run("Karm", 32, 254.65, { bold: true }), ...run("Karm", 32.02, 254.66, { bold: true })];
    expect(texts(off)).toEqual(["Karm"]);
    expect(texts([...run("2", 145.7, 243), ...run("2", 145.7, 232)])).toEqual(["2", "2"]);
  });

  it("keeps the rest when a word is drawn first and then the whole text over it", () => {
    const glyphs = [...run("Sidehængt", 222.6, 417, { font: "narrow" }), ...run("Sidehængt V.U. med anverfer", 222.6, 417, { font: "narrow" })];
    const lines = linesFromGlyphs(glyphs);
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map((w) => w.text)).toEqual(["Sidehængt", "V.U.", "med", "anverfer"]);
  });

  it("does not mix two texts printed over each other", () => {
    // A long description runs on into the colour column, and the colour is drawn after it.
    const description = run("Anverfer m/pladeøsken IPA 2139610212", 32, 162.8);
    const colour = run("Eloxeret", 187.6, 162.8);
    expect(description[description.length - 1].endX).toBeGreaterThan(187.6);

    const words = wordsFromGlyphs([...description, ...colour]);
    expect(words.map((w) => w.text)).toEqual(["Anverfer", "m/pladeøsken", "IPA", "2139610212", "Eloxeret"]);

    const cells = cellsFromWords(words);
    expect(cells.map((c) => c.text)).toEqual(["Anverfer m/pladeøsken IPA 2139610212", "Eloxeret"]);
    expect(cells[1].left).toBeCloseTo(187.6);
  });

  it("ends a word at a jump, a new line or another font", () => {
    expect(texts([...run("1", 145.7, 243), ...run("1554,0", 188.3, 243)])).toEqual(["1", "1554,0"]);
    expect(texts([...run("Hvid", 32, 100), ...run("Hvid", 32, 88.5)])).toEqual(["Hvid", "Hvid"]);
    const label = run("Position:", 34.2, 423);
    const end = label[label.length - 1].endX;
    const words = wordsFromGlyphs([...label, ...run("5", end, 423, { bold: true })]);
    expect(words.map((w) => [w.text, w.bold])).toEqual([
      ["Position:", false],
      ["5", true],
    ]);
  });

  it("leaves turned text out of the words and gives it a box", () => {
    const turned = runUp("1423,0", 674.6, 224.8);
    expect(turned.every((g) => !isHorizontal(g))).toBe(true);
    expect(linesFromGlyphs([...turned, ...run("1.0", 584.5, 235.2)]).flatMap((l) => l.words.map((w) => w.text))).toEqual(["1.0"]);
    const box = glyphBox(turned[0]);
    expect(box.right).toBeCloseTo(674.6);
    expect(box.left).toBeLessThan(674.6 - 5);
    expect([box.bottom, box.top]).toEqual([224.8, 224.8 + 4.5]);
  });
});

describe("lines and cells", () => {
  it("groups words within 1.6 pt into a line, top to bottom, left to right", () => {
    const words = wordsFromGlyphs([
      ...run("1260", 372.2, 153.4),
      ...run("Ramme", 32, 187.2, { bold: true }),
      ...run("25,0", 97, 154.1, { size: 9 }),
      ...run("103.325", 32, 153.4),
    ]);
    const lines = groupLines(words);
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([["Ramme"], ["103.325", "25,0", "1260"]]);
    expect(lines[1].y).toBeCloseTo(154.1);
  });

  it("starts a new cell at a gap wider than 5 pt", () => {
    const words = wordsFromGlyphs([...run("8 mm notl. vand", 32, 100), ...run("Hvid", 188, 100), ...run("1", 245, 100)]);
    expect(cellsFromWords(words)).toMatchObject([{ text: "8 mm notl. vand", left: 32 }, { text: "Hvid" }, { text: "1" }]);
  });
});

describe("reading an operator list", () => {
  const ops = {
    save: 1,
    restore: 2,
    transform: 3,
    beginText: 4,
    setFont: 5,
    moveText: 6,
    setTextRise: 7,
    showText: 8,
    endText: 9,
    setTextMatrix: 10,
    constructPath: 11,
    stroke: 12,
    fill: 13,
    paintImageXObject: 14,
    setCharSpacing: 15,
  };
  const glyph = (unicode: string, width: number): OpGlyph => ({ unicode, width, isSpace: unicode === " " });
  const read = (list: [number, unknown[]][]) =>
    readOperators({
      fnArray: list.map((o) => o[0]),
      argsArray: list.map((o) => o[1]),
      ops,
      font: (id) => ({ bold: id === "f1", fontMatrix: [0.001, 0, 0, 0.001, 0, 0] }),
    });

  it("places each glyph from the text state: move, rise, widths, kerning and spacing", () => {
    const { glyphs } = read([
      [ops.setFont, ["f1", 10]],
      [ops.beginText, []],
      [ops.moveText, [100, 549.83]],
      [ops.setTextRise, [-9.7]],
      [ops.showText, [[glyph("A", 600), glyph("B", 500), -200, glyph("C", 500)]]],
      [ops.setCharSpacing, [1]],
      [ops.showText, [[glyph("D", 500), glyph("E", 500)]]],
      [ops.endText, []],
      [ops.beginText, []],
      [ops.setTextMatrix, [[0, 1, -1, 0, 300, 50]]],
      [ops.showText, [[glyph("7", 500)]]],
    ]);
    expect(glyphs.map((g) => g.text).join("")).toBe("ABCDE7");
    expect(glyphs[0]).toMatchObject({ x: 100, endX: 106, font: "f1", bold: true, size: 10 });
    expect(glyphs[0].y).toBeCloseTo(540.13);
    expect(glyphs[1].x).toBeCloseTo(106);
    // A kerning number moves back by thousandths of the font size.
    expect(glyphs[2].x).toBeCloseTo(113);
    expect(glyphs[3].x).toBeCloseTo(118);
    // Character spacing moves the next glyph on, but is not part of a glyph's own width.
    expect(glyphs[3].endX).toBeCloseTo(123);
    expect(glyphs[4].x).toBeCloseTo(124);
    // A turned text matrix: the baseline runs up the page.
    expect(glyphs[5].x).toBeCloseTo(300 + 9.7);
    expect(glyphs[5].endY - glyphs[5].y).toBeCloseTo(5);
    expect(isHorizontal(glyphs[5])).toBe(false);
  });

  it("gives stroked paths and images their box on the page, and skips filled paths", () => {
    const { strokes, images } = read([
      [ops.constructPath, [ops.stroke, [null], [578, 200.85, 662, 278.6]]],
      [ops.constructPath, [ops.fill, [null], [10, 10, 20, 20]]],
      [ops.save, []],
      [ops.transform, [70, 0, 0, -76, 593, 263]],
      [ops.paintImageXObject, ["img", 588, 641]],
      [ops.restore, []],
      [ops.constructPath, [ops.stroke, [null], [1, 2, 3, 4]]],
    ]);
    expect(strokes).toEqual([
      { left: 578, bottom: 200.85, right: 662, top: 278.6 },
      { left: 1, bottom: 2, right: 3, top: 4 },
    ]);
    expect(images).toEqual([{ left: 593, bottom: 187, right: 663, top: 263 }]);
  });
});
