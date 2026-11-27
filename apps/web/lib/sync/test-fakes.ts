// A fake OptiCloud for the sync tests: the two lists in memory, served through
// the same interface as the real client. Not imported by the app.

import { getValue, parseScanTime, type MasterDataRow } from "@/lib/scans";
import type { OrderDocument, OrderPosition } from "@/lib/orderdoc";
import { PARSER_VERSION } from "@/lib/orderdoc";
import type { OptiCloudSource, PageQuery, ServiceAccess, SourcePage } from "./opticloud-service";

export const SCANS_TABLE_ID = "table-scans";
export const DOCUMENTS_TABLE_ID = "table-documents";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** A fixed "now" well clear of any day boundary. */
export const NOW = Date.parse("2026-11-16T12:00:00Z");

let scanSeq = 0;

/** One VentisolScans row. Order 58556, position 5, piece from the sequence. */
export function scanRow(time: number, overrides: Record<string, unknown> = {}, id?: string): MasterDataRow {
  const n = ++scanSeq;
  const scanId = id ?? `scan-${String(n).padStart(5, "0")}`;
  return {
    id: `row-${scanId}`,
    createdDate: new Date(time + 1500).toISOString(),
    values: {
      ScanId: scanId,
      Barcode: `0585560501${String(n % 100).padStart(2, "0")}`,
      OrderNo: 58556,
      Position: 5,
      SubPosition: 1,
      Piece: n % 100,
      Station: "Station 10",
      StationNo: 1,
      StationKind: "Assembly",
      MachineId: "",
      Direction: n % 2 === 1 ? "In" : "out",
      ScanTime: new Date(time).toISOString(),
      Device: "PC01",
      ...overrides,
    },
  };
}

/** `count` scans, one every `stepMs`, the newest at `newest`. Returned oldest first. */
export function scanRows(count: number, newest: number, stepMs = HOUR): MasterDataRow[] {
  return Array.from({ length: count }, (_, i) => scanRow(newest - (count - 1 - i) * stepMs));
}

export function documentRow(
  fileName: string,
  options: {
    sha256?: string | null;
    reference?: string | null;
    orderNo?: number;
    size?: number;
    /** The PrintDate column; by default read off the end of the name. */
    printDate?: string;
    prefix?: string;
  } = {}
): MasterDataRow {
  const reference = options.reference === undefined ? `masterdata/acc/tbl/${fileName}` : options.reference;
  return {
    id: `row-${fileName}`,
    values: {
      FileName: fileName,
      OrderNo: options.orderNo ?? Number(/(\d+)_\d{8}\.pdf$/.exec(fileName)?.[1] ?? 0),
      Prefix: options.prefix ?? "",
      PrintDate:
        options.printDate ?? `${fileName.slice(-12, -8)}-${fileName.slice(-8, -6)}-${fileName.slice(-6, -4)}T00:00:00Z`,
      ...(reference === null ? {} : { File: { name: fileName, contentType: "application/pdf", reference } }),
      SizeBytes: options.size ?? 1000,
      Sha256: options.sha256 === undefined ? "" : options.sha256,
      Device: "PC01",
      ClaimedAt: "2026-11-10T08:00:00Z",
    },
  };
}

export class FakeOptiCloud implements OptiCloudSource {
  /** In the order they were stored (oldest upload first). */
  scans: MasterDataRow[] = [];
  documents: MasterDataRow[] = [];
  blobs = new Map<string, Uint8Array>();
  /** Rows per page. Small, so a handful of rows makes several pages. */
  pageSize = 5;
  /** False: the API ignores Orderby and serves the rows in stored order. */
  honoursOrder = true;
  /** False: the answer carries no page count. */
  reportsTotal = true;
  hasScanTable = true;
  hasDocumentTable = true;
  /** Every page asked for, as "scans:3" or "documents:1". */
  pageCalls: string[] = [];
  blobCalls: string[] = [];
  /** References whose fetch fails. */
  brokenBlobs = new Set<string>();
  /** Awaited before every page is served, when set. */
  gate: Promise<void> | null = null;

