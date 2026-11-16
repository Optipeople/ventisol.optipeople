import type { OrderDocument, OrderPosition } from "./types";

/**
 * The position of a document by number. The PDF numbers positions 1, 2, 3 (never 5.1 in the
 * samples), so sub-position 01 and any other sub-position land on the same position. If a document
 * ever prints "Position: 5.1", sub-position 02 picks it (sub-position 01 is the position itself).
 */
export function positionFor(doc: Pick<OrderDocument, "positions">, position: number, subPosition = 1): OrderPosition | null {
  const sub = subPosition <= 1 ? null : subPosition - 1;
  return (
    doc.positions.find((p) => p.number === position && p.subNumber === sub) ??
    doc.positions.find((p) => p.number === position && p.subNumber === null) ??
    doc.positions.find((p) => p.number === position) ??
    null
  );
}

export interface BarcodeParts {
  orderNumber: number;
  position: number;
  subPosition: number;
  piece: number;
}

/**
 * The label barcode "058556050103": a 0, order 58556, position 05, sub-position 01, piece 03.
 * A scan that lost its leading 0 (11 digits, not starting with 0) is taken too. Null for anything
 * else, also the 14-digit profile labels, which need the station app's order hints to read.
 */
export function parseElementBarcode(barcode: string): BarcodeParts | null {
  let raw = barcode.trim();
  if (!/^\d+$/.test(raw)) return null;
  if (raw.length === 11 && raw[0] !== "0") raw = `0${raw}`;
  if (raw.length !== 12) return null;
  return {
    orderNumber: Number(raw.slice(1, 6)),
    position: Number(raw.slice(6, 8)),
    subPosition: Number(raw.slice(8, 10)),
    piece: Number(raw.slice(10, 12)),
  };
}

/**
 * The position an element's barcode belongs to, or null: not a barcode, no such position, or a
 * barcode of another order than the document's.
 */
export function positionForBarcode(doc: Pick<OrderDocument, "positions" | "header">, barcode: string): OrderPosition | null {
  const parts = parseElementBarcode(barcode);
  if (!parts) return null;
  if (doc.header.orderNumber !== null && doc.header.orderNumber !== parts.orderNumber) return null;
  return positionFor(doc, parts.position, parts.subPosition);
}
