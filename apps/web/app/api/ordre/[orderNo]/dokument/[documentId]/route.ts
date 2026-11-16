// The PDF of one 3E document, for the viewer on the order page.
//
// Checks, in order: a signed-in portal user who may see reports; the document
// is in that order's list from getOrderDocuments (the order's own documents
// only, and only with a file in OptiCloud); then the bytes come from
// OptiCloud's MasterDataBlob through the sync's service access. In fixture
// mode they come from the untracked orderdocs/ folder (lib/sync/fixture-source.ts).
//
// Inline by default; `?download=1` asks the browser to save it.

import { getPortalAccess } from "@/lib/auth";
import { findServableDocument, MAX_PDF_BYTES, safeFileName } from "@/lib/orders-view/documents";
import { can } from "@/lib/portal/roles";
import { getOrderDocuments, ReportAccessError } from "@/lib/reports";
import { BlobTooLargeError, getOptiCloud } from "@/lib/sync/opticloud-service";

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function GET(
  request: Request,
  ctx: { params: Promise<{ orderNo: string; documentId: string }> }
) {
  const access = await getPortalAccess();
  if (!access) return text(401, "Log ind for at se dokumentet.");
  if (!can(access.role, "reports.view")) return text(403, "Din rolle må ikke se dokumentet.");

  const { orderNo: rawOrderNo, documentId } = await ctx.params;
  if (!/^\d{1,10}$/.test(rawOrderNo)) return text(404, "Ukendt ordre.");
  const orderNo = Number(rawOrderNo);
  if (orderNo < 1 || orderNo > 2_147_483_647) return text(404, "Ukendt ordre.");

  let documents;
  try {
    documents = await getOrderDocuments(access.claims, { orderNo });
  } catch (err) {
    if (err instanceof ReportAccessError) return text(403, "Din rolle må ikke se dokumentet.");
    throw err;
  }
  // Next hands the segment over decoded already.
  const doc = findServableDocument(documents, documentId);
  if (!doc) return text(404, "Dokumentet findes ikke på ordren.");

  const service = await getOptiCloud(Date.now());
  if (service.status !== "ok") {
    console.error(`dokument route: OptiCloud ${service.status} for order ${orderNo}`);
    return text(503, "OptiCloud kan ikke nås lige nu.");
  }

  let bytes: Uint8Array;
  try {
    bytes = await service.source.getBlob(doc.blobReference, MAX_PDF_BYTES);
  } catch (err) {
    if (err instanceof BlobTooLargeError) return text(413, "Dokumentet er for stort til at blive vist.");
    // Never log the reference: it is a link to the file.
    console.error(`dokument route: the file of a document on order ${orderNo} could not be read:`, (err as Error)?.name);
    return text(503, "Dokumentet kunne ikke hentes fra OptiCloud.");
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const name = safeFileName(doc.fileName);
  return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      // Customer data behind a login: never in a shared cache.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
