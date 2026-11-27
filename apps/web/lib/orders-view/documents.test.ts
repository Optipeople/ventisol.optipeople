import { describe, expect, it } from "vitest";
import type { OrderDocumentInfo } from "@/lib/reports/types";
import { documentPdfHref, findServableDocument, orderLists, pickDocument, safeFileName } from "./documents";

const doc = (fileName: string, blobReference: string | null): OrderDocumentInfo => ({
  fileName,
  orderNo: 58721,
  prefix: null,
  printDate: "2026-10-22",
  blobReference,
  blobName: null,
  contentType: "application/pdf",
  sizeBytes: 1000,
  syncedAt: "2026-10-22T08:00:00Z",
  parsedAt: null,
  parserVersion: null,
  pageCount: 2,
  header: null,
  positions: [],
  problems: [],
});

const docs = [doc("58721_20261023.pdf", null), doc("58721_20261022.pdf", "ref/b"), doc("58721_20261020.pdf", "ref/c")];

describe("pickDocument", () => {
  it("takes the one named in the URL", () => {
    expect(pickDocument(docs, "58721_20261020.pdf")?.fileName).toBe("58721_20261020.pdf");
  });
  it("else the newest with a file, else the newest", () => {
    expect(pickDocument(docs, "other.pdf")?.fileName).toBe("58721_20261022.pdf");
    expect(pickDocument([docs[0]], undefined)?.fileName).toBe("58721_20261023.pdf");
    expect(pickDocument([], undefined)).toBeNull();
  });
});

describe("findServableDocument", () => {
  it("serves only a document of the list that has a file", () => {
    expect(findServableDocument(docs, "58721_20261022.pdf")?.blobReference).toBe("ref/b");
    expect(findServableDocument(docs, "58721_20261023.pdf")).toBeNull();
    expect(findServableDocument(docs, "../58721_20261022.pdf")).toBeNull();
    expect(findServableDocument(docs, "99999_20261022.pdf")).toBeNull();
  });
});

describe("hrefs and names", () => {
  it("encodes the file name in the route", () => {
    expect(documentPdfHref(58721, "a b/c.pdf")).toBe("/api/ordre/58721/dokument/a%20b%2Fc.pdf");
  });
  it("makes a header-safe file name", () => {
    expect(safeFileName('58721 "x"\r\n.pdf')).toBe("58721_x_.pdf");
    expect(safeFileName("..")).toBe("dokument.pdf");
    expect(safeFileName("rapport")).toBe("rapport.pdf");
  });
});

describe("orderLists", () => {
  const pos = (number: number, quantity: number) => ({ label: String(number), number, subNumber: null, quantity });
  const parsed = (fileName: string, prefix: string | null, printDate: string | null, positions: unknown[]): OrderDocumentInfo => ({
    ...doc(fileName, "ref"),
    prefix,
    printDate,
    parsedAt: "2026-11-27T08:00:00Z",
    header: { date: null, customer: [fileName] } as unknown as OrderDocumentInfo["header"],
    positions: positions as OrderDocumentInfo["positions"],
  });
  const list = parsed("58931_20261127.pdf", null, "2026-11-27", [pos(1, 2), pos(3, 1)]);
  const bs = parsed("58931_20261127BS.pdf", "BS", null, [pos(2, 1), pos(3, 9)]);
  const oldBs = parsed("B S 58931_20261112.pdf", "BS", null, [pos(7, 1)]);
  const drawings = parsed("58931_20261127BS tegninger.pdf", "BS tegninger", null, []);

  it("adds what only the newest BS list has to the newest list", () => {
    const lists = orderLists([drawings, oldBs, bs, list, parsed("58931_20261112.pdf", null, "2026-11-12", [pos(5, 5)])]);
    expect(lists.main?.fileName).toBe("58931_20261127.pdf");
    expect(lists.bs?.fileName).toBe("58931_20261127BS.pdf");
    expect(lists.positions.map((p) => [p.number, p.quantity])).toEqual([
      [1, 2],
      [3, 1],
      [2, 1],
    ]);
    expect(lists.bsPositions.map((p) => p.number)).toEqual([2]);
  });
  it("takes the BS list alone when the order has no list, and never the drawings", () => {
    const lists = orderLists([drawings, bs]);
    expect(lists.main?.fileName).toBe("58931_20261127BS.pdf");
    expect(lists.bs).toBeNull();
    expect(lists.positions.map((p) => p.number)).toEqual([2, 3]);
    expect(orderLists([drawings])).toMatchObject({ main: null, positions: [] });
  });
});
