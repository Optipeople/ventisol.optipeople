// Reads the pages of a PDF with pdfjs-dist into PageInput: every glyph in the order it was drawn,
// and the boxes of stroked paths and images.
//
// Why the operator list and not getTextContent: text content hands back merged strings (it joins
// runs, makes up spaces and drops some overdrawn glyphs by its own rules), so the place of a word
// inside an item can only be guessed. The operator list has each glyph with its width, in drawing
// order, which is what the station app's parser works from. No canvas is used and nothing is
// rendered. pdfjs runs its "worker" on the calling thread in Node; the worker module is imported
// here by name so a bundler or file tracer includes it.

import type { PageInput } from "./layout";
import type { Box, Glyph } from "./text";

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// a applied first, then b.
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const points = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
}

interface FontInfo {
  id: string;
  bold: boolean;
  /** Glyph widths are in font units: times this and the font size gives points. */
  unit: number;
}

interface State {
  ctm: Matrix;
  textMatrix: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  leading: number;
  rise: number;
  hScale: number;
  charSpacing: number;
  wordSpacing: number;
  font: FontInfo | null;
  fontSize: number;
  fontDirection: number;
}

/** The part of a pdfjs glyph this reader uses. A number in a glyph list is a kerning move. */
export interface OpGlyph {
  unicode: string;
  width: number;
  isSpace: boolean;
}

/** An operator list as pdfjs gives it, with the operator numbers and font lookup it needs. */
export interface OperatorSource {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
  ops: Record<string, number>;
  font(id: string): { bold?: boolean; fontMatrix?: ArrayLike<number> } | null;
}

/**
 * Walks an operator list and keeps track of the text and graphics state the way a renderer does,
 * to give each glyph its place on the page. Exported for tests.
 */
