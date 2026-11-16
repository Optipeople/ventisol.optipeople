// Reads the pages of a "Produktionsliste" into an OrderDocument (layout: docs/order-documents.md).
// The PDF is text and vector lines, no form fields, so everything is found by position: labels and
// table heads are looked up by their text, and values by where they sit relative to them.
// A port of the station app's OrderDocumentParser.cs: keep the two in step. Pure: pages in, model out.

import {
  type Box,
  type Cell,
  type Glyph,
  type Line,
  type Word,
  byLeft,
  cellsFromWords,
  dedupeGlyphs,
  glyphBox,
  groupLines,
  isHorizontal,
  isRule,
  joinCells,
  joinWords,
  wordsFromGlyphs,
} from "./text";
import type {
  CutRow,
  ElementSize,
  FieldBarRow,
  GlassPane,
  HardwareRow,
  OrderDocumentHeader,
  OrderField,
  OrderPosition,
  PdfBox,
  SizeMm,
} from "./types";

/** What the parser needs of one page: its glyphs in drawing order, and the boxes of its stroked paths and images. */
export interface PageInput {
  /** 0-based. */
  index: number;
  width: number;
  height: number;
  glyphs: Glyph[];
  strokes: Box[];
  images: Box[];
}

interface PageText {
  index: number;
  width: number;
  height: number;
  headerRuleY: number;
  lines: Line[];
  body: Line[];
  strokes: Box[];
  images: Box[];
  rotated: Box[];
}

interface Found {
  line: Line;
  first: Word;
  last: Word;
}

