"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Checkbox,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Tag,
  TextField,
  useConfirm,
} from "@optipeople/ui";
import { EmptyState, Notice, SectionCard, TableFrame } from "@optipeople/ui/blocks";
import {
  restoreDefaultElementTypesAction,
  saveElementTypeAction,
} from "@/app/(app)/indstillinger/actions";
import type { ElementTypeRule } from "@/lib/orderdoc/element-types";
import type { ElementType } from "@/lib/settings/element-types";
import { FieldError, FormMessage, useSettingsAction } from "./use-settings-action";

/** The rule in words, one condition per entry. Empty: no rule. */
function ruleParts(rule: ElementTypeRule | null): string[] {
  if (!rule) return [];
  const parts: string[] = [];
  if (rule.anyOpeningContains?.length) {
    parts.push(`Et fags åbning indeholder: ${rule.anyOpeningContains.join(" eller ")}`);
  }
  if (rule.noOpeningContains?.length) {
    parts.push(`Intet fags åbning indeholder: ${rule.noOpeningContains.join(" eller ")}`);
  }
  const { minFields: min, maxFields: max } = rule;
  if (min !== undefined && max !== undefined) {
    parts.push(min === max ? `Præcis ${min} fag` : `${min} til ${max} fag`);
  } else if (min !== undefined) {
    parts.push(`Mindst ${min} fag`);
  } else if (max !== undefined) {
    parts.push(`Højst ${max} fag`);
  }
  return parts;
}

