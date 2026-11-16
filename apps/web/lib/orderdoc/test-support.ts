// Hand-built glyphs for tests: text laid out the way a PDF draws it, a glyph per character.

import type { Glyph } from "./text";

export interface RunOptions {
  bold?: boolean;
  size?: number;
  font?: string;
}

/** The glyphs of a text drawn from (x, y) rightwards. Every character is half the font size wide, a space a quarter. */
export function run(text: string, x: number, y: number, options: RunOptions = {}): Glyph[] {
  const size = options.size ?? 9.7;
  const bold = options.bold ?? false;
  const font = options.font ?? (bold ? "bold" : "regular");
  const glyphs: Glyph[] = [];
  let at = x;
  for (const char of text) {
    const width = size * (char === " " ? 0.25 : 0.5);
    glyphs.push({ text: char, x: at, y, endX: at + width, endY: y, size, font, bold });
    at += width;
  }
  return glyphs;
}

/** A text turned a quarter to the left, drawn from (x, y) upwards, as the height of a drawing is. */
export function runUp(text: string, x: number, y: number, size = 9): Glyph[] {
  const glyphs: Glyph[] = [];
  let at = y;
  for (const char of text) {
    const width = size * 0.5;
    glyphs.push({ text: char, x, y: at, endX: x, endY: at + width, size, font: "regular", bold: false });
    at += width;
  }
  return glyphs;
}
