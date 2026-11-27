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

// "B S", "BS", "BS tegninger", "BS-tegning", "B_S_tegninger" ...: spaces, "_" and "-" may stand between
// B, S and "tegning(er)", any number of them.
const LABEL = String.raw`B[ _\-]*S(?:[ _\-]*tegning(?:er)?)?`;
/** A label that ends the name: "58931_20261127BS", "58931_20261127 BS tegninger", "58931_20261127_BS". */
const TRAILING_LABEL = new RegExp(String.raw`^(?<rest>.*\d)[ _\-]*(?<label>${LABEL})$`, "i");
/**
 * A label right after the date with more behind it: "58931_20261127BS (1)", "58931_20261127BS - Kopi",
 * "58931_20261127BS tegninger rev2". Whatever follows, the file is a BS file and never the list.
 */
const LABEL_AFTER_DATE = new RegExp(String.raw`^(?<rest>.*_\d{8})[ _\-]*(?<label>${LABEL})`, "i");
/** The order and what stands around it: "<head><order>_<last>", where the last part has no "_". */
const ORDER_AND_LAST = new RegExp(String.raw`^(?<head>.*?)(?<order>\d+)\s*_(?<last>[^_]*)$`);
/**
 * A label before the order: a prefix part of its own ("BS_", "BS_tegninger_", "B_S_") or the text right
 * before the number ("B S tegninger 58931", "B  S 58931", "BS-58931"). Not the end of another prefix ("ABS_").
 */
const LEADING_LABEL = new RegExp(String.raw`(?<=^|_) *(?<label>${LABEL})(?:[ _\-]*_|[ \-]+$)`, "gi");

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
 * A BS label after the date, before the order or as a part of its own makes it a BS file, also when a
 * copy mark or other text follows the label after the date ("58931_20261127BS (1).pdf").
 * Null when the name is not an order document: no ".pdf", no order, or two numbers before the date.
 */
export function parseOrderFileName(name: string): OrderFileName | null {
  const m = /^([^\\/]+)\.pdf$/i.exec(name);
  if (!m) return null;
  let stem = m[1].trim();
  let kind: OrderFileKind | null = null;

  const tail = TRAILING_LABEL.exec(stem) ?? LABEL_AFTER_DATE.exec(stem);
  if (tail?.groups) {
    kind = kindOf(tail.groups.label);
    stem = tail.groups.rest;
  }

  const found = ORDER_AND_LAST.exec(stem);
  if (!found?.groups) return null;
  const { head, order: orderPart, last } = found.groups;
  for (const lead of head.matchAll(LEADING_LABEL)) kind = strongest(kind, kindOf(lead.groups!.label));
  // What is left of the head is the prefix parts, each ending in "_" and holding a letter.
  const rest = head.replace(LEADING_LABEL, "").trimEnd();
  if (rest !== "" && !rest.endsWith("_")) return null;
  const prefixes = rest === "" ? [] : rest.slice(0, -1).split("_");
  if (prefixes.some((p) => !/\p{L}/u.test(p))) return null;
  if (!/^0*\d{1,9}$/.test(orderPart)) return null;
  const orderNumber = Number(orderPart);
  if (orderNumber > 2147483647) return null;
  return {
    orderNumber,
    prefix: prefixes.join("_"),
    printDate: parseCompactDate(last.trim()),
    kind: kind ?? "list",
  };
}

/** "20261127" as "2026-11-27". Null when it is no real date. */
export function parseCompactDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Built in two steps: Date.UTC reads a year below 100 as 19xx.
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year, month - 1, day);
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