export function ElementTypesManager({ types, canEdit }: { types: ElementType[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<ElementType | null>(null);
  const confirm = useConfirm();
  const restore = useSettingsAction();

  async function restoreDefaults() {
    const yes = await confirm({
      title: "Gendan standardtyperne?",
      description:
        "De seks indbyggede typer får deres oprindelige navn, regel og rækkefølge tilbage og bliver aktive. Typer I selv har tilføjet, røres ikke. Tiderne pr. type bliver stående.",
      confirmLabel: "Gendan standard",
    });
    if (yes) restore.run(() => restoreDefaultElementTypesAction(), () => setEditing(null));
  }

  const nextSort = types.reduce((max, t) => Math.max(max, t.sortOrder), 0) + 10;

  return (
    <div className="flex flex-col gap-5">
      {!canEdit && (
        <Notice tone="info">Du kan se elementtyperne. Kun en administrator kan ændre dem.</Notice>
      )}

      <SectionCard
        title="Elementtyper"
        description="Et element får den første type på listen, hvis regel passer på produktionslisten fra 3E. Passer ingen regel, bliver det Andet."
        action={
          canEdit && types.length > 0 ? (
            <Button
              variant="secondary"
              size="compact"
              disabled={restore.pending}
              onClick={() => void restoreDefaults()}
            >
              Gendan standard
            </Button>
          ) : undefined
        }
        bodyClassName="p-0"
      >
        {restore.result && (
          <FormMessage
            result={restore.result}
            okText="Standardtyperne er på plads."
            className="mx-4 mt-3"
          />
        )}
        {types.length === 0 ? (
          <EmptyState title="Ingen elementtyper endnu" className="m-4">
            {canEdit ? (
              <>
                <p>
                  Opret de seks standardtyper (vinduer med 1, 2 og 3 fag, dør, terrassedør og
                  andet) med deres regler. De kan rettes bagefter.
                </p>
                <Button
                  className="mt-4"
                  disabled={restore.pending}
                  onClick={() => restore.run(() => restoreDefaultElementTypesAction())}
                >
                  {restore.pending ? "Opretter…" : "Opret standardtyper"}
                </Button>
              </>
            ) : (
              "Bed en administrator om at oprette elementtyperne."
            )}
          </EmptyState>
        ) : (
          <TableFrame className="border-0 shadow-none">
            <DataTable>
              <DataTableHead>
                <DataTableHeader align="right" className="w-[100px]">Rækkefølge</DataTableHeader>
                <DataTableHeader>Navn</DataTableHeader>
                <DataTableHeader>Id</DataTableHeader>
                <DataTableHeader>Genkendes når</DataTableHeader>
                <DataTableHeader>Status</DataTableHeader>
                {canEdit && <DataTableHeader><span className="sr-only">Handlinger</span></DataTableHeader>}
              </DataTableHead>
              <DataTableBody>
                {types.map((type) => {
                  const parts = ruleParts(type.rule);
                  return (
                    <DataTableRow key={type.id}>
                      <DataTableCell align="right" className="tabular-nums">{type.sortOrder}</DataTableCell>
                      <DataTableCell className="font-bold">{type.name}</DataTableCell>
                      <DataTableCell className="text-[var(--ds-grey-medium-05)]">{type.id}</DataTableCell>
                      <DataTableCell>
                        {parts.length > 0 ? (
                          parts.join(". ") + "."
                        ) : (
                          <span className="text-[var(--ds-grey-medium-05)]">
                            Ingen regel. Vælges aldrig automatisk.
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Tag size="small" variant={type.active ? "positive" : "default"}>
                          {type.active ? "Aktiv" : "Inaktiv"}
                        </Tag>
                      </DataTableCell>
                      {canEdit && (
                        <DataTableCell align="right">
                          <Button variant="ghost" size="pill" onClick={() => setEditing(type)}>
                            Rediger<span className="sr-only"> {type.name}</span>
                          </Button>
                        </DataTableCell>
                      )}
                    </DataTableRow>
                  );
                })}
              </DataTableBody>
            </DataTable>
          </TableFrame>
        )}
      </SectionCard>

      {canEdit && (
        <ElementTypeForm
          // A new key gives a fresh form when another type is picked.
          key={editing ? `edit-${editing.id}` : "new"}
          editing={editing}
          defaultSortOrder={nextSort}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ElementTypeForm({
  editing,
  defaultSortOrder,
  onDone,
}: {
  editing: ElementType | null;
  defaultSortOrder: number;
  onDone: () => void;
}) {
  const rule = editing?.rule ?? null;
  const [id, setId] = useState(editing?.id ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  // Null: not typed in yet, the field shows the next free place in the order.
  const [typedSortOrder, setSortOrder] = useState<string | null>(
    editing ? String(editing.sortOrder) : null
  );
  const sortOrder = typedSortOrder ?? String(defaultSortOrder);
  const [active, setActive] = useState(editing?.active ?? true);
  const [any, setAny] = useState(rule?.anyOpeningContains?.join(", ") ?? "");
  const [none, setNone] = useState(rule?.noOpeningContains?.join(", ") ?? "");
  const [min, setMin] = useState(rule?.minFields !== undefined ? String(rule.minFields) : "");
  const [max, setMax] = useState(rule?.maxFields !== undefined ? String(rule.maxFields) : "");
  const { pending, result, run, fieldErrors } = useSettingsAction();
  const nameRef = useRef<HTMLInputElement>(null);

  // "Rediger" in the table moves the keyboard to the form.
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      id,
      name,
      sortOrder,
      active,
      anyOpeningContains: any,
      noOpeningContains: none,
      minFields: min,
      maxFields: max,
    };
    run(() => saveElementTypeAction(editing ? "update" : "create", input), () => {
      if (editing) {
        onDone();
      } else {
        setId("");
        setName("");
        setAny("");
        setNone("");
        setMin("");
        setMax("");
        setSortOrder(null);
      }
    });
  }

  const state = (field: string) => (fieldErrors[field] ? "error" : "none");

  return (
    <SectionCard
      id="element-type-form"
      title={editing ? `Rediger ${editing.name}` : "Tilføj elementtype"}
      description={
        editing
          ? "Id kan ikke ændres, fordi tiderne henviser til det."
          : "En type kan ikke slettes igen, kun gøres inaktiv."
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_130px]">
          <div>
            <TextField
              ref={nameRef}
              label="Navn"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              maxLength={80}
              validation={state("name")}
              aria-invalid={Boolean(fieldErrors.name)}
            />
            <FieldError message={fieldErrors.name} />
          </div>
          <div>
            <TextField
              label="Id (små bogstaver, tal og bindestreg)"
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={editing !== null || pending}
              maxLength={40}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="for eksempel skydedoer"
              validation={state("id")}
              aria-invalid={Boolean(fieldErrors.id)}
            />
            <FieldError message={fieldErrors.id} />
          </div>
          <div>
            <TextField
              label="Rækkefølge"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              disabled={pending}
              validation={state("sortOrder")}
              aria-invalid={Boolean(fieldErrors.sortOrder)}
            />
            <FieldError message={fieldErrors.sortOrder} />
          </div>
        </div>

        <fieldset className="rounded-[2px] border border-[var(--ds-grey-light-02)] p-4">
          <legend className="px-1 text-[14px] font-bold leading-[21px] text-[var(--ds-grey-dark-09)]">
            Regel for genkendelse
          </legend>
          <p className="mb-4 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
            Alle udfyldte betingelser skal passe. Teksterne sammenlignes med fagenes
            åbningsfunktion i produktionslisten, uden hensyn til store og små bogstaver. Lad alle
            felter stå tomme for en type uden regel.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_130px_130px]">
            <div>
              <TextField
                label="Et fags åbning indeholder (adskil med komma)"
                value={any}
                onChange={(e) => setAny(e.target.value)}
                disabled={pending}
                placeholder="for eksempel dør, port"
                validation={state("anyOpeningContains")}
                aria-invalid={Boolean(fieldErrors.anyOpeningContains)}
              />
              <FieldError message={fieldErrors.anyOpeningContains} />
            </div>
            <div>
              <TextField
                label="Intet fags åbning indeholder (adskil med komma)"
                value={none}
                onChange={(e) => setNone(e.target.value)}
                disabled={pending}
                validation={state("noOpeningContains")}
                aria-invalid={Boolean(fieldErrors.noOpeningContains)}
              />
              <FieldError message={fieldErrors.noOpeningContains} />
            </div>
            <div>
              <TextField
                label="Mindst antal fag"
                inputMode="numeric"
                value={min}
                onChange={(e) => setMin(e.target.value)}
                disabled={pending}
                validation={state("minFields")}
                aria-invalid={Boolean(fieldErrors.minFields)}
              />
              <FieldError message={fieldErrors.minFields} />
            </div>
            <div>
              <TextField
                label="Højst antal fag"
                inputMode="numeric"
                value={max}
                onChange={(e) => setMax(e.target.value)}
                disabled={pending}
                validation={state("maxFields")}
                aria-invalid={Boolean(fieldErrors.maxFields)}
              />
              <FieldError message={fieldErrors.maxFields} />
            </div>
          </div>
        </fieldset>

        <Checkbox
          label="Aktiv"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          disabled={pending}
        />

        <FormMessage result={result} okText={editing ? "Typen er gemt." : "Typen er tilføjet."} />

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem elementtype" : "Tilføj elementtype"}
          </Button>
          {editing && (
            <Button variant="secondary" disabled={pending} onClick={onDone}>
              Annuller
            </Button>
          )}
        </div>
      </form>
    </SectionCard>
  );
}
