// Reads the week plan out of a 3E database file (.MDB). readWeekPlanTables
// is pure and tested; readWeekPlanFile opens the file with mdb-reader, in the
// browser or in Node. Docs: docs/ugeplan.md.
//
// The tables used, all keyed by ID_A_Kopf (the order's id):
//   A_Kopf        one row per order: AuNummer, A_Summe, Sachbearb1
//   A_KopfFreie   the order's free fields ("Frie felter", Feld1 to Feld36): all
//                 go to the "Frie felter" sheet; 2 or 3 "ja" is foil approved,
//                 4 is HTM (Partas in 3E), 6 the remark
//   A_Adresse     Nummer 0 is the customer
//   A_Planung     WocheW, the planned week as yyww
//   A_Vorgang     who created the offer and the order, for the initials
//   P_Allgemein   the position text (first line: the fields)
//   P_Technik     Stueck, SerieNr, PosZeit (minutes), AnzFlg (sashes), FSystem, P_Art
//   P_Element     one row per frame of a position, with its fields (Feldnummer)
//   P_Werkstoffe  the position's colours (Farbe1, Farbe2): two-sided is foil
//   P_Artikel     the articles, by supplier (Kreditor): "HTM" marks an HTM order
// P_Werkstoffe and P_Artikel are read when the file has them.

import { isFoilColour, orderFoil, positionFrameTypes, type PositionFacts } from "./classify";
import { FREE_FIELD_COUNT, type ElementType, type FrameBase, type TypeCount, type WeekPlan, type WeekPlanOrder } from "./types";

type Row = Record<string, unknown>;

export interface WeekPlanTables {
  A_Kopf: Row[];
  A_KopfFreie: Row[];
  A_Adresse: Row[];
  A_Planung: Row[];
  A_Vorgang: Row[];
  P_Allgemein: Row[];
  P_Technik: Row[];
  P_Element: Row[];
  P_Werkstoffe?: Row[];
  P_Artikel?: Row[];
}

type RequiredTable = Exclude<keyof WeekPlanTables, "P_Werkstoffe" | "P_Artikel">;
type OptionalTable = Exclude<keyof WeekPlanTables, RequiredTable>;

const FREE_FIELDS = Array.from({ length: FREE_FIELD_COUNT }, (_, i) => `Feld${i + 1}`);

/** The columns read from each table; mdb-reader skips the rest (images, blobs). */
export const WEEKPLAN_COLUMNS: Record<RequiredTable, string[]> = {
  A_Kopf: ["ID", "AuNummer", "A_Summe", "Sachbearb1"],
  A_KopfFreie: ["ID_A_Kopf", ...FREE_FIELDS],
  A_Adresse: ["ID_A_Kopf", "Nummer", "Firma", "Vorname", "Name"],
  A_Planung: ["ID_A_Kopf", "WocheW"],
  A_Vorgang: ["ID_A_Kopf", "Nummer", "Benutzer"],
  P_Allgemein: ["ID_A_Kopf", "Position", "Positionstext"],
  P_Technik: ["ID_A_Kopf", "Position", "Stueck", "SerieNr", "PosZeit", "AnzFlg", "FSystem", "Typnummer", "P_Art"],
  P_Element: ["ID_A_Kopf", "Position", "Ez", "Feldnummer"],
};

/** Read when the file has them; an older export without them still reads. */
export const OPTIONAL_COLUMNS: Record<OptionalTable, string[]> = {
  P_Werkstoffe: ["ID_A_Kopf", "Position", "Farbe1", "Farbe2"],
  P_Artikel: ["ID_A_Kopf", "Kreditor"],
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const blank = (s: string): boolean => s === "" || s === "(kein)";
/** Cut a text to the length the API takes (types.ts), so one long memo cannot fail the plan. */
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

function groupBy(rows: Row[], key = "ID_A_Kopf"): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const k = str(row[key]);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** The lines of a position text, without the carriage returns. */
function lines(text: unknown): string[] {
  return str(text).split(/\r?\n/).map((l) => l.trim());
}

/** yyww to [year, week]: 2648 to [2026, 48]. */
export function splitYearWeek(yyww: number): [number, number] | null {
  if (!Number.isInteger(yyww) || yyww < 100) return null;
  const week = yyww % 100;
  if (week < 1 || week > 53) return null;
  return [2000 + Math.floor(yyww / 100), week];
}

/**
 * The case handler's initials: 3E keeps the name ("Flemming B"), the office
 * writes initials ("fbv"). The initials are the user who created the offer or
 * the order most often among that handler's orders.
 */
function initialsByHandler(heads: Row[], events: Map<string, Row[]>): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const head of heads) {
    const handler = str(head.Sachbearb1);
    if (blank(handler)) continue;
    for (const e of events.get(str(head.ID)) ?? []) {
      if (!["_AngAnlage", "_AufAnlage"].includes(str(e.Nummer))) continue;
      const user = str(e.Benutzer).toLowerCase();
      if (!user) continue;
      const tally = votes.get(handler) ?? new Map<string, number>();
      tally.set(user, (tally.get(user) ?? 0) + 1);
      votes.set(handler, tally);
    }
  }
  const result = new Map<string, string>();
  for (const [handler, tally] of votes) {
    const [best] = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (best) result.set(handler, best[0]);
  }
  return result;
}

