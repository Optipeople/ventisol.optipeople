// The name 3E gives an order's PDF: "<order>_<yyyyMMdd>.pdf", or with a prefix for special orders,
// "BE_<order>_<yyyyMMdd>.pdf". Orders with arched or bevelled elements ("bue/skrå", BS) also have a
// production list of those positions alone and a file of their drawings, named by Ventisol:
// "58931_20261127BS.pdf" and "58931_20261127BS tegninger.pdf" since 27-11-2026, "B S 58931_20261112.pdf"
// and "B S tegninger 58931_20261112.pdf" before. The same rules as the station app's
// OrderDocumentLocator (docs/order-documents.md, "Where the files are").

/** "list": the order's production list. "bs": the list of its BS positions. "bs-drawings": their drawings. */
export type OrderFileKind = "list" | "bs" | "bs-drawings";

export interface OrderFileName {
  orderNumber: number;
  /** "BE", "TE", "RKK" ..., or "BE_X" when there are several parts. Empty for an ordinary order. Never the BS label. */
  prefix: string;
  /** The print date in the name as an ISO date, "2026-10-22". Null when the last part is no date. */
  printDate: string | null;
  kind: OrderFileKind;
}

/** The label a kind carries in a file name: "BS", "BS tegninger", or empty for the list. */
export function kindLabel(kind: OrderFileKind): string {
  return kind === "bs" ? "BS" : kind === "bs-drawings" ? "BS tegninger" : "";
}

// "B S", "BS", "BS tegninger", "BS-tegning" ...
const LABEL = String.raw`B ?S(?:[ \-]*tegning(?:er)?)?`;
/** A label after the date: "58931_20261127BS", "58931_20261127 BS tegninger", "58931_20261127_BS". */
const TRAILING_LABEL = new RegExp(String.raw`^(.*\d)[ _\-]*(${LABEL})$`, "i");
/** A label before the order, in the same part: "B S tegninger 58931". */
const LEADING_LABEL = new RegExp(String.raw`^(${LABEL})[ \-]+(\d+)$`, "i");
const WHOLE_LABEL = new RegExp(String.raw`^${LABEL}$`, "i");

const RANK: Record<OrderFileKind, number> = { list: 0, bs: 1, "bs-drawings": 2 };

function kindOf(label: string): OrderFileKind {
  return /tegning/i.test(label) ? "bs-drawings" : "bs";
}

/** Two labels in one name: the drawings say more. */
function strongest(a: OrderFileKind | null, b: OrderFileKind): OrderFileKind {
  return a !== null && RANK[a] > RANK[b] ? a : b;
}

/**
 * Reads a file name (no folders). The name is parts split by "_": the last is the date, the one
 * before it the order (all digits), and every part before that is a prefix that must hold a letter.
 * A BS label after the date, before the order or as a part of its own makes it a BS file.
 * Null when the name is not an order document: no ".pdf", no order, or two numbers before the date.
 */
export function parseOrderFileName(name: string): OrderFileName | null {
  const m = /^([^\\/]+)\.pdf$/i.exec(name);
  if (!m) return null;
  let stem = m[1].trim();
  let kind: OrderFileKind | null = null;

  const tail = TRAILING_LABEL.exec(stem);
  if (tail) {
    kind = kindOf(tail[2]);
    stem = tail[1];
  }

  const parts = stem.split("_");
  if (parts.length < 2) return null;
  let orderPart = parts[parts.length - 2].trim();
  const lead = LEADING_LABEL.exec(orderPart);
  if (lead) {
    kind = strongest(kind, kindOf(lead[1]));
    orderPart = lead[2];
  }
  const prefixes: string[] = [];
  for (const p of parts.slice(0, -2)) {
    if (WHOLE_LABEL.test(p.trim())) kind = strongest(kind, kindOf(p));
    else if (/\p{L}/u.test(p)) prefixes.push(p);
    else return null;
  }
  if (!/^0*\d{1,9}$/.test(orderPart)) return null;
  const orderNumber = Number(orderPart);
  if (orderNumber > 2147483647) return null;
  return {
    orderNumber,
    prefix: prefixes.join("_"),
    printDate: parseCompactDate(parts[parts.length - 1].trim()),
    kind: kind ?? "list",
  };
}

function parseCompactDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Built in two steps: Date.UTC reads a year below 100 as 19xx.
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year, month - 1, day);
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
