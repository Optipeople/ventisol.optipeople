// Element types: what kind of element a position is, worked out from its fields' opening
// functions and how many fields it has. The rules are data, so they can be stored in
// config.element_types.recognition and edited by an admin.

import type { OrderDocument, OrderPosition } from "./types";

export const ELEMENT_TYPES = [
  { id: "vindue-1-fag", name: "Vindue 1 fag" },
  { id: "vindue-2-fag", name: "Vindue 2 fag" },
  { id: "vindue-3-fag", name: "Vindue 3 fag eller flere" },
  { id: "doer", name: "Dør" },
  { id: "terrassedoer", name: "Terrassedør" },
  { id: "andet", name: "Andet" },
] as const;

export type ElementTypeId = (typeof ELEMENT_TYPES)[number]["id"];

/** The type a position gets when no rule matches. */
export const FALLBACK_ELEMENT_TYPE: ElementTypeId = "andet";

/**
 * One rule. Every condition given must hold. A rule with none matches every position.
 * Text is compared without regard to case.
 */
export interface ElementTypeRule {
  /** The type id this rule gives. A string, so an admin can add more types than the built-in ones. */
  type: string;
  /** Holds when the opening function of at least one field contains one of these texts. */
  anyOpeningContains?: string[];
  /** Holds when no field has an opening function that contains any of these texts. */
  noOpeningContains?: string[];
  /** Holds when the position has at least this many fields. */
  minFields?: number;
  /** Holds when the position has at most this many fields. */
  maxFields?: number;
}

/**
 * Read top to bottom, the first rule that matches wins. Doors come before windows, so a door with
 * fixed side fields ("Fast karm | Facadedør | Fast karm") is a door, and a two-leaf door is one
 * door. The terrace door comes before the other doors, as its name holds "dør" too.
 * "Industri dør" is also written in two words in the samples, which "dør" covers.
 */
export const DEFAULT_ELEMENT_TYPE_RULES: ElementTypeRule[] = [
  { type: "terrassedoer", anyOpeningContains: ["terrassedør", "terrasse dør"] },
  { type: "doer", anyOpeningContains: ["dør"] },
  { type: "vindue-1-fag", minFields: 1, maxFields: 1 },
  { type: "vindue-2-fag", minFields: 2, maxFields: 2 },
  { type: "vindue-3-fag", minFields: 3 },
];

const contains = (openings: string[], texts: unknown): boolean =>
  Array.isArray(texts) &&
  texts.some((t) => typeof t === "string" && t.trim().length > 0 && openings.some((o) => o.includes(t.trim().toLowerCase())));

function matches(rule: ElementTypeRule, openings: string[], fieldCount: number): boolean {
  if (rule.anyOpeningContains !== undefined && !contains(openings, rule.anyOpeningContains)) return false;
  if (rule.noOpeningContains !== undefined && contains(openings, rule.noOpeningContains)) return false;
  if (typeof rule.minFields === "number" && fieldCount < rule.minFields) return false;
  if (typeof rule.maxFields === "number" && fieldCount > rule.maxFields) return false;
  return true;
}

/** The type id of a position: the first rule that matches, else "andet". */
export function classifyElementType(
  position: Pick<OrderPosition, "fields">,
  rules: readonly ElementTypeRule[] = DEFAULT_ELEMENT_TYPE_RULES,
): string {
  const openings = position.fields.map((f) => (f.opening ?? "").toLowerCase());
  for (const rule of rules) {
    if (!rule || typeof rule.type !== "string" || rule.type.length === 0) continue;
    if (matches(rule, openings, position.fields.length)) return rule.type;
  }
  return FALLBACK_ELEMENT_TYPE;
}

/** The Danish name of a built-in type id. An id that is not built in comes back as it is. */
export function elementTypeName(id: string): string {
  return ELEMENT_TYPES.find((t) => t.id === id)?.name ?? id;
}

export interface ExpectedElement {
  /** Position number, as in the barcode. */
  position: number;
  subNumber: number | null;
  /** As printed: "5". */
  label: string;
  /** "Antal": how many elements of this position. Null when it could not be read. */
  quantity: number | null;
  type: string;
}

export interface ExpectedElements {
  elements: ExpectedElement[];
  /**
   * The sum of Antal over the positions: the number of elements to pack before the order is
   * done. Null when it is not known: no positions, or a position without a readable Antal.
   */
  total: number | null;
}

/** The elements an order consists of, a line per position. */
export function expectedElements(
  doc: Pick<OrderDocument, "positions">,
  rules: readonly ElementTypeRule[] = DEFAULT_ELEMENT_TYPE_RULES,
): ExpectedElements {
  const elements = doc.positions.map(
    (p): ExpectedElement => ({
      position: p.number,
      subNumber: p.subNumber,
      label: p.label,
      quantity: p.quantity,
      type: classifyElementType(p, rules),
    }),
  );
  const known = elements.length > 0 && elements.every((e) => e.quantity !== null);
  return { elements, total: known ? elements.reduce((sum, e) => sum + (e.quantity ?? 0), 0) : null };
}