export function readWeekPlanTables(tables: WeekPlanTables, fileName: string | null = null): WeekPlan {
  const free = groupBy(tables.A_KopfFreie);
  const addresses = groupBy(tables.A_Adresse);
  const planning = groupBy(tables.A_Planung);
  const events = groupBy(tables.A_Vorgang);
  const general = groupBy(tables.P_Allgemein);
  const technical = groupBy(tables.P_Technik);
  const elements = groupBy(tables.P_Element);
  const materials = groupBy(tables.P_Werkstoffe ?? []);
  const articles = groupBy(tables.P_Artikel ?? []);
  const initials = initialsByHandler(tables.A_Kopf, events);

  const orders: WeekPlanOrder[] = [];
  for (const head of tables.A_Kopf) {
    const id = str(head.ID);
    const orderNo = num(head.AuNummer);
    if (!id || !Number.isInteger(orderNo) || orderNo <= 0) continue;

    const fields = (free.get(id) ?? [])[0] ?? {};
    const customerRow = (addresses.get(id) ?? []).find((a) => num(a.Nummer) === 0) ?? {};
    const customer =
      str(customerRow.Firma) || [str(customerRow.Vorname), str(customerRow.Name)].filter(Boolean).join(" ");
    const handler = str(head.Sachbearb1);
    const weekRaw = num((planning.get(id) ?? [])[0]?.WocheW);

    const texts = new Map<number, string[]>();
    for (const g of general.get(id) ?? []) texts.set(num(g.Position), lines(g.Positionstext));
    const foiledPosition = new Map<number, boolean>();
    for (const m of materials.get(id) ?? []) {
      foiledPosition.set(num(m.Position), isFoilColour(m.Farbe1) || isFoilColour(m.Farbe2));
    }
    const framesOf = new Map<number, Row[]>();
    for (const e of elements.get(id) ?? []) {
      const p = num(e.Position);
      framesOf.set(p, [...(framesOf.get(p) ?? []), e]);
    }

    const counts = new Map<string, TypeCount>();
    const unknown: string[] = [];
    const batches = new Set<number>();
    let minutes = 0;
    let elementCount = 0;
    let welds = 0;
    let looseParts = 0;
    let freight: string | null = null;
    let foiled = 0;
    let plain = 0;

    const positions = [...(technical.get(id) ?? [])].sort((a, b) => num(a.Position) - num(b.Position));
    for (const t of positions) {
      const position = num(t.Position);
      if (position <= 0) continue; // Position 0 holds the order's defaults.
      const [firstLine = "", secondLine = ""] = texts.get(position) ?? [];
      const pieces = Math.max(0, Math.round(num(t.Stueck)));
      const typeNumber = str(t.Typnummer);
      minutes += pieces * Math.max(0, num(t.PosZeit));

      // P_Art 3: an article line (freight, cylinder, fitting), no element.
      if (num(t.P_Art) === 3) {
        if (/^fragt/i.test(typeNumber) && !freight) freight = cut(firstLine.replace(/^\d+\s*\(kein\)\s*/, ""), 500) || null;
        continue;
      }
      if (/^fyldning/i.test(typeNumber)) {
        looseParts += pieces;
        continue;
      }
      const serie = num(t.SerieNr);
      if (serie > 0) batches.add(serie);

      const frames = (framesOf.get(position) ?? []).sort((a, b) => num(a.Ez) - num(b.Ez));
      if (frames.length === 0) continue;
      elementCount += pieces * frames.length;
      welds += pieces * (frames.length + Math.max(0, Math.round(num(t.AnzFlg))));
      if (foiledPosition.get(position)) foiled += pieces * frames.length;
      else plain += pieces * frames.length;

      const facts: PositionFacts = { firstLine, secondLine, system: str(t.FSystem) || null, typeNumber: typeNumber || null };
      for (const ft of positionFrameTypes(facts, frames.map((f) => str(f.Feldnummer)))) {
        if (!ft) {
          unknown.push(cut(`Pos. ${position}: ${firstLine || typeNumber || "uden tekst"}`, 200));
          continue;
        }
        const key = `${ft.type}|${ft.base}`;
        const entry = counts.get(key) ?? { type: ft.type as ElementType, base: ft.base as FrameBase, count: 0 };
        entry.count += pieces;
        counts.set(key, entry);
      }
    }

    const remark = str(fields.Feld6);
    const htmStatus = str(fields.Feld4);
    const htmArticles = (articles.get(id) ?? []).some((a) => str(a.Kreditor).toUpperCase() === "HTM");
    const htm = htmArticles || htmStatus ? ["HTM", htmStatus.toLowerCase()].filter(Boolean).join(" ") : null;
    const freeFields: Record<string, string> = {};
    FREE_FIELDS.forEach((name, i) => {
      const value = str(fields[name]);
      if (!blank(value)) freeFields[String(i + 1)] = cut(value, 2000);
    });
    orders.push({
      orderNo,
      customer: cut(customer, 200),
      responsible: cut(initials.get(handler) ?? (blank(handler) ? "" : handler), 100),
      amount: head.A_Summe == null ? null : num(head.A_Summe),
      remark: cut(remark, 2000) || null,
      foilApproved: [fields.Feld2, fields.Feld3].some((v) => str(v).toLowerCase() === "ja"),
      foil: foiledPosition.size > 0 ? orderFoil(foiled, plain) : null,
      htm: htm ? cut(htm, 200) : null,
      freeFields,
      hours: Math.round((minutes / 60) * 10) / 10,
      batches: [...batches].sort((a, b) => a - b),
      freight,
      types: [...counts.values()],
      elements: Math.round(elementCount),
      welds: Math.round(welds),
      week: weekRaw > 0 ? weekRaw : null,
      unknown: [...new Set(unknown)].slice(0, 500),
      looseParts: Math.round(looseParts),
    });
  }
  orders.sort((a, b) => a.orderNo - b.orderNo);

  // The week of the plan: the one most orders are planned in.
  const tally = new Map<number, number>();
  for (const o of orders) if (o.week) tally.set(o.week, (tally.get(o.week) ?? 0) + 1);
  const [top] = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const yearWeek = top ? splitYearWeek(top[0]) : null;

  return { year: yearWeek?.[0] ?? null, week: yearWeek?.[1] ?? null, fileName, orders };
}

