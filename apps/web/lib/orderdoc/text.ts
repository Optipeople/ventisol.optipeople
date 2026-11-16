// Text assembly: from the glyphs of a page, in the order they were drawn, to words and lines.
// Pure, no pdfjs here. The same steps as the station app's .NET parser, so both read a page alike.

/** One drawn character. Coordinates are PDF points with the origin at the bottom left. */
export interface Glyph {
  /** The character(s) as Unicode. A space is " ". */
  text: string;
  /** Start of the baseline. */
  x: number;
  y: number;
  /** End of the baseline: the start plus the glyph's own width (no character spacing). */
  endX: number;
  endY: number;
  /** Font size in points. */
  size: number;
  /** Identity of the font, compared to tell where a run ends. */
  font: string;
  bold: boolean;
}

/** A box in PDF points, origin at the bottom left. */
export interface Box {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export interface Word {
  text: string;
  left: number;
  /** The baseline. */
  bottom: number;
  right: number;
  top: number;
  bold: boolean;
}

export interface Line {
  /** Baseline of the line's topmost word. */
  y: number;
  words: Word[];
}

export interface Cell {
  text: string;
  left: number;
}

/** How far above the baseline a capital or a digit reaches, as a share of the font size (Arial). */
const ASCENT = 0.716;

const isBlank = (s: string) => s.trim().length === 0;

// Rounds halves to the even neighbour, as .NET's Math.Round does.
function roundHalfEven(n: number): number {
  const floor = Math.floor(n);
  const rest = n - floor;
  if (rest < 0.5) return floor;
  if (rest > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Bold text in these PDFs is often the same run drawn twice on the same spot. A glyph drawn again
 * where the same character already sits (to half a point) is dropped.
 */
export function dedupeGlyphs(glyphs: readonly Glyph[]): Glyph[] {
  const seen = new Set<string>();
  const kept: Glyph[] = [];
  for (const g of glyphs) {
    const key = `${g.text}\u0000${roundHalfEven(g.x * 2)}\u0000${roundHalfEven(g.y * 2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(g);
  }
  return kept;
}

/** Text running left to right along a level baseline. A glyph with no width counts as horizontal. */
export function isHorizontal(g: Glyph): boolean {
  return Math.abs(g.y - g.endY) < 1e-4 && g.x <= g.endX;
}

/**
 * Glyphs into words in the order they were drawn: a word ends at a space, or where the next glyph
 * does not follow on from the last (a jump, a new line, another font). Sorting by x instead would
 * mix two texts that overlap on the page, as a long description running into the colour does.
 * Takes horizontal glyphs only (see isHorizontal).
 */
export function wordsFromGlyphs(glyphs: Iterable<Glyph>): Word[] {
  const words: Word[] = [];
  let run: Glyph[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const text = run
      .map((g) => g.text)
      .join("")
      .trim();
    if (text.length > 0) {
      let left = Infinity;
      let bottom = Infinity;
      let right = -Infinity;
      let top = -Infinity;
      for (const g of run) {
        left = Math.min(left, g.x, g.endX);
        right = Math.max(right, g.x, g.endX);
        bottom = Math.min(bottom, g.y);
        top = Math.max(top, g.y + g.size * ASCENT);
      }
      words.push({ text, left, bottom, right, top, bold: run[0].bold });
    }
    run = [];
  };

  for (const g of glyphs) {
    if (isBlank(g.text)) {
      flush();
      continue;
    }
    if (run.length > 0) {
      const prev = run[run.length - 1];
      const gap = g.x - prev.endX;
      const size = Math.max(1, prev.size);
      if (Math.abs(g.y - prev.y) > 0.5 || gap > size * 0.15 || gap < -size * 0.15 || g.font !== prev.font) flush();
    }
    run.push(g);
  }
  flush();
  return words;
}

/** Words into lines, top to bottom: a line takes the words whose baseline is within 1.6 pt of its first. */
export function groupLines(words: readonly Word[]): Line[] {
  const lines: Line[] = [];
  const sorted = [...words].sort((a, b) => b.bottom - a.bottom);
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.y - w.bottom <= 1.6) last.words.push(w);
    else lines.push({ y: w.bottom, words: [w] });
  }
  for (const l of lines) l.words.sort((a, b) => a.left - b.left);
  return lines;
}

/** The words of a page, read from its glyphs: drawn-twice glyphs dropped, horizontal text only. */
export function linesFromGlyphs(glyphs: readonly Glyph[]): Line[] {
  return groupLines(wordsFromGlyphs(dedupeGlyphs(glyphs).filter(isHorizontal)));
}

export function byLeft<T extends { left: number }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => a.left - b.left);
}

export function joinWords(words: Iterable<Word>): string {
  return byLeft(words)
    .map((w) => w.text)
    .join(" ")
    .trim();
}

export function joinCells(cells: Iterable<Cell>): string {
  return [...cells]
    .map((c) => c.text)
    .join(" ")
    .trim();
}

/**
 * Words that run on (a space apart) as one cell. A wider gap starts the next column, and so does
 * a word printed over the one before it (a long description running into the colour column).
 */
export function cellsFromWords(words: readonly Word[]): Cell[] {
  const cells: Cell[] = [];
  let prev: Word | null = null;
  let parts: Word[] = [];
  for (const w of byLeft(words)) {
    if (prev && (w.left - prev.right > 5 || w.left < prev.right - 1)) {
      cells.push({ text: joinWords(parts), left: parts[0].left });
      parts = [];
    }
    parts.push(w);
    prev = w;
  }
  if (parts.length > 0) cells.push({ text: joinWords(parts), left: parts[0].left });
  return cells;
}

/** A line of 10 or more of the same character: the rules drawn with "____" and "----". */
export function isRule(word: Word, char: string): boolean {
  if (word.text.length < 10) return false;
  for (const c of word.text) if (c !== char) return false;
  return true;
}

/** The box of a glyph that is not horizontal (the turned dimension text of a drawing). */
export function glyphBox(g: Glyph): Box {
  const dx = g.endX - g.x;
  const dy = g.endY - g.y;
  const length = Math.hypot(dx, dy) || 1;
  // The direction "up" from the baseline: the baseline turned a quarter to the left.
  const ux = (-dy / length) * g.size * ASCENT;
  const uy = (dx / length) * g.size * ASCENT;
  const xs = [g.x, g.endX, g.x + ux, g.endX + ux];
  const ys = [g.y, g.endY, g.y + uy, g.endY + uy];
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
}
