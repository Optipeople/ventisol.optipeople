// The 3E documents of an order on the order page and the PDF route. Pure.
//
// A document is named by its file name: raw.order_documents keeps one row per
// file name, and getOrderDocuments returns only the documents of the order
// asked for, so a file name found there belongs to that order.

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
