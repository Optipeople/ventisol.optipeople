// Text chunks of an order document for search (doc.document_chunks). A chunk stands alone: each
// starts with the order's header facts and its position. The text is Danish, as printed.

import { type ElementTypeRule, DEFAULT_ELEMENT_TYPE_RULES, classifyElementType, elementTypeName } from "./element-types";
import type { HardwareRow, OrderDocument, OrderPosition } from "./types";

export interface SearchChunk {
  /** Position number. */
  position: number;
  /** 0-based, within the position. */
  chunkIndex: number;
  content: string;
}

/** A chunk's body is cut near this many characters, at a line break. */
const MAX_BODY = 1500;

const given = (parts: (string | null | false | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p.length > 0);

// "2026-10-22" as printed: "22-10-2026".
const danishDate = (iso: string) => iso.split("-").reverse().join("-");

function headerLines(doc: OrderDocument): string[] {
  const h = doc.header;
  return given([
    given([
      h.orderNumber !== null && `Ordre ${h.orderNumber}`,
      h.deliveryWeek !== null && `Lev. uge ${h.deliveryWeek}`,
      h.date !== null && `Dato ${danishDate(h.date)}`,
      h.caseHandler !== null && `Sagsbeh. ${h.caseHandler}`,
    ]).join(". "),
    h.customer.length > 0 && `Kunde: ${h.customer.join(", ")}`,
    h.deliveryAddress.length > 0 && `Lev. adr.: ${h.deliveryAddress.join(", ")}`,
    h.packageInfo !== null && `Pakke info: ${h.packageInfo}`,
    h.glassDelivery !== null && `Glas lev.: ${h.glassDelivery}`,
  ]);
}

function positionLine(p: OrderPosition, typeName: string): string {
  return given([
    `Position ${p.label || p.number}`,
    typeName,
    p.system !== null && `System ${p.system}`,
    p.quantity !== null && `Antal ${p.quantity}`,
  ]).join(". ");
}

function elementLines(p: OrderPosition): string[] {
  const lines = given([
    given([
      p.frameColour !== null && `Farve karm: ${p.frameColour}`,
      p.sashColour !== null && `Farve ramme: ${p.sashColour}`,
      p.sealColour !== null && `Farve tætning: ${p.sealColour}`,
    ]).join(". "),
    given([
      p.sizeWithoutCoupling !== null && `Mål u/kobling: ${p.sizeWithoutCoupling.text}`,
      p.weightKg !== null && `Ca. ${String(p.weightKg).replace(".", ",")} kg pr. element`,
      p.frameHoles !== null && `Karmhuller: ${p.frameHoles}`,
    ]).join(". "),
    p.notes.length > 0 && `Bemærkning: ${p.notes.join(" ")}`,
  ]);
  for (const f of p.fields) {
    lines.push(
      given([
        `Felt ${f.number}: ${f.opening ?? "uden åbningsfunktion"}`,
        f.frameSize !== null && `Rammemål ${f.frameSize}`,
        f.glassType.length > 0 && `Glastype: ${f.glassType.join(", ")}`,
        ...f.panes.map((g) =>
          given([
            g.quantity !== null && `${g.quantity} stk`,
            g.size !== null && `glasmål ${g.size}`,
            g.glassList !== null && `glasliste ${g.glassList}`,
          ]).join(" "),
        ),
        f.seals.length > 0 && `Tætning ${f.seals.join(", ")}`,
      ]).join(". "),
    );
  }
  for (const b of p.fieldBars) {
    const label = b.field !== null ? `Sprosse felt ${b.field}` : "Sprosse";
    lines.push(given([`${label}: ${b.description}`, b.colour, b.side, b.length]).join(" "));
  }
  return lines;
}

function hardwareLines(rows: HardwareRow[]): string[] {
  const lines: string[] = [];
  let group: string | null = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`${group === "Beskrivelse" ? "Beslag" : group}:`);
    }
    lines.push(
      given([r.description, r.colour, r.quantity !== null && `${r.quantity} stk`, r.size, r.mounting, r.placement]).join(", "),
    );
  }
  return lines;
}

function cuttingLines(p: OrderPosition): string[] {
  if (p.cutting.length === 0) return [];
  const lines = ["Afkortning:"];
  for (const c of p.cutting)
    lines.push(
      given([
        c.section,
        c.profile,
        c.width !== null && `bredde ${c.width}`,
        c.quantity !== null && `${c.quantity} stk`,
        c.length !== null && `længde ${c.length}`,
        c.side,
        c.steel !== null && `stål ${c.steel}`,
        c.steelLength,
        c.field !== null && `felt ${c.field}`,
      ]).join(" "),
    );
  return lines;
}

// Lines into bodies of at most about MAX_BODY characters, cut between lines.
function pack(lines: string[]): string[] {
  const bodies: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > MAX_BODY) {
      bodies.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) bodies.push(current.join("\n"));
  return bodies;
}

/**
 * Chunks for search, in document order. Per position: the element itself (colours, sizes, fields,
 * openings, glass, notes), then hardware and accessories, then the cutting list, each in one or
 * more chunks. Every chunk starts with the header facts and the position line. Pure.
 */
export function toSearchChunks(
  doc: OrderDocument,
  rules: readonly ElementTypeRule[] = DEFAULT_ELEMENT_TYPE_RULES,
): SearchChunk[] {
  const head = headerLines(doc);
  const chunks: SearchChunk[] = [];
  for (const p of doc.positions) {
    const intro = [...head, positionLine(p, elementTypeName(classifyElementType(p, rules)))].join("\n");
    const bodies = [
      ...pack(elementLines(p)),
      ...pack(hardwareLines([...p.hardware, ...p.accessories])),
      ...pack(cuttingLines(p)),
    ];
    if (bodies.length === 0) bodies.push("");
    bodies.forEach((body, chunkIndex) =>
      chunks.push({ position: p.number, chunkIndex, content: body.length > 0 ? `${intro}\n${body}` : intro }),
    );
  }
  return chunks;
}
