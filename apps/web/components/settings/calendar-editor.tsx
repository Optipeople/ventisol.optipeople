"use client";

import { useState, type FormEvent } from "react";
import {
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DateField,
  RowMenu,
  Switch,
  TextField,
  TimeField,
  useConfirm,
} from "@optipeople/ui";
import { EmptyState, SectionCard, TableFrame } from "@optipeople/ui/blocks";
import {
  removeClosedDayAction,
  removeShiftAction,
  saveClosedDayAction,
  saveShiftAction,
  setDeductOffShiftAction,
} from "@/app/(app)/indstillinger/actions";
import type { Shift } from "@/lib/settings/calendar";
import { WEEKDAY_LABELS } from "@/lib/settings/format";
import { FieldError, FormMessage, useSettingsAction } from "./use-settings-action";

// --- The switch ---

export function OffShiftToggle({ value }: { value: boolean | null }) {
  const { pending, result, run } = useSettingsAction({ okText: "Gemt." });
  const on = value ?? false;

  return (
    <SectionCard title="Træk tid uden for skift fra">
      <div className="flex flex-wrap items-start gap-4">
        <Switch
          checked={on}
          onCheckedChange={(next) => run(() => setDeductOffShiftAction(next))}
          disabled={pending}
          label={on ? "Til" : "Fra"}
          aria-label="Træk tid uden for skift fra"
          className="min-w-[88px]"
        />
        <div className="min-w-0 flex-1 basis-[280px] text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">
          <p>
            {on
              ? "Gennemløbstiden tæller kun tiden inden for skiftene herunder. En ordre, der venter natten over, bliver ikke længere af det."
              : "Gennemløbstiden tæller al tid, også nætter, weekender og lukkedage."}
          </p>
          {value === null && (
            <p className="mt-1 text-[var(--ds-grey-medium-05)]">
              Indstillingen er ikke sat endnu. Vælg til eller fra.
            </p>
          )}
          <FormMessage result={result} className="mt-2" />
        </div>
      </div>
    </SectionCard>
  );
}

// --- Shifts ---

type ShiftDraft = { weekday: number; originalStart?: string; start: string; end: string };

function ShiftForm({
  draft,
  label,
  onDone,
}: {
  draft: ShiftDraft;
  /** The weekday name, for the field labels. */
  label: string;
  onDone?: () => void;
}) {
  const [start, setStart] = useState(draft.start);
  const [end, setEnd] = useState(draft.end);
  const { pending, result, run, clear, fieldErrors } = useSettingsAction();
  const isNew = draft.originalStart === undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A time the field cannot read never reaches `start` or `end`, so the
    // old value would be saved. The field already says what is wrong.
    if (event.currentTarget.querySelector('[aria-invalid="true"]')) return;
    run(
      () =>
        saveShiftAction({ weekday: draft.weekday, originalStart: draft.originalStart, start, end }),
      () => {
        if (isNew) {
          setStart("");
          setEnd("");
        }
        onDone?.();
      }
    );
  }

  const error = result && !result.ok ? (fieldErrors.start ?? fieldErrors.end ?? result.error) : undefined;

  return (
    <form onSubmit={submit} noValidate>
      {/* A field is as wide as its box, so the width sits on the div around
          it. The row lines up at the top: a time that cannot be read puts a
          message under its field. */}
      <div className="flex flex-wrap items-start gap-2 [&>button]:mt-[3px]">
        <div className="w-[96px]">
          <TimeField
            aria-label={`${label}, ${isNew ? "nyt skift" : "skift"} fra`}
            placeholder="06:00"
            value={start}
            onChange={(value) => {
              clear();
              setStart(value);
            }}
            disabled={pending}
            validation={fieldErrors.start ? "error" : "none"}
          />
        </div>
        <span className="mt-[8px] text-[14px] text-[var(--ds-grey-medium-05)]">til</span>
        <div className="w-[96px]">
          <TimeField
            aria-label={`${label}, ${isNew ? "nyt skift" : "skift"} til`}
            placeholder="14:00"
            value={end}
            onChange={(value) => {
              clear();
              setEnd(value);
            }}
            disabled={pending}
            validation={fieldErrors.end ? "error" : "none"}
          />
        </div>
        <Button type="submit" variant={isNew ? "secondary" : "primary"} size="compact" disabled={pending}>
          {pending ? "Gemmer…" : isNew ? "Tilføj skift" : "Gem"}
        </Button>
        {!isNew && (
          <Button variant="secondary" size="compact" disabled={pending} onClick={onDone}>
            Annuller
          </Button>
        )}
      </div>
      {error && <FieldError message={error} />}
    </form>
  );
}

