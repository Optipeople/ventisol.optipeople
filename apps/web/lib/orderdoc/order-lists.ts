// Which files give an order its positions. Pure.
//
// An order with arched or bevelled elements ("bue/skrå", BS) has its positions
// in two files: the production list holds the ordinary ones, the BS list the
// BS ones alone (order 58931: the list has positions 1 and 3, the BS list
// position 2). So an order's positions are
//
//   the newest list's positions
//   plus the positions of the newest BS list that the list does not have.
//
// The rules, the same in SQL (rpt.order_positions and its helpers, migration
// 20261127100000_bs_positions.sql):
//
//   - The kind of a stored file is read from its prefix: the sync writes "BS"
//     and "BS tegninger" there, after any prefix of the order ("BE_BS").
//   - The list always wins: a position in both files is the list's. Positions
//     are the same when their number and sub-number are ("5" is not "5.1").
//   - The newest list: newest print_date, then newest synced_at, then the file
//     name. As before the BS files were known.
//   - The newest BS list: the date in its file name (the first "_" followed by
//     exactly eight digits that make a date), else the "Dato" printed in its
//     header, newest first; a BS list with neither comes last. Then newest
//     synced_at, then the file name. A BS file has no print_date in the
//     database on purpose (lib/sync/documents.ts), so that is not used.
//   - An order with a BS list and no list: the BS positions are its positions,
//     and the BS list gives its header (customer, delivery week).
//   - BS drawings never give positions or a header.
//   - Only parsed files count.

import { type OrderFileKind, parseCompactDate } from "./file-name";

/** The kind of a stored file, from the prefix the sync wrote (raw.order_documents.prefix). */
export function kindOfPrefix(prefix: string | null | undefined): OrderFileKind {
  const p = (prefix ?? "").trim();
  if (/(^|_)BS tegninger$/i.test(p)) return "bs-drawings";
  if (/(^|_)BS$/i.test(p)) return "bs";
  return "list";
}

const NAME_DATE = /_(\d{8})(?!\d)/;

/** The date a BS list is ranked by, as an ISO date: the one in its file name, else its header's. */
export function bsListDate(fileName: string, headerDate: unknown): string | null {
  const inName = NAME_DATE.exec(fileName);
  const fromName = inName ? parseCompactDate(inName[1]) : null;
  if (fromName) return fromName;
  if (typeof headerDate !== "string") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(headerDate.trim());
  return iso ? parseCompactDate(`${iso[1]}${iso[2]}${iso[3]}`) : null;
}

/** What picking needs to know of a stored file. */
export interface ListCandidate {
  fileName: string;
  prefix: string | null;
  /** print_date as an ISO date or timestamp. Null for every BS file. */
  printDate: string | null;
  /** synced_at as an ISO timestamp. */
  syncedAt: string | null;
  /** "Dato" of the parsed header. */
  headerDate: unknown;
  /** False for a file not parsed yet, or one the parser could make nothing of. */
  parsed: boolean;
}

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first: by `date` (none last), then synced_at, then the file name. */
function newest<D extends ListCandidate>(docs: D[], dateOf: (d: D) => string | null): D | null {
  let best: D | null = null;
  let bestDate: string | null = null;
  for (const d of docs) {
    const date = dateOf(d);
    if (best === null) {
      [best, bestDate] = [d, date];
      continue;
    }
    const byDate = (date ?? "").localeCompare(bestDate ?? "");
    const order = byDate || time(d.syncedAt) - time(best.syncedAt) || (d.fileName > best.fileName ? 1 : -1);
    if (order > 0) [best, bestDate] = [d, date];
  }
  return best;
}

/** The newest parsed list and the newest parsed BS list among the files of ONE order. */
export function pickOrderLists<D extends ListCandidate>(docs: readonly D[]): { list: D | null; bs: D | null } {
  const parsed = docs.filter((d) => d.parsed);
  return {
    list: newest(
      parsed.filter((d) => kindOfPrefix(d.prefix) === "list"),
      (d) => d.printDate?.slice(0, 10) ?? null
    ),
    bs: newest(
      parsed.filter((d) => kindOfPrefix(d.prefix) === "bs"),
      (d) => bsListDate(d.fileName, d.headerDate)
    ),
  };
}

interface Labelled {
  number?: unknown;
  subNumber?: unknown;
}

const labelKey = (p: Labelled) => `${p.number ?? ""}:${p.subNumber ?? ""}`;

/** The list's positions, then the BS positions the list does not have (by number and sub-number). */
export function mergeBsPositions<P extends Labelled>(list: readonly P[], bs: readonly P[]): P[] {
  const taken = new Set(list.filter((p) => p != null && typeof p === "object").map(labelKey));
  return [...list, ...bs.filter((p) => p != null && typeof p === "object" && !taken.has(labelKey(p)))];
}
