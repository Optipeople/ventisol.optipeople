// The PDF of a report page: an A4 table document with a title, the period,
// when it was made, a note when the rows were capped, and the rows. The
// header row repeats on every page, the footer counts the pages.
//
// pdf-lib with the standard Helvetica: pure JavaScript, no font files read
// from disk, so it runs as is in a Vercel Node function. Helvetica speaks
// WinAnsi (æ, ø, å and the usual Latin-1 are fine); any other character is
// replaced before drawing, since pdf-lib throws on it.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { KIND_ALIGN_RIGHT, KIND_WIDTH, cellText } from "./cells";
import type { ExportColumn } from "./columns";

export interface PdfInput<R> {
  /** Danish heading. */
  title: string;
  /** "Periode: 01-10-2026 til 31-10-2026", or null when the report has no period. */
  period?: string | null;
  /** "Dannet 16-11-2026 12:00". */
  generated: string;
  /** Lines under the heading, e.g. that the rows were capped. */
  notes?: string[];
  columns: ExportColumn<R>[];
  rows: R[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;
const TITLE_SIZE = 16;
const META_SIZE = 9;
const FOOTER_SIZE = 8;
const ROW_PAD = 3;

const TEXT = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);
const RULE = rgb(0.82, 0.82, 0.85);
const HEADER_FILL = rgb(0.93, 0.94, 0.96);
const STRIPE_FILL = rgb(0.975, 0.975, 0.98);

/** Characters WinAnsi lacks, mapped to ones it has. */
const REPLACEMENTS: Record<string, string> = { "−": "-", " ": " ", " ": " ", " ": " " };

/** Makes `text` drawable in `font`: known stand-ins first, then "?" for the rest. */
function drawable(font: PDFFont, text: string, cache: Map<string, boolean>): string {
  let out = "";
  for (const raw of text) {
    const ch = REPLACEMENTS[raw] ?? raw;
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += " ";
      continue;
    }
    let ok = cache.get(ch);
    if (ok === undefined) {
      try {
        font.encodeText(ch);
        ok = true;
      } catch {
        ok = false;
      }
      cache.set(ch, ok);
    }
    out += ok ? ch : "?";
  }
  return out;
}

/** Cuts `text` to `width` at `size`, ending with "...". */
function fit(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  const dots = "...";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + dots, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo).trimEnd() + dots;
}

