// What kind of element a 3E position is, from its first text line ("TS",
// "SH V / FR / SH H", "16 * FK / DK HI / DK VI"), its system and its frames.
// Pure. Docs: docs/ugeplan.md ("Elementtyper").
//
// The first line lists the position's fields in order, "n * X" for n of the
// same. Each frame (P_Element) says which fields it holds (Feldnummer
// "00~00~04~00": fields 0 and 4). A frame is typed by its opening parts, that
// is every part but a fixed light (FK): none is a fixed frame, one is that
// part's type, two or more the "DB" (double) type.

import type { ElementType, FrameBase } from "./types";

export type PartCode = "FK" | "FR" | "BH" | "ID" | "FD" | "TD" | "DK" | "TS" | "SH";

export interface Part {
  code: PartCode | null;
  /** The part as printed: "DK HI". */
  text: string;
}

/** "2 * FK / ID" to FK, FK, ID. */
export function parseParts(line: string): Part[] {
  const parts: Part[] = [];
  for (const raw of line.split("/")) {
    const piece = raw.trim();
    if (!piece) continue;
    const repeat = /^(\d+)\s*\*\s*(.+)$/.exec(piece);
    const count = repeat ? Number(repeat[1]) : 1;
    const body = (repeat ? repeat[2] : piece).trim();
    const part = { code: partCode(body), text: body };
    for (let i = 0; i < Math.min(count, 500); i++) parts.push(part);
  }
  return parts;
}

function partCode(text: string): PartCode | null {
  const t = text.toUpperCase();
  if (/^FK\b/.test(t)) return "FK";
  if (/^FR\b/.test(t)) return "FR";
  if (/^BH\b/.test(t)) return "BH";
  if (/^ID\b/.test(t)) return "ID";
  if (/^FD\b/.test(t)) return "FD";
  if (/^TD\b/.test(t)) return "TD";
  if (/^DK\b/.test(t)) return "DK";
  if (/^TS\b/.test(t)) return "TS";
  if (/^SH\b/.test(t) || /^SIDEH/.test(t)) return "SH";
  return null;
}

/** "00~00~04~00~08~00" to [0, 4, 8]: every other number is a field. */
export function frameFields(feldnummer: string | null | undefined): number[] {
  if (!feldnummer) return [];
  const numbers = feldnummer.split("~").map((s) => Number(s));
  const fields: number[] = [];
  for (let i = 0; i < numbers.length; i += 2) if (Number.isInteger(numbers[i])) fields.push(numbers[i]);
  return fields;
}

export interface PositionFacts {
  /** First line of the position text. */
  firstLine: string;
  /** Second line: "ID F VU alu", "TD HU 105T alu". */
  secondLine: string;
  /** FSystem: "70 mm DANLINE", "70 mm SV & SJV". */
  system: string | null;
  /** Typnummer: "S70Scan type10B". */
  typeNumber: string | null;
}

export interface FrameType {
  type: ElementType;
  base: FrameBase;
}

const SCAN_TYPES = new Set(["26", "10", "16", "20", "41"]);

/** Opens inwards: HI, VI, H.I., V.I. */
const INWARD = /\b[HV]\.?\s?I\b\.?/;

/**
 * The type of one frame holding `parts`, or null when no part is known.
 * `facts` is the position the frame belongs to.
 */
