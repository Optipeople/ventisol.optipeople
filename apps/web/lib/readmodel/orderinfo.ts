// From a parsed 3E production list (raw.order_documents.parsed) to the
// OrderInfo that lib/derive takes. Pure.
//
// How the two models meet:
//
//   - lib/orderdoc gives one line per printed position: `position`,
//     `subNumber` (null for "5", 1 for "5.1"), `quantity` (Antal, null when it
//     could not be read) and the element type.
//   - lib/derive matches a scanned element to a line on exactly
//     (position, subPosition), where subPosition 1 is the position itself
//     (the barcode's "01") and 2 is "5.1".
//
// So subNumber null becomes subPosition 1, and subNumber n becomes n + 1.
// Two gaps are bridged here, because derive only matches exactly:
//
//   - The samples never print "5.1", yet a barcode can carry sub-position 02.
//     lib/orderdoc's positionFor lets every sub-position of a position fall
//     back on the whole position. Here a scanned sub-position with no line of
//     its own gets a line copied from its position (same type, system and
//     size), expecting the pieces seen in scans. It can therefore never hold
//     an order open for pieces no scan has shown: how 3E counts the parts of
//     a coupled element is not confirmed with a real order yet.
//   - A position whose Antal could not be read expects the pieces seen in
//     scans, at least one. Derive would otherwise drop the line and the
//     position's elements would lose their type.

import type { ExpectedElement, OrderInfo } from "@/lib/derive";
import {
  classifyElementType,
  DEFAULT_ELEMENT_TYPE_RULES,
  type ElementTypeRule,
} from "@/lib/orderdoc/element-types";
import type { OrderDocument, OrderPosition } from "@/lib/orderdoc/types";

/** What the scans of an order show: its barcodes with position and sub-position. */
export interface SeenElement {
  barcode: string;
  position: number | null;
  subPosition: number | null;
}

const subOf = (subPosition: number | null | undefined) =>
  subPosition == null || subPosition < 1 ? 1 : subPosition;

function firstLine(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    if (typeof line === "string" && line.trim().length > 0) return line.trim();
  }
  return null;
}

function joined(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  const parts = lines.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter((l) => l.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

const wholeMm = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

/**
 * `parsed` is what lib/orderdoc stored. It is read defensively: an older
 * parser version, or a document it could only read in part, must not stop
 * the order from being derived. Null when it holds nothing usable.
 *
 * The header has no case name (sagsnavn), so caseName stays null. The
 * customer is the first printed line of the customer block (the name); the
 * delivery address is its lines joined with ", ". The list carries a delivery
 * week and no year: derive picks the year nearest the order's first scan.
 */
export function orderInfoFromDocument(
  orderNo: number,
  parsed: unknown,
  seen: SeenElement[] = [],
  rules: readonly ElementTypeRule[] = DEFAULT_ELEMENT_TYPE_RULES
): OrderInfo | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const doc = parsed as Partial<OrderDocument>;
  const header = (doc.header ?? {}) as Partial<OrderDocument["header"]>;
  const positions = Array.isArray(doc.positions) ? doc.positions : [];

  // Barcodes seen per (position, sub-position).
  const seenCount = new Map<string, Set<string>>();
  for (const s of seen) {
    if (s.position == null) continue;
    const key = `${s.position}:${subOf(s.subPosition)}`;
    const set = seenCount.get(key);
    if (set) set.add(s.barcode);
    else seenCount.set(key, new Set([s.barcode]));
  }
  const seenAt = (position: number, sub: number) => seenCount.get(`${position}:${sub}`)?.size ?? 0;

  const expected: ExpectedElement[] = [];
  const taken = new Set<string>();
  const line = (p: OrderPosition, subPosition: number, quantity: number): ExpectedElement => ({
    position: p.number,
    subPosition,
    quantity,
    elementTypeId: classifyElementType({ fields: Array.isArray(p.fields) ? p.fields : [] }, rules),
    system: typeof p.system === "string" && p.system.trim() ? p.system.trim() : null,
    widthMm: wholeMm(p.sizeWithoutCoupling?.width),
    heightMm: wholeMm(p.sizeWithoutCoupling?.height),
  });

  for (const p of positions) {
    if (!p || typeof p.number !== "number" || !Number.isFinite(p.number)) continue;
    const sub = p.subNumber == null ? 1 : p.subNumber + 1;
    const key = `${p.number}:${sub}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const quantity =
      typeof p.quantity === "number" && p.quantity > 0 ? Math.round(p.quantity) : Math.max(1, seenAt(p.number, sub));
    expected.push(line(p, sub, quantity));
  }

  // Scanned sub-positions with no line of their own: fall back on the position.
  for (const key of [...seenCount.keys()].sort()) {
    if (taken.has(key)) continue;
    const [position, sub] = key.split(":").map(Number);
    const fallback =
      positions.find((p) => p && p.number === position && p.subNumber == null) ??
      positions.find((p) => p && p.number === position);
    if (!fallback) continue;
    taken.add(key);
    expected.push(line(fallback, sub, seenAt(position, sub)));
  }

  const week = header.deliveryWeek;
  return {
    orderNo,
    customer: firstLine(header.customer),
    caseName: null,
    deliveryAddress: joined(header.deliveryAddress),
    deliveryWeek: typeof week === "number" && Number.isInteger(week) && week >= 1 && week <= 53 ? week : null,
    expectedElements: expected,
  };
}

/**
 * The element type rules stored in config.element_types: one rule object per
 * row in `recognition` (the rule's type is the row's id), read in sort order,
 * first match wins. Inactive rows and rows without a rule give none. An empty
 * table means the types were never set up: the built-in rules apply.
 */
export function rulesFromConfig(
  rows: { id: string; recognition: unknown; active: boolean }[]
): ElementTypeRule[] {
  if (rows.length === 0) return DEFAULT_ELEMENT_TYPE_RULES;
  const rules: ElementTypeRule[] = [];
  for (const row of rows) {
    if (!row.active || row.recognition == null || typeof row.recognition !== "object") continue;
    if (Array.isArray(row.recognition)) continue;
    const stored = row.recognition as Omit<ElementTypeRule, "type">;
    // A rule with no condition would match every position: it is no rule.
    const conditions = [stored.anyOpeningContains, stored.noOpeningContains, stored.minFields, stored.maxFields];
    if (conditions.every((c) => c == null)) continue;
    rules.push({ ...stored, type: row.id });
  }
  return rules;
}