/** Builds the PDF. Landscape when the table is wide. */
export async function toPdf<R>(input: PdfInput<R>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setLanguage("da-DK");
  doc.setCreator("Ventisol portal");
  doc.setProducer("Ventisol portal");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const cache = new Map<string, boolean>();
  const boldCache = new Map<string, boolean>();
  const clean = (t: string) => drawable(font, t, cache);
  const cleanBold = (t: string) => drawable(bold, t, boldCache);

  const weights = input.columns.map((c) => Math.max(c.width ?? KIND_WIDTH[c.kind], 5));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const landscape = input.columns.length > 7 || totalWeight > 95;
  const [pageWidth, pageHeight] = landscape ? [A4[1], A4[0]] : A4;
  const tableWidth = pageWidth - 2 * MARGIN;
  const widths = weights.map((w) => (w / totalWeight) * tableWidth);

  // Smaller type for many columns, never below 6.5 pt.
  const bodySize = Math.max(6.5, Math.min(9, 9 - Math.max(0, input.columns.length - 8) * 0.35));
  const rowHeight = bodySize + 2 * ROW_PAD + 1;

  // Header cells wrap to at most two lines.
  const headerLines = input.columns.map((c, i) => wrapTwo(bold, cleanBold(c.header), bodySize, widths[i] - 2 * ROW_PAD));
  const headerHeight = (Math.max(...headerLines.map((l) => l.length), 1) * (bodySize + 1)) + 2 * ROW_PAD;

  const cells = input.rows.map((row) => input.columns.map((c) => clean(cellText(c.kind, c.value(row)))));

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const newPage = (first: boolean) => {
    page = doc.addPage([pageWidth, pageHeight]);
    pages.push(page);
    y = pageHeight - MARGIN;
    if (first) {
      y -= TITLE_SIZE;
      page.drawText(fit(bold, cleanBold(input.title), TITLE_SIZE, tableWidth), { x: MARGIN, y, size: TITLE_SIZE, font: bold, color: TEXT });
      y -= 6;
      const meta = [input.period, input.generated].filter((t): t is string => !!t);
      for (const line of meta) {
        y -= META_SIZE + 3;
        page.drawText(fit(font, clean(line), META_SIZE, tableWidth), { x: MARGIN, y, size: META_SIZE, font, color: MUTED });
      }
      for (const note of input.notes ?? []) {
        y -= META_SIZE + 3;
        page.drawText(fit(bold, cleanBold(note), META_SIZE, tableWidth), { x: MARGIN, y, size: META_SIZE, font: bold, color: TEXT });
      }
      y -= 12;
    } else {
      y -= META_SIZE;
      page.drawText(fit(font, clean(input.title), META_SIZE, tableWidth), { x: MARGIN, y, size: META_SIZE, font, color: MUTED });
      y -= 8;
    }
    drawHeader();
  };

  const drawHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - headerHeight, width: tableWidth, height: headerHeight, color: HEADER_FILL });
    let x = MARGIN;
    input.columns.forEach((c, i) => {
      const lines = headerLines[i];
      lines.forEach((line, n) => {
        const w = bold.widthOfTextAtSize(line, bodySize);
        const tx = KIND_ALIGN_RIGHT[c.kind] ? x + widths[i] - ROW_PAD - w : x + ROW_PAD;
        page.drawText(line, { x: tx, y: y - ROW_PAD - (n + 1) * (bodySize + 1) + 1, size: bodySize, font: bold, color: TEXT });
      });
      x += widths[i];
    });
    y -= headerHeight;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableWidth, y }, thickness: 0.6, color: MUTED });
  };

  newPage(true);

  if (cells.length === 0) {
    y -= rowHeight + 4;
    page.drawText("Ingen rækker i udtrækket.", { x: MARGIN + ROW_PAD, y, size: bodySize + 1, font, color: MUTED });
  }

  cells.forEach((rowCells, r) => {
    if (y - rowHeight < MARGIN + FOOTER_SIZE + 8) newPage(false);
    if (r % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - rowHeight, width: tableWidth, height: rowHeight, color: STRIPE_FILL });
    }
    let x = MARGIN;
    const baseline = y - ROW_PAD - bodySize + 1;
    rowCells.forEach((text, i) => {
      const room = widths[i] - 2 * ROW_PAD;
      // A slightly too long text (often "Ingen data endnu") shrinks a little
      // before it is cut.
      const full = font.widthOfTextAtSize(text, bodySize);
      const size = full > room && full * 0.8 <= room ? (bodySize * room) / full : bodySize;
      const shown = fit(font, text, size, room);
      const w = font.widthOfTextAtSize(shown, size);
      const tx = KIND_ALIGN_RIGHT[input.columns[i].kind] ? x + widths[i] - ROW_PAD - w : x + ROW_PAD;
      if (shown) page.drawText(shown, { x: tx, y: baseline, size, font, color: TEXT });
      x += widths[i];
    });
    y -= rowHeight;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableWidth, y }, thickness: 0.3, color: RULE });
  });

  pages.forEach((p, i) => {
    const label = `Side ${i + 1} af ${pages.length}`;
    const w = font.widthOfTextAtSize(label, FOOTER_SIZE);
    p.drawText(label, { x: pageWidth - MARGIN - w, y: MARGIN - FOOTER_SIZE, size: FOOTER_SIZE, font, color: MUTED });
    p.drawText(fit(font, clean(input.generated), FOOTER_SIZE, tableWidth / 2), {
      x: MARGIN,
      y: MARGIN - FOOTER_SIZE,
      size: FOOTER_SIZE,
      font,
      color: MUTED,
    });
  });

  return doc.save();
}

/** Splits a header into at most two lines that fit `width`. */
function wrapTwo(font: PDFFont, text: string, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(text, size) <= width) return [text];
  const words = text.split(" ");
  let first = "";
  let i = 0;
  while (i < words.length) {
    const next = first ? `${first} ${words[i]}` : words[i];
    if (font.widthOfTextAtSize(next, size) > width && first) break;
    first = next;
    i++;
  }
  const rest = words.slice(i).join(" ");
  return rest ? [fit(font, first, size, width), fit(font, rest, size, width)] : [fit(font, first, size, width)];
}