export function frameType(parts: Part[], facts: PositionFacts): FrameType | null {
  const system = (facts.system ?? "").toUpperCase();
  const danline = system.includes("DANLINE");
  const svSystem = system.includes("SV & SJV") || system.includes("SV&SJV");

  const scan = /scan\s*type\s*(\d+)/i.exec(facts.typeNumber ?? "");
  if (scan && SCAN_TYPES.has(scan[1])) return { type: `T${scan[1]}` as ElementType, base: "T" };

  if (parts.length === 0 || parts.some((p) => p.code === null)) return null;
  const openings = parts.filter((p) => p.code !== "FK");
  if (openings.length === 0) return { type: svSystem ? "FK S" : danline ? "FK DL" : "FK", base: "FK" };

  const lead = openings.find((p) => p.code !== "FR");
  if (!lead) return { type: svSystem ? "FK S" : danline ? "FK DL" : "FK", base: "FK" };
  const double = openings.length >= 2;
  const db = (single: ElementType, two: ElementType) => (double ? two : single);

  switch (lead.code) {
    case "BH":
      return { type: "SV", base: "SV" };
    case "ID":
      return /\balu\b/i.test(facts.secondLine)
        ? { type: db("FD/ID", "DB FD/ID"), base: "ID" }
        : { type: db("SD", "DB SD"), base: "ID" };
    case "FD":
      return { type: db("FD/ID", "DB FD/ID"), base: "FD" };
    case "TD":
      return INWARD.test(lead.text) || INWARD.test(facts.secondLine)
        ? { type: db("DK TD", "DB DK TD"), base: "TD" }
        : { type: db("TD", "DB TD"), base: "TD" };
    case "DK":
      return { type: db("DK", "DB DK"), base: "DK" };
    case "TS":
      return { type: db("TS", "DB TS"), base: "TS" };
    case "SH":
      // A side hung sash outside Danline is the industrial turn window.
      return danline ? { type: db("SH", "DB SH"), base: "SH" } : { type: db("DK", "DB DK"), base: "DK" };
    default:
      return null;
  }
}

/**
 * The types of a position's frames, one entry per frame (`frames` is each
 * frame's Feldnummer). When the fields do not add up to the parts, every
 * frame is typed on all of them.
 */
export function positionFrameTypes(facts: PositionFacts, frames: string[]): (FrameType | null)[] {
  const parts = parseParts(facts.firstLine);
  const fieldsPerFrame = frames.map(frameFields);
  const total = fieldsPerFrame.reduce((n, f) => n + f.length, 0);
  const fits = frames.length > 1 && total === parts.length && fieldsPerFrame.every((f) => f.every((i) => i < parts.length));
  return fieldsPerFrame.map((fields) => frameType(fits ? fields.map((i) => parts[i]) : parts, facts));
}

/** Kontor's count columns, from the element types. */
export const OFFICE_GROUPS = {
  doubleDoors: ["DB SD", "DB FD/ID", "DB TD", "DB DK TD"],
  doors: ["SD", "FD/ID", "TD", "DK TD", "KS dør"],
  turnTilt: ["DK", "DB DK", "FK", "T26", "T10", "T16", "T20", "T41", "TV"],
  danline: ["TS", "DB TS", "FK DL", "SH", "DB SH"],
  sv: ["SV", "FK S"],
} as const satisfies Record<string, readonly ElementType[]>;

export type ProductionGroup = "sv" | "stableDoors" | "facadeDoors" | "turnTiltFixed" | "danline" | "scan";

/** Kim's count columns: by the frame's leading part, so an industrial door is a stable door. */
export function productionGroup(t: { type: ElementType; base: FrameBase }): ProductionGroup {
  if (t.base === "SV") return "sv";
  if (t.base === "T") return "scan";
  if (t.base === "ID") return "stableDoors";
  if (t.type === "DK TD" || t.type === "DB DK TD") return "turnTiltFixed";
  if (t.base === "FD" || t.base === "TD") return "facadeDoors";
  if (t.base === "TS" || t.base === "SH" || t.type === "FK DL") return "danline";
  return "turnTiltFixed";
}

/** Welds per element of a type: one per frame and one per sash. The BKS sheet's "Antal svejsninger" row. */
export const WELDS_PER_TYPE: Record<ElementType, number> = {
  SV: 2,
  "FK S": 1,
  SD: 2,
  "DB SD": 3,
  "FD/ID": 2,
  "DB FD/ID": 3,
  TD: 2,
  "DB TD": 3,
  "DK TD": 2,
  "DB DK TD": 3,
  FK: 1,
  DK: 2,
  "DB DK": 3,
  "KS dør": 2,
  TS: 2,
  "DB TS": 3,
  "FK DL": 1,
  SH: 2,
  "DB SH": 3,
  TV: 2,
  T26: 2,
  T10: 2,
  T16: 2,
  T20: 2,
  T41: 2,
};
