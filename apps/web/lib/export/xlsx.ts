// The Excel file: one sheet with a bold, frozen header row and the rows,
// plus a second sheet "Om udtrækket" with the title, period, when it was made
// and, when the rows were capped, a line that says so.
//
// write-excel-file: small, no native code, builds the zip in memory, so it
// runs as is in a Vercel Node function.

import writeXlsxFile from "write-excel-file/node";
import type { Cell, Row, SheetData } from "write-excel-file/node";
import { KIND_WIDTH, xlsxCell } from "./cells";
import type { ExportColumn } from "./columns";

export interface XlsxInfo {
  title?: string;
  /** "Periode: 01-10-2026 til 31-10-2026". */
  period?: string | null;
  /** "Dannet 16-11-2026 12:00". */
  generated?: string;
  /** Shown in the info sheet, e.g. that the rows were capped. */
  notes?: string[];
}

/** Excel refuses sheet names over 31 characters and with : \ / ? * [ ]. */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim();
  return (cleaned || "Ark").slice(0, 31);
}

const INFO_SHEET = "Om udtrækket";

/** Builds the workbook. The first sheet is the table, always. */
export async function toXlsx<R>(
  sheetName: string,
  columns: ExportColumn<R>[],
  rows: R[],
  info: XlsxInfo = {}
): Promise<Buffer> {
  const header: Row = columns.map((c) => ({ value: c.header, type: String, fontWeight: "bold" as const }));
  const body: SheetData = rows.map((row) => columns.map((c) => xlsxCell(c.kind, c.value(row)) as Cell));
  const table = safeSheetName(sheetName);

  const infoRows: SheetData = [];
  if (info.title) infoRows.push([{ value: info.title, type: String, fontWeight: "bold" }]);
  if (info.period) infoRows.push([{ value: info.period, type: String }]);
  if (info.generated) infoRows.push([{ value: info.generated, type: String }]);
  infoRows.push([{ value: `${rows.length} rækker`, type: String }]);
  for (const note of info.notes ?? []) infoRows.push([{ value: note, type: String }]);

  return writeXlsxFile([
    {
      sheet: table,
      data: [header, ...body],
      columns: columns.map((c) => ({ width: Math.max(c.width ?? KIND_WIDTH[c.kind], c.header.length + 2) })),
      stickyRowsCount: 1,
    },
    { sheet: table === INFO_SHEET ? "Om" : INFO_SHEET, data: infoRows, columns: [{ width: 70 }] },
  ]).toBuffer();
}
