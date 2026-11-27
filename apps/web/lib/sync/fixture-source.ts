// The "OptiCloud" of fixture mode (VENTISOL_FIXTURES=1 under `next dev`):
// the sample scans in fixtures/scans.json, and, when the untracked folder
// orderdocs/ exists at the repo root, its PDFs served as if they were rows of
// VentisolOrderDocuments. The PDFs are customer data: they are only read into
// the in-process database, never written anywhere.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fixturePageLoader } from "@/lib/fixtures";
import { kindLabel, parseOrderFileName } from "@/lib/orderdoc/file-name";
import { PAGE_SIZE } from "@/lib/paging";
import { SCAN_TABLE_NAME, type MasterDataRow } from "@/lib/scans";
import { BlobTooLargeError, DOCUMENT_TABLE_NAME, type OptiCloudSource } from "./opticloud-service";

const SCANS_ID = "fixture-scans";
const DOCUMENTS_ID = "fixture-documents";
const REFERENCE_PREFIX = "fixture-orderdocs/";

/** The untracked folder with sample PDFs. The dev server runs in apps/web. */
function orderDocsDir(): string {
  return resolve(process.cwd(), "..", "..", "orderdocs");
}

async function listPdfs(): Promise<string[]> {
  try {
    const names = await readdir(orderDocsDir());
    return names.filter((name) => parseOrderFileName(name) !== null).sort();
  } catch {
    // No folder: fixture mode simply has no documents.
    return [];
  }
}

// The hash of a file, kept while its size and write time stay the same.
const hashes = new Map<string, { key: string; sha256: string }>();

async function documentRow(name: string): Promise<MasterDataRow> {
  const path = join(orderDocsDir(), name);
  const info = await stat(path);
  const key = `${info.size}|${info.mtimeMs}`;
  let known = hashes.get(name);
  if (!known || known.key !== key) {
    known = { key, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
    hashes.set(name, known);
  }
  const parts = parseOrderFileName(name);
  return {
    id: `fixture-doc-${name}`,
    createdDate: info.mtime.toISOString(),
    values: {
      FileName: name,
      OrderNo: parts?.orderNumber ?? null,
      Prefix: parts ? [parts.prefix, kindLabel(parts.kind)].filter((p) => p.length > 0).join("_") : "",
      PrintDate: parts?.printDate ? `${parts.printDate}T00:00:00Z` : null,
      File: { name, contentType: "application/pdf", reference: `${REFERENCE_PREFIX}${name}` },
      SizeBytes: info.size,
      Sha256: known.sha256,
      Device: "FIXTURES",
      ClaimedAt: info.mtime.toISOString(),
    },
  };
}

export function fixtureSource(now: number): OptiCloudSource {
  const scanPages = fixturePageLoader(now);
  return {
    // The read model's fixture seed stores made-up documents of its own.
    partialDocumentList: true,

    async findTableId(name) {
      if (name.toLowerCase() === SCAN_TABLE_NAME.toLowerCase()) return SCANS_ID;
      if (name.toLowerCase() === DOCUMENT_TABLE_NAME.toLowerCase()) {
        return (await listPdfs()).length > 0 ? DOCUMENTS_ID : null;
      }
      return null;
    },

    async loadRowsPage(tableId, page) {
      if (tableId === SCANS_ID) {
        const { rows, totalPage } = await scanPages(page);
        return { rows, totalPage: totalPage ?? null, count: null };
      }
      const names = await listPdfs();
      const slice = names.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      return {
        rows: await Promise.all(slice.map(documentRow)),
        totalPage: Math.max(1, Math.ceil(names.length / PAGE_SIZE)),
        count: names.length,
      };
    },

    async getBlob(reference, maxBytes) {
      if (!reference.startsWith(REFERENCE_PREFIX)) throw new Error("Not a fixture file.");
      // The base name only: a reference can never reach outside the folder.
      const path = join(orderDocsDir(), basename(reference.slice(REFERENCE_PREFIX.length)));
      const info = await stat(path);
      if (info.size > maxBytes) throw new BlobTooLargeError(info.size);
      return new Uint8Array(await readFile(path));
    },
  };
}
