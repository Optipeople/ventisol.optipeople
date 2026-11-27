// The 3E documents of an order on the order page and the PDF route. Pure.
//
// A document is named by its file name: raw.order_documents keeps one row per
// file name, and getOrderDocuments returns only the documents of the order
// asked for, so a file name found there belongs to that order.

import { mergeBsPositions, pickOrderLists } from "@/lib/orderdoc/order-lists";
import type { OrderDocumentInfo } from "@/lib/reports/types";

/** Largest PDF the route hands out. The 3E lists are well under 1 MB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Where the PDF bytes of one document are served. */
export function documentPdfHref(orderNo: number, fileName: string): string {
  return `/api/ordre/${orderNo}/dokument/${encodeURIComponent(fileName)}`;
}

/** The document the viewer shows: the one named in the URL, else the newest that has a file. */
export function pickDocument(
  documents: OrderDocumentInfo[],
  wanted: string | undefined
): OrderDocumentInfo | null {
  if (wanted) {
    const named = documents.find((d) => d.fileName === wanted);
    if (named) return named;
  }
  return documents.find((d) => d.blobReference != null) ?? documents[0] ?? null;
}

/** What an order's documents say of it as a whole. */
export interface OrderLists {
  /** The order's list: the newest parsed list, else its newest parsed BS list. Null: nothing parsed. */
  main: OrderDocumentInfo | null;
  /** The BS list that adds positions to the list. Null when there is none, or it is `main`. */
  bs: OrderDocumentInfo | null;
  /** The list's positions, then the ones only the BS list has. */
  positions: OrderDocumentInfo["positions"];
  /** The positions that come from `bs`. */
  bsPositions: OrderDocumentInfo["positions"];
}

/**
 * The order's positions from its documents: the newest list plus what only
 * the newest BS list has (lib/orderdoc/order-lists.ts). BS drawings never count.
 */
export function orderLists(documents: OrderDocumentInfo[]): OrderLists {
  const picked = pickOrderLists(
    documents.map((doc) => ({
      fileName: doc.fileName,
      prefix: doc.prefix,
      printDate: doc.printDate,
      syncedAt: doc.syncedAt,
      headerDate: doc.header?.date,
      parsed: doc.parsedAt != null && doc.header != null,
      doc,
    }))
  );
  const list = picked.list?.doc ?? null;
  const bs = picked.bs?.doc ?? null;
  if (!list) return { main: bs, bs: null, positions: bs?.positions ?? [], bsPositions: [] };
  const positions = mergeBsPositions(list.positions, bs?.positions ?? []);
  const bsPositions = positions.slice(list.positions.length);
  return { main: list, bs: bsPositions.length > 0 ? bs : null, positions, bsPositions };
}

/**
 * The document behind a route parameter, only when it belongs to the order's
 * list and has a file in OptiCloud. The parameter arrives URL-decoded.
 */
export function findServableDocument(
  documents: OrderDocumentInfo[],
  documentId: string
): (OrderDocumentInfo & { blobReference: string }) | null {
  const doc = documents.find((d) => d.fileName === documentId);
  if (!doc || !doc.blobReference) return null;
  return doc as OrderDocumentInfo & { blobReference: string };
}

/** A file name safe for a Content-Disposition header: ASCII, no quotes or separators. */
export function safeFileName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  const withExt = base.toLowerCase().endsWith(".pdf") ? base : `${base || "dokument"}.pdf`;
  return withExt;
}