  get access(): ServiceAccess {
    return { status: "ok", source: this };
  }

  scanPagesRead(): number[] {
    return this.pageCalls.filter((c) => c.startsWith("scans:")).map((c) => Number(c.slice(6)));
  }

  async findTableId(name: string): Promise<string | null> {
    if (name === "VentisolScans") return this.hasScanTable ? SCANS_TABLE_ID : null;
    if (name === "VentisolOrderDocuments") return this.hasDocumentTable ? DOCUMENTS_TABLE_ID : null;
    return null;
  }

  async loadRowsPage(tableId: string, page: number, query: PageQuery = {}): Promise<SourcePage> {
    if (this.gate) await this.gate;
    const isScans = tableId === SCANS_TABLE_ID;
    this.pageCalls.push(`${isScans ? "scans" : "documents"}:${page}`);
    let rows = isScans ? [...this.scans] : [...this.documents];
    if (isScans && this.honoursOrder && query.orderBy === "ScanTime") {
      const time = (r: MasterDataRow) => parseScanTime(getValue(r.values, "ScanTime")) ?? 0;
      rows.sort((a, b) => (query.ascending ? time(a) - time(b) : time(b) - time(a)));
    }
    const total = Math.max(1, Math.ceil(rows.length / this.pageSize));
    rows = rows.slice((page - 1) * this.pageSize, page * this.pageSize);
    return { rows, totalPage: this.reportsTotal ? total : null, count: null };
  }

  async getBlob(reference: string): Promise<Uint8Array> {
    this.blobCalls.push(reference);
    const bytes = this.blobs.get(reference);
    if (!bytes || this.brokenBlobs.has(reference)) throw new Error("OptiCloud /api/MasterDataBlob/Get failed: 404.");
    return bytes;
  }

  /** Adds a document row and its file. The file's text is what the fake parser reads. */
  addDocument(fileName: string, text: string, options: Parameters<typeof documentRow>[1] = {}): void {
    const row = documentRow(fileName, options);
    this.documents = this.documents.filter((d) => d.id !== row.id).concat(row);
    const file = getValue(row.values, "File") as { reference: string } | undefined;
    if (file) this.blobs.set(file.reference, new TextEncoder().encode(text));
  }
}

function position(number: number, opening: string): OrderPosition {
  return {
    label: String(number),
    number,
    subNumber: null,
    system: "S9000",
    quantity: 2,
    frameColour: null,
    sashColour: null,
    sealColour: null,
    sizeWithoutCoupling: null,
    weightKg: null,
    frameHoles: null,
    notes: [],
    fields: [{ number: 1, opening, frameSize: null, glassType: [], panes: [], seals: [] }],
    fieldBars: [],
    hardware: [],
    accessories: [],
    cutting: [],
  } as unknown as OrderPosition;
}

/**
 * Stands in for parseOrderDocument. The "file" is text: one line per
 * position, each line the opening function of its one field. A line starting
 * with "!" is a problem instead.
 */
export async function fakeParse(bytes: Uint8Array, fileName: string): Promise<OrderDocument> {
  const lines = new TextDecoder().decode(bytes).split("\n").filter((l) => l.length > 0);
  const order = Number(/(\d+)_\d{8}\.pdf$/.exec(fileName)?.[1] ?? 0);
  return {
    parserVersion: PARSER_VERSION,
    fileName,
    pageCount: lines.length,
    header: {
      orderNumber: order,
      customer: ["Kunde A/S"],
      deliveryAddress: [],
      deliveryWeek: 47,
      date: null,
      caseHandler: null,
      packageInfo: null,
      glassDelivery: null,
      glassPallet: null,
    },
    positions: lines.filter((l) => !l.startsWith("!")).map((l, i) => position(i + 1, l)),
    problems: lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1)),
  };
}
