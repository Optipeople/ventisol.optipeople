"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import type { BaselineKept, BaselineProposal } from "@/lib/settings/baseline";
import { formatMinutes, timeCellKey } from "@/lib/settings/format";
import type { ActionResult } from "@/lib/settings/result";
import { FormMessage } from "./use-settings-action";

const minutes = (seconds: number | null) => (seconds === null ? "Ingen" : `${formatMinutes(seconds)} min`);

function danishDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

/**
 * The baseline proposal to review before anything is saved: one row per
 * station and element type with the normal time in force, the suggestion and
 * how many passes it is measured on. Every row starts ticked; "Brug forslag"
 * saves the ticked ones, "Annuller" closes without saving.
 */
export function BaselinePreview({
  proposal,
  pending,
  result,
  onApply,
  onClose,
}: {
  proposal: BaselineProposal;
  pending: boolean;
  /** The answer of the last "Brug forslag", shown when it failed. */
  result: ActionResult | null;
  onApply: (kept: BaselineKept) => void;
  onClose: () => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const kept = proposal.rows.filter((r) => !skipped.has(timeCellKey(r.stationNo, r.elementTypeId)));

  useEffect(() => {
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  function toggle(key: string) {
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="baseline-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:px-4"
    >
      <button
        type="button"
        aria-label="Luk"
        disabled={pending}
        onClick={onClose}
        className="dialog-overlay absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="dialog-panel relative flex max-h-[90vh] w-full max-w-[760px] flex-col gap-4 rounded-[4px] border-[3px] border-solid border-[#fcfcfc] bg-[var(--ds-grey-light-02)] p-6 text-left shadow-[0px_4px_4px_0px_rgba(0,0,0,0.1)] outline-none sm:p-10"
      >
        <h2 id="baseline-preview-title" className="text-[16px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          Forslag til normaltider
        </h2>
        <p className="text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">
          Mediantiden pr. stk. fra {danishDay(proposal.period.from)} til {danishDay(proposal.period.to)} (
          {proposal.weeks.toLocaleString("da-DK")} uger), kun hvor der er mindst {proposal.minSamples} målinger.
          Intet er gemt endnu. Fjern fluebenet ved de forslag, du ikke vil bruge.
          {proposal.unchanged > 0 &&
            ` ${proposal.unchanged} ${proposal.unchanged === 1 ? "tid har" : "tider har"} allerede den foreslåede værdi.`}
        </p>

        <TableFrame className="max-h-[50vh]">
          <DataTable stickyHeader>
            <DataTableHead>
              <DataTableHeader className="w-[48px]">
                <span className="sr-only">Brug</span>
              </DataTableHeader>
              <DataTableHeader>Station</DataTableHeader>
              <DataTableHeader>Elementtype</DataTableHeader>
              <DataTableHeader align="right">Normaltid nu</DataTableHeader>
              <DataTableHeader align="right">Forslag</DataTableHeader>
              <DataTableHeader align="right">Målinger</DataTableHeader>
            </DataTableHead>
            <DataTableBody>
              {proposal.rows.map((row) => {
                const key = timeCellKey(row.stationNo, row.elementTypeId);
                return (
                  <DataTableRow key={key}>
                    <DataTableCell>
                      <Checkbox
                        aria-label={`Brug forslaget for ${row.stationName}, ${row.elementTypeName}`}
                        checked={!skipped.has(key)}
                        disabled={pending}
                        onChange={() => toggle(key)}
                      />
                    </DataTableCell>
                    <DataTableCell>{row.stationName}</DataTableCell>
                    <DataTableCell>{row.elementTypeName}</DataTableCell>
                    <DataTableCell align="right">{minutes(row.currentSeconds)}</DataTableCell>
                    <DataTableCell align="right" className="font-bold">
                      {minutes(row.suggestedSeconds)}
                    </DataTableCell>
                    <DataTableCell align="right">{row.samples.toLocaleString("da-DK")}</DataTableCell>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        </TableFrame>

        <FormMessage result={result && !result.ok ? result : null} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            Annuller
          </Button>
          <Button
            disabled={pending || kept.length === 0}
            onClick={() =>
              onApply(
                kept.map((r) => ({ stationNo: r.stationNo, elementTypeId: r.elementTypeId, seconds: r.suggestedSeconds }))
              )
            }
          >
            {pending ? "Gemmer…" : `Brug forslag (${kept.length})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
