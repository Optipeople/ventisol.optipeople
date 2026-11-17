"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  TextField,
} from "@optipeople/ui";
import { SectionCard, TableFrame } from "@optipeople/ui/blocks";
import { saveTimesAction } from "@/app/(app)/indstillinger/actions";
import { parseMinutes, timeCellKey } from "@/lib/settings/format";
import type { TimeKind } from "@/lib/settings/times";
import { FormMessage, useSettingsAction } from "./use-settings-action";

export type TimesGridCell = {
  /** The stored time as minutes text, "12,5". */
  minutes: string;
  source: "manual" | "baseline";
  /** Who and when, formatted on the server. Shown as the field's tooltip. */
  note: string;
};

/**
 * One grid, stations down and element types across, a minutes field per
 * cell. Typing only changes the form: "Gem" sends the changed cells in one
 * go, and an emptied cell deletes its time.
 */
export function TimesGrid({
  kind,
  title,
  description,
  stations,
  types,
  cells,
  latest,
  headerAction,
}: {
  kind: TimeKind;
  title: string;
  description: string;
  stations: { stationNo: number; name: string }[];
  types: { id: string; name: string }[];
  /** Stored times by timeCellKey. */
  cells: Record<string, TimesGridCell>;
  /** "Senest ændret ..." line, or null when nothing is stored. */
  latest: string | null;
  headerAction?: ReactNode;
}) {
  // Only what the user has typed and not yet saved. Everything else shows
  // the stored value, so a refresh after a save needs no syncing.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const { pending, result, run, clear, fieldErrors } = useSettingsAction({
    okText: "Tiderne er gemt.",
  });

  const stored = (key: string) => cells[key]?.minutes ?? "";
  const changed = Object.entries(edits).filter(([key, text]) => {
    const now = parseMinutes(text);
    const before = parseMinutes(stored(key));
    return now === "invalid" || now !== before;
  });

  function edit(key: string, text: string) {
    clear();
    setEdits((current) => ({ ...current, [key]: text }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (changed.length === 0) return;
    const entries = changed.map(([key, minutes]) => {
      const split = key.indexOf(":");
      return {
        stationNo: Number(key.slice(0, split)),
        elementTypeId: key.slice(split + 1),
        minutes,
      };
    });
    run(() => saveTimesAction(kind, entries), () => setEdits({}));
  }

  return (
    <SectionCard title={title} description={description} action={headerAction} bodyClassName="p-0">
      <form onSubmit={submit} noValidate>
        <TableFrame className="max-h-none border-0 shadow-none">
          <DataTable stickyFirstColumn>
            <DataTableHead>
              <DataTableHeader>Station</DataTableHeader>
              {types.map((type) => (
                <DataTableHeader key={type.id} className="min-w-[104px]">
                  {type.name}
                </DataTableHeader>
              ))}
            </DataTableHead>
            <DataTableBody>
              {stations.map((station) => (
                <DataTableRow key={station.stationNo}>
                  <DataTableCell className="whitespace-nowrap font-bold">
                    <span className="mr-2 font-normal tabular-nums text-[var(--ds-grey-medium-05)]">
                      {station.stationNo}
                    </span>
                    {station.name}
                  </DataTableCell>
                  {types.map((type) => {
                    const key = timeCellKey(station.stationNo, type.id);
                    const cell = cells[key];
                    const value = edits[key] ?? stored(key);
                    const error = fieldErrors[key];
                    const dirty = changed.some(([k]) => k === key);
                    return (
                      <DataTableCell key={type.id}>
                        <TextField
                          aria-label={`${title}, ${station.name}, ${type.name}, minutter`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={value}
                          onChange={(e) => edit(key, e.target.value)}
                          disabled={pending}
                          title={error ?? cell?.note}
                          validation={error ? "error" : dirty ? "required" : "none"}
                          aria-invalid={Boolean(error)}
                          className="w-[88px]"
                          rightAdornment={
                            cell?.source === "baseline" && !dirty ? (
                              <span
                                title="Foreslået fra baseline"
                                className="text-[11px] text-[var(--ds-grey-medium-05)]"
                              >
                                B
                              </span>
                            ) : undefined
                          }
                        />
                      </DataTableCell>
                    );
                  })}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </TableFrame>

        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--ds-grey-light-02)] px-4 py-3">
          <Button type="submit" disabled={pending || changed.length === 0}>
            {pending
              ? "Gemmer…"
              : changed.length > 0
                ? `Gem ${changed.length} ${changed.length === 1 ? "ændring" : "ændringer"}`
                : "Gem"}
          </Button>
          {changed.length > 0 && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                clear();
                setEdits({});
              }}
            >
              Fortryd
            </Button>
          )}
          <FormMessage
            // For a bad cell, say what is wrong with it instead of the general line.
            result={
              result && !result.ok && Object.keys(fieldErrors).length > 0
                ? { ok: false, error: Object.values(fieldErrors)[0] }
                : result
            }
          />
          {latest && (
            <p className="ml-auto text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
              {latest}
            </p>
          )}
        </div>
      </form>
    </SectionCard>
  );
}
