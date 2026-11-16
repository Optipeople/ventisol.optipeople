// The name 3E gives an order's PDF: "<order>_<yyyyMMdd>.pdf", or with a prefix for special orders,
// "BE_<order>_<yyyyMMdd>.pdf". The same rules as the station app's OrderDocumentLocator
// (docs/order-documents.md, "Where the files are").

export interface OrderFileName {
  orderNumber: number;
  /** "BE", "TE", "RKK" ..., or "BE_X" when there are several parts. Empty for an ordinary order. */
  prefix: string;
  /** The print date in the name as an ISO date, "2026-10-22". Null when the last part is no date. */
  printDate: string | null;
}

/**
 * Reads a file name (no folders). The name is parts split by "_": the last is the date, the one
 * before it the order (all digits), and every part before that is a prefix that must hold a letter.
 * Null when the name is not an order document: no ".pdf", no order, or two numbers before the date.
 */
export function parseOrderFileName(name: string): OrderFileName | null {
  const m = /^([^\\/]+)\.pdf$/i.exec(name);
  if (!m) return null;
  const parts = m[1].split("_");
  if (parts.length < 2) return null;
  const orderPart = parts[parts.length - 2];
  const prefixes = parts.slice(0, -2);
  if (!/^0*\d{1,9}$/.test(orderPart) || !prefixes.every((p) => /\p{L}/u.test(p))) return null;
  const orderNumber = Number(orderPart);
  if (orderNumber > 2147483647) return null;
  return { orderNumber, prefix: prefixes.join("_"), printDate: parseCompactDate(parts[parts.length - 1]) };
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
