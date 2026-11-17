// "Produktionsliste": the 3E documents of the order, the chosen one drawn by
// PdfViewer, and the positions the parser read from it.

import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { EmptyState, TableFrame } from "@optipeople/ui/blocks";
import { documentPdfHref } from "@/lib/orders-view/documents";
import { formatDayTime, formatNumber, NO_DATA } from "@/lib/reports/format";
import type { OrderDocumentInfo } from "@/lib/reports/types";
import { formatDisplayDay } from "@/lib/time";
import { PdfViewer } from "./pdf-viewer";

const muted = "text-[var(--ds-grey-medium-05)]";

function size(bytes: number | null): string {
  if (bytes == null) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.round(bytes / 1024)} kB`;
}

export function OrderDocuments({
  orderNo,
  documents,
  selected,
  hrefFor,
}: {
  orderNo: number;
  documents: OrderDocumentInfo[];
  selected: OrderDocumentInfo | null;
  /** The order page with this document chosen. */
  hrefFor: (fileName: string) => string;
}) {
  if (documents.length === 0 || !selected) {
    return (
      <EmptyState title="Ingen produktionsliste">
        Der er ingen 3E-liste for ordre {orderNo} i OptiCloud endnu. Elementantallet kommer derfor kun fra scanningerne.
      </EmptyState>
    );
  }

  const pdf = selected.blobReference ? documentPdfHref(orderNo, selected.fileName) : null;

  return (
    <div className="space-y-6">
      <TableFrame>
        <DataTable>
          <DataTableHead>
            <DataTableHeader>Fil</DataTableHeader>
            <DataTableHeader>Udskrevet</DataTableHeader>
            <DataTableHeader align="right">Sider</DataTableHeader>
            <DataTableHeader align="right">Positioner</DataTableHeader>
            <DataTableHeader align="right">Størrelse</DataTableHeader>
            <DataTableHeader>Hentet</DataTableHeader>
            <DataTableHeader>Læst</DataTableHeader>
          </DataTableHead>
          <DataTableBody>
            {documents.map((d) => {
              const active = d.fileName === selected.fileName;
              return (
                <DataTableRow key={d.fileName} className={active ? "bg-[var(--ds-blue-secondary)]" : undefined}>
                  <DataTableCell className="whitespace-nowrap">
                    {active ? (
                      <span className="font-bold" aria-current="true">
                        {d.fileName}
                      </span>
                    ) : (
                      <Link href={hrefFor(d.fileName)} scroll={false} className="text-[var(--ds-midnight-green)] hover:underline">
                        {d.fileName}
                      </Link>
                    )}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap tabular-nums">
                    {d.printDate ? formatDisplayDay(d.printDate) : <span className={muted}>{NO_DATA}</span>}
                  </DataTableCell>
                  <DataTableCell align="right" className="tabular-nums">
                    {d.pageCount ?? ""}
                  </DataTableCell>
                  <DataTableCell align="right" className="tabular-nums">
                    {d.parsedAt ? formatNumber(d.positions.length) : ""}
                  </DataTableCell>
                  <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                    {size(d.sizeBytes)}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap tabular-nums">{formatDayTime(d.syncedAt)}</DataTableCell>
                  <DataTableCell className="whitespace-nowrap">
                    {d.parsedAt ? (
                      d.problems.length > 0 ? (
                        <span className="text-[var(--ds-red-dark)]" title={d.problems.join("\n")}>
                          Med {d.problems.length} fejl
                        </span>
                      ) : (
                        "Ja"
                      )
                    ) : (
                      <span className={muted}>Ikke endnu</span>
                    )}
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      </TableFrame>

      {pdf ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[14px]">
            <span className="font-bold text-[var(--ds-grey-dark-09)]">{selected.fileName}</span>
            <a href={`${pdf}?download=1`} className="text-[var(--ds-midnight-green)] hover:underline">
              Download PDF
            </a>
          </div>
          <PdfViewer key={pdf} src={pdf} title={`Produktionsliste ${selected.fileName}`} />
        </>
      ) : (
        <p className={`text-[14px] leading-[21px] ${muted}`}>
          PDF&apos;en til {selected.fileName} ligger ikke i OptiCloud, så den kan ikke vises. Positionerne nedenfor er læst, da den blev hentet.
        </p>
      )}

      {selected.positions.length > 0 && <PositionsTable positions={selected.positions} />}
    </div>
  );
}

function PositionsTable({ positions }: { positions: OrderDocumentInfo["positions"] }) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Pos.</DataTableHeader>
          <DataTableHeader>System</DataTableHeader>
          <DataTableHeader align="right">Antal</DataTableHeader>
          <DataTableHeader>Mål u/kobling</DataTableHeader>
          <DataTableHeader>Karm</DataTableHeader>
          <DataTableHeader>Ramme</DataTableHeader>
          <DataTableHeader align="right">Vægt</DataTableHeader>
          <DataTableHeader align="right">Side</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {positions.map((p) => (
            <DataTableRow key={`${p.label}-${p.pageIndex}`}>
              <DataTableCell className="font-bold tabular-nums">{p.label}</DataTableCell>
              <DataTableCell>{p.system ?? ""}</DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {p.quantity ?? ""}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">{p.sizeWithoutCoupling?.text ?? ""}</DataTableCell>
              <DataTableCell>{p.frameColour ?? ""}</DataTableCell>
              <DataTableCell>{p.sashColour ?? ""}</DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {p.weightKg != null ? `${String(p.weightKg).replace(".", ",")} kg` : ""}
              </DataTableCell>
              <DataTableCell align="right" className="tabular-nums">
                {p.pageIndex + 1}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