export function ShiftsEditor({ shifts }: { shifts: Shift[] }) {
  // "weekday start" of the shift being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const confirm = useConfirm();
  const remove = useSettingsAction();

  async function removeShift(shift: Shift, label: string) {
    const yes = await confirm({
      title: "Fjern skiftet?",
      description: `${label} ${shift.start} til ${shift.end} fjernes fra kalenderen.`,
      confirmLabel: "Fjern",
      danger: true,
    });
    if (yes) remove.run(() => removeShiftAction({ weekday: shift.weekday, start: shift.start }));
  }

  return (
    <SectionCard
      title="Skift"
      description="Arbejdstiden pr. ugedag, dansk tid. En dag kan have flere skift, men de må ikke overlappe. En dag uden skift er en fridag."
      bodyClassName="p-0"
    >
      {remove.result && !remove.result.ok && (
        <FormMessage result={remove.result} className="mx-4 mt-3" />
      )}
      <TableFrame className="max-h-none border-0 shadow-none">
        <DataTable>
          <DataTableHead>
            <DataTableHeader className="w-[120px]">Ugedag</DataTableHeader>
            <DataTableHeader>Skift</DataTableHeader>
            <DataTableHeader>Nyt skift</DataTableHeader>
          </DataTableHead>
          <DataTableBody>
            {WEEKDAY_LABELS.map((label, index) => {
              const weekday = index + 1;
              const dayShifts = shifts.filter((s) => s.weekday === weekday);
              return (
                <DataTableRow key={weekday}>
                  <DataTableCell className="align-top font-bold">{label}</DataTableCell>
                  <DataTableCell className="align-top">
                    {dayShifts.length === 0 ? (
                      <span className="text-[var(--ds-grey-medium-05)]">Ingen skift</span>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {dayShifts.map((shift) => {
                          const id = `${weekday} ${shift.start}`;
                          return (
                            <li key={id}>
                              {editing === id ? (
                                <ShiftForm
                                  label={label}
                                  draft={{ ...shift, originalStart: shift.start }}
                                  onDone={() => setEditing(null)}
                                />
                              ) : (
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="min-w-[112px] tabular-nums">
                                    {shift.start} til {shift.end}
                                  </span>
                                  <RowMenu
                                    label={`Handlinger for ${label} ${shift.start}`}
                                    align="left"
                                    disabled={remove.pending}
                                    actions={[
                                      { id: "edit", label: "Rediger" },
                                      { id: "remove", label: "Fjern", danger: true },
                                    ]}
                                    onAction={(action) => {
                                      if (action === "edit") setEditing(id);
                                      else void removeShift(shift, label);
                                    }}
                                  />
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </DataTableCell>
                  <DataTableCell className="align-top">
                    <ShiftForm label={label} draft={{ weekday, start: "", end: "" }} />
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      </TableFrame>
    </SectionCard>
  );
}

// --- Closed days ---

export type ClosedDayRow = {
  /** "YYYY-MM-DD" */
  day: string;
  name: string | null;
  /** The date in words, formatted on the server. */
  label: string;
  past: boolean;
};

function ClosedDayForm({
  editing,
  onDone,
}: {
  editing: ClosedDayRow | null;
  onDone: () => void;
}) {
  const [day, setDay] = useState(editing?.day ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  // Remounts the date field after an add, to empty its text.
  const [round, setRound] = useState(0);
  const { pending, result, run, fieldErrors } = useSettingsAction({
    okText: editing ? "Lukkedagen er gemt." : "Lukkedagen er tilføjet.",
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    run(
      () => saveClosedDayAction({ originalDay: editing?.day, day, name }),
      () => {
        if (editing) {
          onDone();
        } else {
          setDay("");
          setName("");
          setRound((n) => n + 1);
        }
      }
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 border-t border-[var(--ds-grey-light-02)] p-4"
    >
      <p className="text-[14px] font-bold leading-[21px] text-[var(--ds-grey-dark-09)]">
        {editing ? `Rediger ${editing.label}` : "Tilføj lukkedag"}
      </p>
      <div className="grid gap-4 sm:grid-cols-[190px_1fr_auto] sm:items-end">
        <div>
          <DateField key={round} label="Dato" value={day} onChange={setDay} />
        </div>
        <div>
          <TextField
            label="Navn (valgfrit)"
            placeholder="for eksempel Juleaften"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            maxLength={80}
            validation={fieldErrors.name ? "error" : "none"}
            aria-invalid={Boolean(fieldErrors.name)}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem lukkedag" : "Tilføj lukkedag"}
          </Button>
          {editing && (
            <Button variant="secondary" disabled={pending} onClick={onDone}>
              Annuller
            </Button>
          )}
        </div>
      </div>
      <FieldError message={fieldErrors.day ?? fieldErrors.name} />
      <FormMessage
        result={result && !result.ok && (fieldErrors.day || fieldErrors.name) ? null : result}
      />
    </form>
  );
}

export function ClosedDaysEditor({ days }: { days: ClosedDayRow[] }) {
  const [editing, setEditing] = useState<ClosedDayRow | null>(null);
  const confirm = useConfirm();
  const remove = useSettingsAction();

  async function removeDay(row: ClosedDayRow) {
    const yes = await confirm({
      title: "Fjern lukkedagen?",
      description: `${row.label}${row.name ? ` (${row.name})` : ""} bliver en almindelig dag igen.`,
      confirmLabel: "Fjern",
      danger: true,
    });
    if (yes) remove.run(() => removeClosedDayAction({ day: row.day }));
  }

  return (
    <SectionCard
      title="Lukkedage"
      description="Dage uden produktion, uanset ugedag: helligdage, ferielukning. De tæller ikke med i gennemløbstiden, når tid uden for skift trækkes fra."
      bodyClassName="p-0"
    >
      {remove.result && !remove.result.ok && (
        <FormMessage result={remove.result} className="mx-4 mt-3" />
      )}
      {days.length === 0 ? (
        <EmptyState title="Ingen lukkedage" className="m-4">
          Tilføj helligdage og ferielukning herunder, så de ikke tæller som arbejdstid.
        </EmptyState>
      ) : (
        <TableFrame className="max-h-[420px] border-0 shadow-none">
          <DataTable stickyHeader>
            <DataTableHead>
              <DataTableHeader>Dato</DataTableHeader>
              <DataTableHeader>Navn</DataTableHeader>
              <DataTableHeader>
                <span className="sr-only">Handlinger</span>
              </DataTableHeader>
            </DataTableHead>
            <DataTableBody>
              {days.map((row) => (
                <DataTableRow key={row.day}>
                  <DataTableCell
                    className={row.past ? "text-[var(--ds-grey-medium-05)]" : undefined}
                  >
                    {row.label}
                  </DataTableCell>
                  <DataTableCell>{row.name ?? ""}</DataTableCell>
                  <DataTableCell align="right" className="whitespace-nowrap">
                    <RowMenu
                      label={`Handlinger for ${row.label}`}
                      disabled={remove.pending}
                      actions={[
                        { id: "edit", label: "Rediger" },
                        { id: "remove", label: "Fjern", danger: true },
                      ]}
                      onAction={(action) => {
                        if (action === "edit") setEditing(row);
                        else void removeDay(row);
                      }}
                    />
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </TableFrame>
      )}
      <ClosedDayForm
        key={editing ? `edit-${editing.day}` : "new"}
        editing={editing}
        onDone={() => setEditing(null)}
      />
    </SectionCard>
  );
}
