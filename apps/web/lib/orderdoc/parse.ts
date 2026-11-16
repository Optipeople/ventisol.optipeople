import { EMPTY_HEADER, readPages } from "./layout";
import { readPdfPages } from "./pdf";
import type { OrderDocument } from "./types";
import { PARSER_VERSION } from "./version";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function empty(fileName: string | null, pageCount: number, problem: string): OrderDocument {
  return { parserVersion: PARSER_VERSION, fileName, pageCount, header: { ...EMPTY_HEADER }, positions: [], problems: [problem] };
}

/**
 * Reads a "Produktionsliste" PDF from 3E. Never throws: anything it does not recognise is left out
 * and noted in `problems`, and bytes that are no PDF give an empty document with one problem.
 */
export async function parseOrderDocument(bytes: Uint8Array, fileName?: string): Promise<OrderDocument> {
  const name = fileName ?? null;
  let read;
  try {
    read = await readPdfPages(bytes);
  } catch (e) {
    return empty(name, 0, `Not a readable PDF: ${message(e)}`);
  }
  try {
    const problems = [...read.problems];
    const { header, positions } = readPages(read.pages, problems);
    return { parserVersion: PARSER_VERSION, fileName: name, pageCount: read.pageCount, header, positions, problems };
  } catch (e) {
    return empty(name, read.pageCount, `Could not be read: ${message(e)}`);
  }
}