export const EMPTY_HEADER: OrderDocumentHeader = {
  orderNumber: null,
  customer: [],
  deliveryAddress: [],
  deliveryWeek: null,
  date: null,
  caseHandler: null,
  packageInfo: null,
  glassDelivery: null,
  glassPallet: null,
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Header and positions of a document. A null page is one that could not be read. */
export function readPages(
  inputs: readonly (PageInput | null)[],
  problems: string[],
): { header: OrderDocumentHeader; positions: OrderPosition[] } {
  const pages: (PageText | null)[] = inputs.map((p, i) => {
    if (!p) return null;
    try {
      return readPageText(p);
    } catch (e) {
      problems.push(`Page ${i + 1}: could not be read (${message(e)})`);
      return null;
    }
  });

  let header: OrderDocumentHeader = { ...EMPTY_HEADER };
  try {
    header = readHeader(pages, problems);
  } catch (e) {
    problems.push(`Header: ${message(e)}`);
  }

  let positions: OrderPosition[] = [];
  try {
    positions = readPositions(pages, problems);
  } catch (e) {
    problems.push(`Positions: ${message(e)}`);
  }

  if (positions.length === 0) problems.push("No positions found");
  return { header, positions };
}

// ----- Text on a page

function readPageText(page: PageInput): PageText {
  const glyphs = dedupeGlyphs(page.glyphs);
  const lines = groupLines(wordsFromGlyphs(glyphs.filter(isHorizontal)));
  const rule = lines.flatMap((l) => l.words).find((w) => isRule(w, "_") && w.text.length >= 40 && w.left < 120);
  const caseLine = lines.find((l) => has(l, "Sagsbeh.:"));
  const headerRuleY = rule ? rule.bottom : caseLine ? caseLine.y - 5 : page.height * 0.78;
  return {
    index: page.index,
    width: page.width,
    height: page.height,
    headerRuleY,
    lines,
    body: lines.filter((l) => l.y < headerRuleY - 1),
    strokes: page.strokes,
    images: page.images,
    rotated: glyphs.filter((g) => !isHorizontal(g) && g.text.trim().length > 0).map(glyphBox),
  };
}

const has = (line: Line, text: string) => line.words.some((w) => w.text === text);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function find(lines: readonly Line[], ...texts: string[]): Found | null {
  for (const line of lines)
    for (let i = 0; i + texts.length <= line.words.length; i++) {
      let match = true;
      for (let j = 0; j < texts.length && match; j++) match = same(line.words[i + j].text, texts[j]);
      if (match) return { line, first: line.words[i], last: line.words[i + texts.length - 1] };
    }
  return null;
}

// The words after a label on its line, up to stopAt (an x) when given.
function valueAfter(lines: readonly Line[], label: string[], stopAt?: number | null): string | null {
  const f = find(lines, ...label);
  if (!f) return null;
  return nullIfEmpty(joinWords(f.line.words.filter((w) => w.left > f.last.left && (stopAt == null || w.left < stopAt - 1))));
}

// ----- Header

function readHeader(pages: readonly (PageText | null)[], problems: string[]): OrderDocumentHeader {
  const page = pages.find((p) => p !== null && find(p.lines, "Ordrer", "nr.:") !== null) ?? pages.find((p) => p !== null);
  if (!page) return { ...EMPTY_HEADER };

  const top = page.lines.filter((l) => l.y > page.headerRuleY);
  const orderText = valueAfter(top, ["Ordrer", "nr.:"]);
  const orderNumber = orderText === null ? null : parseLeadingInt(orderText);
  if (orderNumber === null) problems.push("Header: no order number");

  const weekText = valueAfter(top, ["Lev.", "uge:"]);
  const dateText = valueAfter(top, ["Dato:"]);

  const side = find(top, "Side:");
  const pakke = find(top, "Pakke", "info.:");
  const caseHandler = valueAfter(top, ["Sagsbeh.:"], pakke?.first.left);
  const packageInfo = valueAfter(top, ["Pakke", "info.:"], side?.first.left);
  const glassDelivery = valueAfter(top, ["Glas", "lev.:"]);
  let glassPallet = valueAfter(top, ["Glas", "palle:"]);
  if (glassPallet !== null && /^[_ ]*$/.test(glassPallet)) glassPallet = null;

  const kunde = find(top, "Kunde:");
  const levAdr = find(top, "Lev.", "adr.:");
  const bottom = find(top, "Dato:")?.line.y ?? find(top, "Sagsbeh.:")?.line.y ?? page.headerRuleY;
  let customer: string[] = [];
  let deliveryAddress: string[] = [];
  if (kunde)
    customer = blockLines(
      top,
      kunde.last.right + 1,
      levAdr ? levAdr.first.left - 2 : kunde.last.right + 160,
      kunde.line.y + 2,
      bottom + 2,
    );
  if (levAdr)
    deliveryAddress = blockLines(
      top,
      levAdr.last.right + 1,
      side ? side.first.left - 2 : levAdr.last.right + 190,
      levAdr.line.y + 2,
      bottom + 2,
    );

  return {
    orderNumber,
    customer,
    deliveryAddress,
    deliveryWeek: weekText === null ? null : parseLeadingInt(weekText),
    date: parseDate(dateText?.split(" ")[0]),
    caseHandler,
    packageInfo,
    glassDelivery,
    glassPallet,
  };
}

// The text in a box of the header, a line per printed line.
function blockLines(lines: readonly Line[], left: number, right: number, top: number, bottom: number): string[] {
  return lines
    .filter((l) => l.y <= top && l.y > bottom)
    .map((l) => joinWords(l.words.filter((w) => w.left >= left && w.left < right)))
    .filter((t) => t.length > 0);
}

// ----- Positions

function readPositions(pages: readonly (PageText | null)[], problems: string[]): OrderPosition[] {
  const result: OrderPosition[] = [];
  let current: PositionBuilder | null = null;
  for (const page of pages) {
    if (!page) {
      if (current) current.pageCount++;
      continue;
    }
    const start = find(page.body, "Position:");
    if (start && start.first.left < 120) {
      if (current) result.push(current.build());
      current = new PositionBuilder(page.index);
      try {
        readStartPage(page, current);
      } catch (e) {
        problems.push(`Page ${page.index + 1}: ${message(e)}`);
      }
    } else if (current) {
      current.pageCount++;
      try {
        current.lower(page.body.map((l) => l.words));
      } catch (e) {
        problems.push(`Page ${page.index + 1}: ${message(e)}`);
      }
    }
  }
  if (current) result.push(current.build());

  for (const p of result) if (p.number <= 0) problems.push(`Page ${p.pageIndex + 1}: position number not read`);
  return result;
}

function readStartPage(page: PageText, pos: PositionBuilder): void {
  const body = page.body;
  const bodyWords = body.flatMap((l) => l.words);
  const dash = bodyWords.find((w) => isRule(w, "-") && w.left < 120);
  const feltHead = body.find((l) => has(l, "Åbningsfunktion") || has(l, "Glastype"));
  const cutHead = body.find((l) => l.words[0].text === "Afkortning");
  const dashY = dash ? dash.bottom : cutHead ? cutHead.y + 3 : 0;

  // The scale and weight line and "Mål u/kobling", both at the right above the drawing.
  const skip = new Set<Word>();
  const scale = bodyWords.find((w) => /^1:\d+$/.test(w.text));
  if (scale) {
    pos.scale = scale.text;
    const line = body.find((l) => l.words.includes(scale))!;
    const rest = line.words.filter((w) => w.left >= scale.left);
    for (const w of rest) skip.add(w);
    const ca = rest.findIndex((w) => same(w.text, "Ca."));
    if (ca >= 0 && ca + 1 < rest.length) pos.weightKg = parseDecimal(rest[ca + 1].text);
  }
  const kobling = find(body, "u/kobling:");
  if (kobling) {
    const { line, first, last } = kobling;
    const at = line.words.indexOf(first);
    const label = at > 0 && first.left - line.words[at - 1].right < 6 ? line.words[at - 1] : first;
    for (const w of line.words) if (w.left >= label.left) skip.add(w);
    const text = joinWords(line.words.filter((w) => w.left > last.left));
    const m = /(\d+(?:[.,]\d+)?)\s*\*\s*(\d+(?:[.,]\d+)?)/.exec(text);
    if (m) {
      const width = parseDecimal(m[1]);
      const height = parseDecimal(m[2]);
      if (width !== null && height !== null) pos.sizeWithoutCoupling = { width, height, text: `${m[1]} * ${m[2]}` };
    }
  }

  const feltAnchors = anchors(
    feltHead,
    ["Felt", 199],
    ["Åbningsfunktion", 223],
    ["Rammemål", 365],
    ["Glastype", 439],
    ["Stk", 593],
    ["Glasmål", 628],
    ["Glasliste", 701],
    ["Tætning", 756],
  );
  const feltLeft = feltAnchors[0];

  // Left column: System, Position:, colours, Antal:, Karmhuller:, and bold notes.
  for (const line of body) {
    const words = line.words.filter((w) => w.bottom > dashY + 0.5 && !skip.has(w));
    const left = words.filter((w) => w.left < feltLeft - 4);
    if (left.length === 0) continue;
    readLeftLine(pos, left, words, skip);
  }

  // Felt oplysninger
  if (feltHead) {
    const rows = body
      .map((l) =>
        l.words.filter((w) => w.bottom > dashY + 0.5 && w.bottom < feltHead.y - 1 && w.left >= feltLeft - 4 && !skip.has(w)),
      )
      .filter((ws) => ws.length > 0);
    readFields(pos, rows, feltAnchors);
  }

  // The drawing: every stroked line and image near the top right of the lower half, the
  // turned dimension text, and the plain text among them (field numbers, sizes).
  const limit = (dash ? dash.bottom : page.height) + 20;
  const parts = [...page.strokes, ...page.images].filter((r) => r.left >= 400 && r.top <= limit);
  let drawLeft = 575;
  if (parts.length > 0) {
    drawLeft = Math.min(drawLeft, ...parts.map((r) => r.left));
    parts.push(...page.rotated.filter((r) => r.left >= drawLeft - 4 && r.top <= limit));
    parts.push(
      ...bodyWords
        .filter((w) => w.bottom < dashY && w.left >= drawLeft - 4 && !skip.has(w))
        .map((w) => ({ left: w.left, bottom: w.bottom, right: w.right, top: w.top })),
    );
    const pad = 3;
    pos.drawing = {
      left: round2(Math.max(0, Math.min(...parts.map((r) => r.left)) - pad)),
      bottom: round2(Math.max(0, Math.min(...parts.map((r) => r.bottom)) - pad)),
      right: round2(Math.min(page.width, Math.max(...parts.map((r) => r.right)) + pad)),
      top: round2(Math.min(page.height, Math.max(...parts.map((r) => r.top)) + pad)),
      pageWidth: page.width,
      pageHeight: page.height,
    };
  }

  // Below the rule: cutting list, glazing bars, hardware, accessories.
  const lower = body
    .map((l) => l.words.filter((w) => w.bottom <= dashY + 0.5 && w.left < drawLeft - 4 && !skip.has(w)))
    .filter((ws) => ws.length > 0);
  pos.lower(lower);
}

function readLeftLine(pos: PositionBuilder, left: Word[], all: Word[], used: Set<Word>): void {
  const first = left[0];
  if (first.text === "System") {
    pos.system ??= nullIfEmpty(joinWords(left.slice(1)));
    return;
  }

  const colon = left.findIndex((w) => w.text.endsWith(":"));
  if (colon >= 0 && colon < 3 && !first.bold) {
    const labelText = joinWords(left.slice(0, colon + 1));
    const value = nullIfEmpty(joinWords(left.slice(colon + 1)));
    switch (labelText.toLowerCase()) {
      case "position:": {
        pos.label = value ?? "";
        const m = value === null ? null : /^(\d+)(?:\.(\d+))?/.exec(value);
        if (m) {
          pos.number = Number(m[1]);
          pos.subNumber = m[2] !== undefined ? Number(m[2]) : null;
        }
        break;
      }
      case "farve karm:":
        pos.frameColour = value;
        break;
      case "farve ramme:":
        pos.sashColour = value;
        break;
      case "farve tætning:":
        pos.sealColour = value;
        break;
      case "antal:":
        pos.quantity = value === null ? null : parseLeadingInt(value);
        break;
      case "karmhuller:":
        pos.frameHoles = value;
        break;
      default:
        pos.notes.push(value === null ? labelText : `${labelText} ${value}`);
        break;
    }
    return;
  }

  // A note in bold: the left words, and on along the line while the text runs on.
  const note = [...left];
  const lastLeft = left[left.length - 1].left;
  for (const w of byLeft(all.filter((x) => x.left > lastLeft))) {
    if (w.left - note[note.length - 1].right > 6) break;
    note.push(w);
  }
  for (const w of note) used.add(w);
  const text = joinWords(note);
  if (text.length > 0 && !/^[_\-.]*$/.test(text)) pos.notes.push(text);
}

interface FieldBuilder {
  number: string;
  opening: string | null;
  frameSize: string | null;
  glassType: string[];
  panes: GlassPane[];
  seals: string[];
}

const append = (target: string | null, text: string) => (text.length === 0 ? target : target === null ? text : `${target} ${text}`);

const pane = (quantity: number | null, size: string | null, glassList: string | null): GlassPane => ({
  quantity,
  size,
  sizeMm: parseSize(size),
  glassList,
});

function readFields(pos: PositionBuilder, rows: Word[][], a: number[]): void {
  let field: FieldBuilder | null = null;
  for (const row of rows) {
    const cols: Word[][] = Array.from({ length: 8 }, () => []);
    for (const w of row) cols[column(a, w.left, 8)].push(w);

    const number = joinWords(cols[0]);
    if (/^\d+(?:\.\d+)?$/.test(number)) {
      field = { number, opening: null, frameSize: null, glassType: [], panes: [], seals: [] };
      pos.fields.push(field);
    }
    if (!field) continue;

    field.opening = append(field.opening, joinWords(cols[1]));
    field.frameSize = append(field.frameSize, joinWords(cols[2]));
    const glass = joinWords(cols[3]);
    if (glass.length > 0) field.glassType.push(glass);

    const stk = joinWords(cols[4]);
    const size = joinWords(cols[5]);
    const list = nullIfEmpty(joinWords(cols[6]));
    if (stk.length > 0 || size.length > 0) field.panes.push(pane(parseLeadingInt(stk), nullIfEmpty(size), list));
    else if (list !== null) {
      // A door's second Glasliste sits lower than its Glasmål: it goes to the first pane without one.
      const open = field.panes.findIndex((p) => p.glassList === null);
      if (open >= 0) field.panes[open] = { ...field.panes[open], glassList: list };
      else field.panes.push(pane(null, null, list));
    }

    const seal = joinWords(cols[7]);
    if (seal.length > 0) field.seals.push(seal);
  }
}

// ----- The lower part of a position: cutting list, glazing bars, hardware, accessories

type Section = "none" | "cutting" | "fieldBars" | "hardware" | "accessories";

const ACCESSORY_ANCHORS = [188, 244, 287, 344, 413];

class PositionBuilder {
  pageCount = 1;
  label = "";
  number = 0;
  subNumber: number | null = null;
  quantity: number | null = null;
  system: string | null = null;
  frameColour: string | null = null;
  sashColour: string | null = null;
  sealColour: string | null = null;
  frameHoles: string | null = null;
  scale: string | null = null;
  weightKg: number | null = null;
  sizeWithoutCoupling: ElementSize | null = null;
  drawing: PdfBox | null = null;
  readonly notes: string[] = [];
  readonly fields: FieldBuilder[] = [];
  readonly cutting: CutRow[] = [];
  readonly fieldBars: FieldBarRow[] = [];
  readonly hardware: HardwareRow[] = [];
  readonly accessories: HardwareRow[] = [];

  // Where the lower part has got to. Carried over to the next page, where a table can go on.
  private section: Section = "none";
  private cutGroup = "";
  private group = "Tilbehør";
  private widthAnchor: number | null = null;
  private cut = [137, 181, 318, 366, 410, 450];
  private bars = [32, 60, 163];
  private hardwareAnchors = [188, 258, 300, 357, 428];

  constructor(readonly pageIndex: number) {}

  lower(lines: Word[][]): void {
    for (const raw of lines) {
      const words = byLeft(raw.filter((w) => !isRule(w, "-") && !isRule(w, "_") && /[\p{L}\p{Nd}]/u.test(w.text)));
      if (words.length === 0) continue;
      const first = words[0];

      if (first.bold && first.text === "Afkortning") {
        this.section = "cutting";
        this.cutGroup = "";
        this.widthAnchor = null;
        const lengths = words.filter((w) => w.text === "Længde:");
        this.cut = [
          at(words, "Stk.:", this.cut[0]),
          lengths.length > 0 ? lengths[0].left : this.cut[1],
          at(words, "Stål:", this.cut[2]),
          lengths.length > 1 ? lengths[1].left : this.cut[3],
          at(words, "Felt", this.cut[4]),
          at(words, "Lysm.", this.cut[5]),
        ];
        continue;
      }
      if (first.bold && first.text === "Felt" && words.some((w) => w.text === "Beskrivelse")) {
        this.section = "fieldBars";
        this.bars = [first.left, at(words, "Beskrivelse", this.bars[1]), at(words, "Farve", this.bars[2])];
        continue;
      }
      if (first.bold && first.text === "Beskrivelse") {
        this.section = "hardware";
        const h = this.hardwareAnchors;
        this.hardwareAnchors = [
          at(words, "Farve", h[0]),
          at(words, "Antal", h[1]),
          at(words, "Mål", h[2]),
          at(words, "Mont./Løs", h[3]),
          at(words, "Placering", h[4]),
        ];
        continue;
      }
      if (first.bold && first.text === "Tilbehør") {
        this.section = "accessories";
        this.group = "Tilbehør";
        continue;
      }
      // Another heading after the hardware, such as "Tilsætningsprofil": its lines are
      // laid out as Tilbehør, so they go with the accessories under their own group.
      if ((this.section === "hardware" || this.section === "accessories") && first.left < 60 && words.every((w) => w.bold)) {
        this.section = "accessories";
        this.group = joinWords(words);
        continue;
      }

      switch (this.section) {
        case "cutting":
          this.cutLine(words);
          break;
        case "fieldBars":
          this.barLine(words);
          break;
        case "hardware":
          this.hardware.push(hardwareLine("Beskrivelse", words, this.hardwareAnchors));
          break;
        case "accessories":
          this.accessories.push(hardwareLine(this.group, words, ACCESSORY_ANCHORS));
          break;
      }
    }
  }

  private cutLine(words: Word[]): void {
    const cut = this.cut;
    const stkFrom = cut[0] - 8;
    if (words[0].bold && words[0].left < 60 && !words.some((w) => w.left >= stkFrom && w.left < cut[1] - 8)) {
      // A section line: "Karm", "Ramme", or "Sprosse  Bredde" with the head of the width column.
      this.cutGroup = words[0].text;
      this.widthAnchor = words.slice(1).find((w) => w.bold && w.left < stkFrom)?.left ?? null;
      return;
    }

    const profileEnd = this.widthAnchor !== null ? this.widthAnchor - 6 : stkFrom;
    const part = (from: number, to: number) => joinWords(words.filter((w) => w.left >= from && w.left < to));
    const profile = part(-Infinity, profileEnd);
    const width = this.widthAnchor === null ? "" : part(profileEnd, stkFrom);
    const stk = part(stkFrom, cut[1] - 8);
    const lengthWords = words.filter((w) => w.left >= cut[1] - 8 && w.left < cut[2] - 8);
    const length = lengthWords.length > 0 && isNumber(lengthWords[0].text) ? lengthWords[0].text : null;
    const side = joinWords(length === null ? lengthWords : lengthWords.slice(1));
    this.cutting.push({
      section: this.cutGroup,
      profile,
      width: nullIfEmpty(width),
      quantity: parseLeadingInt(stk),
      length,
      lengthMm: length === null ? null : parseDecimal(length),
      side: nullIfEmpty(side),
      steel: nullIfEmpty(part(cut[2] - 8, cut[3] - 8)),
      steelLength: nullIfEmpty(part(cut[3] - 8, cut[4] - 8)),
      field: nullIfEmpty(part(cut[4] - 8, cut[5] - 8)),
      clearance: nullIfEmpty(part(cut[5] - 8, Infinity)),
    });
  }

  private barLine(words: Word[]): void {
    if (words[0].bold) return;
    const cells = cellsFromWords(words);
    const bars = this.bars;
    const field = joinCells(cells.filter((c) => c.left < bars[1] - 6));
    const description = joinCells(cells.filter((c) => c.left >= bars[1] - 6 && c.left < bars[2] - 6));
    const rest = cells.filter((c) => c.left >= bars[2] - 6);
    const colour = rest.length > 0 ? rest[0].text : null;
    const others = rest.slice(1);
    const length = others.findLast((c) => isNumber(c.text))?.text ?? null;
    const side = joinCells(others.filter((c) => c.text !== length));
    this.fieldBars.push({ field: nullIfEmpty(field), description, colour, side: nullIfEmpty(side), length });
  }

  build(): OrderPosition {
    return {
      label: this.label,
      number: this.number,
      subNumber: this.subNumber,
      system: this.system,
      frameColour: this.frameColour,
      sashColour: this.sashColour,
      sealColour: this.sealColour,
      quantity: this.quantity,
      frameHoles: this.frameHoles,
      notes: this.notes,
      fields: this.fields.map(
        (f): OrderField => ({
          number: f.number,
          opening: f.opening,
          frameSize: f.frameSize,
          frameSizeMm: parseSize(f.frameSize),
          glassType: f.glassType,
          panes: f.panes,
          seals: f.seals,
        }),
      ),
      scale: this.scale,
      weightKg: this.weightKg,
      sizeWithoutCoupling: this.sizeWithoutCoupling,
      cutting: this.cutting,
      fieldBars: this.fieldBars,
      hardware: this.hardware,
      accessories: this.accessories,
      pageIndex: this.pageIndex,
      pageCount: this.pageCount,
      drawing: this.drawing,
    };
  }
}

function hardwareLine(group: string, words: Word[], anchorsAt: number[]): HardwareRow {
  const cells: Cell[] = cellsFromWords(words);
  const parts: string[][] = Array.from({ length: 6 }, () => []);
  for (const c of cells) {
    let col = 0;
    for (let i = 0; i < anchorsAt.length; i++) if (c.left >= anchorsAt[i] - 8) col = i + 1;
    parts[col].push(c.text);
  }
  const p = (i: number) => nullIfEmpty(parts[i].join(" "));
  return { group, description: p(0) ?? "", colour: p(1), quantity: p(2), size: p(3), mounting: p(4), placement: p(5) };
}

// ----- Small helpers

// The table column a word starting at x falls in, given each column head's left edge.
function column(anchorsAt: number[], x: number, count: number): number {
  let col = 0;
  for (let i = 0; i < count && i < anchorsAt.length; i++) if (x >= anchorsAt[i] - 8) col = i;
  return col;
}

function anchors(head: Line | undefined, ...columns: [text: string, fallback: number][]): number[] {
  return columns.map(([text, fallback]) => head?.words.find((w) => w.text === text)?.left ?? fallback);
}

const at = (words: Word[], text: string, fallback: number) => words.find((w) => w.text === text)?.left ?? fallback;

function nullIfEmpty(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

// pdfjs hands path boxes over as 32-bit floats: 278.6 comes back as 278.6000061.
const round2 = (n: number) => Math.round(n * 100) / 100;

const isNumber = (s: string) => /^\d+(?:[.,]\d+)?$/.test(s);

/** The whole number a text starts with ("12 stk" gives 12), or null. */
export function parseLeadingInt(s: string): number | null {
  const m = /^\d+/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[0]);
  return n <= 2147483647 ? n : null;
}

/** Danish decimals: "84,5", "1485,0", "1.485,0". Null when the text is not a number. */
export function parseDecimal(s: string): number | null {
  let t = s.trim();
  if (t.includes(",")) t = t.replaceAll(".", "").replace(",", ".");
  return /^(?:\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}

/** "1415,0 * 1310,0" as numbers, or null. */
export function parseSize(s: string | null): SizeMm | null {
  if (s === null) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*\*\s*(\d+(?:[.,]\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const width = parseDecimal(m[1]);
  const height = parseDecimal(m[2]);
  return width === null || height === null ? null : { width, height };
}

// "22-10-2026", "2-1-2026", "22.10.2026" or "22-10-26" as "2026-10-22".
function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s) ?? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  let year: number;
  if (m) year = Number(m[3]);
  else {
    m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const yy = Number(m[3]);
    year = yy < 50 ? 2000 + yy : 1900 + yy;
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