export function readOperators(src: OperatorSource): { glyphs: Glyph[]; strokes: Box[]; images: Box[] } {
  const { ops } = src;
  const glyphs: Glyph[] = [];
  const strokes: Box[] = [];
  const images: Box[] = [];
  const stack: State[] = [];
  let s: State = {
    ctm: IDENTITY,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    leading: 0,
    rise: 0,
    hScale: 1,
    charSpacing: 0,
    wordSpacing: 0,
    font: null,
    fontSize: 0,
    fontDirection: 1,
  };
  const fonts = new Map<string, FontInfo>();
  const strokeOps = new Set(
    [ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke].filter(
      (n) => n !== undefined,
    ),
  );

  const moveText = (x: number, y: number) => {
    s.x = s.lineX += x;
    s.y = s.lineY += y;
  };

  const showText = (list: unknown) => {
    if (!Array.isArray(list) || !s.font || s.fontSize === 0) return;
    const hScale = s.hScale * s.fontDirection;
    const advance = s.fontSize * s.font.unit;
    const toPage = multiply(s.textMatrix, s.ctm);
    const size = s.fontSize * Math.hypot(toPage[2], toPage[3]);
    let x = 0;
    for (const g of list as (OpGlyph | number)[]) {
      if (typeof g === "number") {
        x -= (g * s.fontSize) / 1000;
        continue;
      }
      if (g === null || typeof g !== "object") continue;
      const width = (g.width ?? 0) * advance;
      const [x0, y0] = apply(toPage, s.x + x * hScale, s.y + s.rise);
      const [x1, y1] = apply(toPage, s.x + (x + width) * hScale, s.y + s.rise);
      glyphs.push({ text: g.unicode ?? "", x: x0, y: y0, endX: x1, endY: y1, size, font: s.font.id, bold: s.font.bold });
      x += width + ((g.isSpace ? s.wordSpacing : 0) + s.charSpacing) * s.fontDirection;
    }
    s.x += x * hScale;
  };

  const image = () => images.push(boxOf(s.ctm, 0, 0, 1, 1));

  for (let i = 0; i < src.fnArray.length; i++) {
    const fn = src.fnArray[i];
    const args = (src.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case ops.save:
        stack.push({ ...s });
        break;
      case ops.restore:
        s = stack.pop() ?? s;
        break;
      case ops.transform:
        s.ctm = multiply(args as Matrix, s.ctm);
        break;
      case ops.paintFormXObjectBegin:
        stack.push({ ...s });
        if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) s.ctm = multiply(Array.from(args[0] as ArrayLike<number>) as Matrix, s.ctm);
        break;
      case ops.paintFormXObjectEnd:
        s = stack.pop() ?? s;
        break;
      case ops.beginText:
        s.textMatrix = IDENTITY;
        s.x = s.lineX = 0;
        s.y = s.lineY = 0;
        break;
      case ops.setCharSpacing:
        s.charSpacing = args[0] as number;
        break;
      case ops.setWordSpacing:
        s.wordSpacing = args[0] as number;
        break;
      case ops.setHScale:
        s.hScale = (args[0] as number) / 100;
        break;
      case ops.setLeading:
        s.leading = -(args[0] as number);
        break;
      case ops.setTextRise:
        s.rise = args[0] as number;
        break;
      case ops.setFont: {
        const id = String(args[0]);
        let font = fonts.get(id);
        if (!font) {
          const f = src.font(id);
          font = { id, bold: f?.bold === true, unit: f?.fontMatrix?.[0] || 0.001 };
          fonts.set(id, font);
        }
        const size = args[1] as number;
        s.font = font;
        s.fontSize = Math.abs(size);
        s.fontDirection = size < 0 ? -1 : 1;
        break;
      }
      case ops.moveText:
        moveText(args[0] as number, args[1] as number);
        break;
      case ops.setLeadingMoveText:
        s.leading = args[1] as number;
        moveText(args[0] as number, args[1] as number);
        break;
      case ops.setTextMatrix: {
        const m = args.length >= 6 ? args : (args[0] as ArrayLike<number>);
        s.textMatrix = Array.from(m as ArrayLike<number>).slice(0, 6) as Matrix;
        s.x = s.lineX = 0;
        s.y = s.lineY = 0;
        break;
      }
      case ops.nextLine:
        moveText(0, s.leading);
        break;
      case ops.showText:
      case ops.showSpacedText:
        showText(args[0]);
        break;
      case ops.nextLineShowText:
        moveText(0, s.leading);
        showText(args[0]);
        break;
      case ops.nextLineSetSpacingShowText:
        s.wordSpacing = args[0] as number;
        s.charSpacing = args[1] as number;
        moveText(0, s.leading);
        showText(args[2]);
        break;
      case ops.constructPath: {
        const minMax = args[2] as ArrayLike<number> | null | undefined;
        if (strokeOps.has(args[0] as number) && minMax && minMax.length >= 4 && Number.isFinite(minMax[0]))
          strokes.push(boxOf(s.ctm, minMax[0], minMax[1], minMax[2], minMax[3]));
        break;
      }
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
      case ops.paintImageXObjectRepeat:
      case ops.paintImageMaskXObjectRepeat:
        image();
        break;
    }
  }
  return { glyphs, strokes, images };
}

export interface PdfPages {
  pageCount: number;
  /** A page that could not be read is null, with a line in `problems`. */
  pages: (PageInput | null)[];
  problems: string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens a PDF and reads every page. Throws when the bytes are not a PDF pdfjs can open. */
export async function readPdfPages(bytes: Uint8Array): Promise<PdfPages> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs looks here for its worker code before it tries to import a worker file by path.
  const scope = globalThis as { pdfjsWorker?: unknown };
  scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

  const task = pdfjs.getDocument({
    // pdfjs may take the buffer over: it gets a copy.
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pageCount = doc.numPages;
    const pages: (PageInput | null)[] = [];
    const problems: string[] = [];
    const ops = pdfjs.OPS as unknown as Record<string, number>;
    for (let i = 0; i < pageCount; i++) {
      try {
        const page = await doc.getPage(i + 1);
        const list = await page.getOperatorList();
        const [x0, y0, x1, y1] = page.view;
        const read = readOperators({
          fnArray: list.fnArray,
          argsArray: list.argsArray,
          ops,
          font: (id) => {
            try {
              return page.commonObjs.get(id) as { bold?: boolean; fontMatrix?: ArrayLike<number> };
            } catch {
              return null;
            }
          },
        });
        pages.push({ index: i, width: x1 - x0, height: y1 - y0, ...read });
        page.cleanup();
      } catch (e) {
        pages.push(null);
        problems.push(`Page ${i + 1}: could not be read (${message(e)})`);
      }
    }
    return { pageCount, pages, problems };
  } finally {
    await task.destroy().catch(() => {});
  }
}
