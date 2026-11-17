"use client";

import { useId, useState, type FormEvent } from "react";
import {
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DateField,
  Modal,
  RowMenu,
  Select,
  Switch,
  TextField,
  TimeField,
  useConfirm,
} from "@optipeople/ui";
import { EmptyState, FieldRow, SectionCard, TableFrame } from "@optipeople/ui/blocks";
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

// Like the other settings pages: "Tilføj" sits in the card's top right corner,
// and a row is added or edited in a dialog.

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

const WEEKDAY_ITEMS = WEEKDAY_LABELS.map((label, index) => ({ value: String(index + 1), label }));

/** The dialog with one shift: a new one, or `editing`. */
function ShiftForm({ editing, onDone }: { editing: Shift | null; onDone: () => void }) {
  const formId = useId();
  const [weekday, setWeekday] = useState(String(editing?.weekday ?? 1));
  const [start, setStart] = useState(editing?.start ?? "");
  const [end, setEnd] = useState(editing?.end ?? "");
  const { pending, result, run, clear, fieldErrors } = useSettingsAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A time the field cannot read never reaches `start` or `end`, so the
    // old value would be saved. The field already says what is wrong.
    if (event.currentTarget.querySelector('[aria-invalid="true"]')) return;
    run(
      () => saveShiftAction({ weekday: Number(weekday), originalStart: editing?.start, start, end }),
      onDone
    );
  }

  const error = result && !result.ok ? (fieldErrors.start ?? fieldErrors.end ?? result.error) : undefined;

  return (
    <Modal
      open
      // A save under way is not left half way.
      onClose={() => {
        if (!pending) onDone();
      }}
      title={editing ? "Rediger skift" : "Tilføj skift"}
      width={520}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onDone}>
            Annuller
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem skift" : "Tilføj skift"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <div className="mb-4">
          <Select
            label="Ugedag"
            value={weekday}
            onValueChange={setWeekday}
            items={WEEKDAY_ITEMS}
            // A shift is moved to another day by removing it and adding it there.
            disabled={editing !== null || pending}
          />
        </div>
        <FieldRow minFieldWidth={140}>
          <TimeField
            label="Fra"
            placeholder="06:00"
            value={start}
            onChange={(value) => {
              clear();
              setStart(value);
            }}
            disabled={pending}
            validation={fieldErrors.start ? "error" : "none"}
          />
          <TimeField
            label="Til"
            placeholder="14:00"
            value={end}
            onChange={(value) => {
              clear();
              setEnd(value);
            }}
            disabled={pending}
            validation={fieldErrors.end ? "error" : "none"}
          />
        </FieldRow>
        {error && <FieldError message={error} />}
      </form>
    </Modal>
  );
}

export function ShiftsEditor({ shifts }: { shifts: Shift[] }) {
  // The form in the dialog: a shift to edit, "new" for a new one, null when closed.
  const [form, setForm] = useState<Shift | "new" | null>(null);
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
      action={
        <Button variant="secondary" size="compact" onClick={() => setForm("new")}>
          Tilføj skift
        </Button>
      }
      bodyClassName="p-0"
    >
      {remove.result && !remove.result.ok && (
        <FormMessage result={remove.result} className="mx-4 mt-3" />
      )}
      <TableFrame className="max-h-none border-0 shadow-none">
        <DataTable>
          <DataTableHead>
            <DataTableHeader className="w-[160px]">Ugedag</DataTableHeader>
            <DataTableHeader>Skift</DataTableHeader>
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
                        {dayShifts.map((shift) => (
                          <li key={shift.start} className="flex flex-wrap items-center gap-2">
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
                                if (action === "edit") setForm(shift);
                                else void removeShift(shift, label);
                              }}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      </TableFrame>

      {form !== null && (
        <ShiftForm
          key={form === "new" ? "new" : `edit-${form.weekday}-${form.start}`}
          editing={form === "new" ? null : form}
          onDone={() => setForm(null)}
        />
      )}
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

/** The dialog with one closed day: a new one, or `editing`. */
function ClosedDayForm({ editing, onDone }: { editing: ClosedDayRow | null; onDone: () => void }) {
  const formId = useId();
  const [day, setDay] = useState(editing?.day ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const { pending, result, run, fieldErrors } = useSettingsAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    run(() => saveClosedDayAction({ originalDay: editing?.day, day, name }), onDone);
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!pending) onDone();
      }}
      title={editing ? `Rediger ${editing.label}` : "Tilføj lukkedag"}
      width={520}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onDone}>
            Annuller
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem lukkedag" : "Tilføj lukkedag"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <div className="mb-4">
          <DateField label="Dato" value={day} onChange={setDay} />
          <FieldError message={fieldErrors.day} />
        </div>
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
        <FieldError message={fieldErrors.name} />
        <FormMessage
          result={result && !result.ok && (fieldErrors.day || fieldErrors.name) ? null : result}
          className="mt-4"
        />
      </form>
    </Modal>
  );
}

export function ClosedDaysEditor({ days }: { days: ClosedDayRow[] }) {
  // The form in the dialog: a day to edit, "new" for a new one, null when closed.
  const [form, setForm] = useState<ClosedDayRow | "new" | null>(null);
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
      action={
        <Button variant="secondary" size="compact" onClick={() => setForm("new")}>
          Tilføj lukkedag
        </Button>
      }
      bodyClassName="p-0"
    >
      {remove.result && !remove.result.ok && (
        <FormMessage result={remove.result} className="mx-4 mt-3" />
      )}
      {days.length === 0 ? (
        <EmptyState title="Ingen lukkedage" className="m-4">
          Tilføj helligdage og ferielukning med knappen Tilføj lukkedag, så de ikke tæller som arbejdstid.
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
                        if (action === "edit") setForm(row);
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

      {form !== null && (
        <ClosedDayForm
          key={form === "new" ? "new" : `edit-${form.day}`}
          editing={form === "new" ? null : form}
          onDone={() => setForm(null)}
        />
      )}
    </SectionCard>
  );
}