/** Thrown when the file is no 3E database: a table the plan needs is missing. */
export class NotA3EDatabaseError extends Error {
  constructor(readonly missing: string[]) {
    super(`Filen mangler tabellerne ${missing.join(", ")}.`);
    this.name = "NotA3EDatabaseError";
  }
}

/**
 * Opens an .MDB file and reads the plan. `bytes` is the whole file. In the
 * browser mdb-reader wants a global Buffer; the caller sets one (see
 * components/weekplan/weekplan-upload.tsx).
 */
export async function readWeekPlanFile(bytes: Uint8Array, fileName: string | null = null): Promise<WeekPlan> {
  const { default: MDBReader } = await import("mdb-reader");
  const reader = new MDBReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const names = new Set(reader.getTableNames());
  const wanted = Object.keys(WEEKPLAN_COLUMNS) as RequiredTable[];
  const missing = wanted.filter((t) => !names.has(t));
  if (missing.length > 0) throw new NotA3EDatabaseError(missing);

  const tables = {} as WeekPlanTables;
  for (const name of wanted) {
    const table = reader.getTable(name);
    const present = new Set(table.getColumnNames());
    tables[name] = table.getData({ columns: WEEKPLAN_COLUMNS[name].filter((c) => present.has(c)) }) as Row[];
  }
  for (const name of Object.keys(OPTIONAL_COLUMNS) as OptionalTable[]) {
    if (!names.has(name)) continue;
    const table = reader.getTable(name);
    const present = new Set(table.getColumnNames());
    tables[name] = table.getData({ columns: OPTIONAL_COLUMNS[name].filter((c) => present.has(c)) }) as Row[];
  }
  return readWeekPlanTables(tables, fileName && cut(fileName, 260));
}
