// The tables of the order page: the elements with their path, and every pass
// at a station with its time, the wait before it and the normal time.

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import { formatDayTime, formatDuration, formatMinutes, formatSignedPercent, NO_DATA } from "@/lib/reports/format";
import type { OrderElement, OrderInterval } from "@/lib/reports/types";

const muted = "text-[var(--ds-grey-medium-05)]";

function position(e: { position: number | null; subPosition: number | null; piece: number | null }): string {
  if (e.position == null) return "";
  const sub = e.subPosition != null && e.subPosition > 1 ? `.${e.subPosition}` : "";
  return `${e.position}${sub}${e.piece != null ? `, stk. ${e.piece}` : ""}`;
}

function elementState(e: OrderElement): { text: string; className: string } {
  if (e.packedAt) return { text: "Pakket", className: "text-[var(--ds-tag-green-dark)]" };
  if (e.inProgress) return { text: "På station nu", className: "text-[var(--ds-blue-primary)]" };
  if (e.assembledAt) return { text: "Samlet", className: "" };
  return { text: "Undervejs", className: muted };
}

export function ElementsTable({ elements }: { elements: OrderElement[] }) {
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Pos.</DataTableHeader>
          <DataTableHeader>Type</DataTableHeader>
          <DataTableHeader>Stregkode</DataTableHeader>
          <DataTableHeader>Vej gennem stationerne</DataTableHeader>
          <DataTableHeader align="right">Tid</DataTableHeader>
          <DataTableHeader align="right">Omarbejde</DataTableHeader>
          <DataTableHeader>Status</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {elements.map((e) => {
            const state = elementState(e);
            return (
              <DataTableRow key={e.barcode}>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {position(e) || <span className={muted}>Ukendt</span>}
                  {e.inDocument === false && (
                    <span className={`ml-1 text-[12px] ${muted}`} title="Positionen står ikke på produktionslisten">
                      (ikke på listen)
                    </span>
                  )}
                </DataTableCell>
                <DataTableCell>{e.elementTypeName ?? <span className={muted}>Uden type</span>}</DataTableCell>
                <DataTableCell className="font-mono text-[12px]">{e.barcode}</DataTableCell>
                <DataTableCell className="min-w-[220px]">
                  {e.pathLabels.length > 0 ? e.pathLabels.join(" › ") : <span className={muted}>Ingen passager</span>}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {formatDuration(e.total.seconds)}
                </DataTableCell>
                <DataTableCell
                  align="right"
                  className={`tabular-nums ${e.reworkCount > 0 ? "font-bold text-[var(--ds-red-dark)]" : ""}`}
                >
                  {e.reworkCount}
                </DataTableCell>
                <DataTableCell className={`whitespace-nowrap ${state.className}`}>
                  {state.text}
                  {e.missingScanOutCount > 0 && (
                    <span className="ml-2 text-[12px] text-[var(--ds-red-dark)]">mangler ud-scanning</span>
                  )}
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

const PASS_STATUS: Record<OrderInterval["status"], string> = {
  done: "",
  open: "I gang",
  missing_out: "Mangler ud-scanning",
};

export function PassesTable({ intervals, elements }: { intervals: OrderInterval[]; elements: OrderElement[] }) {
  const byBarcode = new Map(elements.map((e) => [e.barcode, e]));
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Station</DataTableHeader>
          <DataTableHeader>Element</DataTableHeader>
          <DataTableHeader>Ind</DataTableHeader>
          <DataTableHeader>Ud</DataTableHeader>
          <DataTableHeader align="right">Tid</DataTableHeader>
          <DataTableHeader align="right">Normalt</DataTableHeader>
          <DataTableHeader align="right">Mod normalt</DataTableHeader>
          <DataTableHeader align="right">Ventede før</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {intervals.map((i) => {
            const el = byBarcode.get(i.barcode);
            const flagged = i.status === "missing_out" || i.isRework;
            return (
              <DataTableRow key={i.intervalId} className={flagged ? "bg-[var(--ds-red-bg)]" : undefined}>
                <DataTableCell className="whitespace-nowrap">
                  {i.stationName}
                  {i.isRework && <span className="ml-2 text-[12px] text-[var(--ds-red-dark)]">omarbejde</span>}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap">
                  {el && position(el) ? `Pos. ${position(el)}` : <span className="font-mono text-[12px]">{i.barcode}</span>}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {formatDayTime(i.startAt)}
                  {i.startEstimated && <span className={`ml-1 text-[12px] ${muted}`} title="Ind-scanningen mangler: starten er regnet tilbage fra ud-scanningen">(anslået)</span>}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {i.endAt ? (
                    formatDayTime(i.endAt)
                  ) : (
                    <span className={i.status === "missing_out" ? "text-[var(--ds-red-dark)]" : "text-[var(--ds-blue-primary)]"}>
                      {PASS_STATUS[i.status]}
                    </span>
                  )}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {i.status === "missing_out" ? "" : formatMinutes(i.duration.seconds)}
                </DataTableCell>
                <DataTableCell align="right" className={`whitespace-nowrap tabular-nums ${i.normalSeconds == null ? muted : ""}`}>
                  {formatMinutes(i.normalSeconds)}
                </DataTableCell>
                <DataTableCell
                  align="right"
                  className={`whitespace-nowrap tabular-nums ${i.deviationPercent != null && i.deviationPercent > 0 ? "text-[var(--ds-red-dark)]" : ""} ${i.deviationPercent == null ? muted : ""}`}
                >
                  {i.deviationPercent == null ? (i.status === "done" ? NO_DATA : "") : formatSignedPercent(i.deviationPercent)}
                </DataTableCell>
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {i.waitBefore.seconds == null ? <span className={muted}>Første</span> : formatDuration(i.waitBefore.seconds)}
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}
