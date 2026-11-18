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
  Modal,
  RowMenu,
  Select,
  Switch,
  Tag,
  TextField,
  useConfirm,
} from "@optipeople/ui";
import { EmptyState, FieldRow, Notice, SectionCard, TableFrame } from "@optipeople/ui/blocks";
import { saveStationAction, setStationActiveAction } from "@/app/(app)/indstillinger/actions";
import {
  MAX_OPEN_LIMIT,
  PARALLEL_HINT_DAYS,
  STATION_KIND_LABELS,
  STATION_KINDS,
  type StationKind,
} from "@/lib/settings/format";
import type { OptiCloudMachine } from "@/lib/settings/machines";
import type { Station } from "@/lib/settings/stations";
import { FieldError, FormMessage, useSettingsAction } from "./use-settings-action";

const KIND_ITEMS = STATION_KINDS.map((kind) => ({ value: kind, label: STATION_KIND_LABELS[kind] }));

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function StationsManager({
  stations,
  machines,
  parallelHints = {},
  canEdit,
}: {
  stations: Station[];
  /** The machines of the account in OptiCloud. Null: the list could not be read. */
  machines: OptiCloudMachine[] | null;
  /** Stations at Max i gang 1 that look like they work several elements at once (listParallelHints). */
  parallelHints?: Record<number, number>;
  canEdit: boolean;
}) {
  // The form in the dialog: a station to edit, "new" for a new one, null when closed.
  const [form, setForm] = useState<Station | "new" | null>(null);
  const machineName = (id: string) => machines?.find((m) => sameId(m.id, id))?.name ?? id;
  const confirm = useConfirm();
  const toggle = useSettingsAction();

  async function setActive(station: Station, active: boolean) {
    if (!active) {
      const yes = await confirm({
        title: `Deaktiver ${station.name}?`,
        description:
          "Stationen forsvinder fra tidsskemaerne, men dens historik bliver. Den kan aktiveres igen.",
        confirmLabel: "Deaktiver",
      });
      if (!yes) return;
    }
    toggle.run(() => setStationActiveAction({ stationNo: station.stationNo, active }));
  }

  const nextSort = stations.reduce((max, s) => Math.max(max, s.sortOrder), 0) + 10;

  return (
    <div className="flex flex-col gap-6">
      {!canEdit && (
        <Notice tone="info">Du kan se stationerne. Kun en administrator kan ændre dem.</Notice>
      )}

      <SectionCard
        title="Stationer"
        description="Stationsnummeret er det, scannerne sender. Rækkefølgen styrer, hvor stationen står i rapporterne."
        action={
          canEdit ? (
            <Button variant="secondary" size="compact" onClick={() => setForm("new")}>
              Tilføj station
            </Button>
          ) : undefined
        }
        bodyClassName="p-0"
      >
        {toggle.result && !toggle.result.ok && (
          <FormMessage result={toggle.result} className="mx-6 mt-4" />
        )}
        {stations.length === 0 ? (
          <EmptyState title="Ingen stationer endnu" className="m-6">
            {canEdit
              ? "Tilføj den første station med knappen Tilføj station. Brug det stationsnummer, som stationens scanner er sat op med."
              : "Bed en administrator om at oprette stationerne."}
          </EmptyState>
        ) : (
          <TableFrame className="rounded-t-none rounded-b-[calc(var(--ds-radius-surface)-1px)] border-0 shadow-none">
            <DataTable>
              <DataTableHead>
                <DataTableHeader align="right" className="w-[70px]">Nr.</DataTableHeader>
                <DataTableHeader>Navn</DataTableHeader>
                <DataTableHeader>Art</DataTableHeader>
                <DataTableHeader>Maskine i OptiCloud</DataTableHeader>
                <DataTableHeader align="right">Rækkefølge</DataTableHeader>
                <DataTableHeader align="right">Max i gang</DataTableHeader>
                <DataTableHeader>Status</DataTableHeader>
                {canEdit && <DataTableHeader><span className="sr-only">Handlinger</span></DataTableHeader>}
              </DataTableHead>
              <DataTableBody>
                {stations.map((station) => (
                  <DataTableRow key={station.stationNo}>
                    <DataTableCell align="right" className="tabular-nums">{station.stationNo}</DataTableCell>
                    <DataTableCell className="font-bold">{station.name}</DataTableCell>
                    <DataTableCell>{STATION_KIND_LABELS[station.kind]}</DataTableCell>
                    <DataTableCell>
                      {station.opticloudMachineId ? (
                        machineName(station.opticloudMachineId)
                      ) : (
                        <span className="text-[var(--ds-grey-medium-05)]">Ingen</span>
                      )}
                    </DataTableCell>
                    <DataTableCell align="right" className="tabular-nums">{station.sortOrder}</DataTableCell>
                    <DataTableCell align="right">
                      <span className="tabular-nums">{station.maxOpen}</span>
                      {station.maxOpen === 1 && parallelHints[station.stationNo] != null && (
                        <p className="mt-1 max-w-[240px] whitespace-normal text-left text-[12px] leading-[17px] text-[var(--ds-grey-dark-09)]">
                          <Tag size="small" variant="warning">Tjek</Tag> Flere elementer i gang samtidig set de
                          sidste {PARALLEL_HINT_DAYS} dage – skal Max i gang hæves?
                        </p>
                      )}
                    </DataTableCell>
                    <DataTableCell>
                      <Tag size="small" variant={station.active ? "positive" : "default"}>
                        {station.active ? "Aktiv" : "Inaktiv"}
                      </Tag>
                    </DataTableCell>
                    {canEdit && (
                      <DataTableCell align="right" className="whitespace-nowrap">
                        <RowMenu
                          label={`Handlinger for ${station.name}`}
                          disabled={toggle.pending}
                          actions={[
                            { id: "edit", label: "Rediger" },
                            { id: "active", label: station.active ? "Deaktiver" : "Aktivér" },
                          ]}
                          onAction={(action) => {
                            if (action === "edit") setForm(station);
                            else void setActive(station, !station.active);
                          }}
                        />
                      </DataTableCell>
                    )}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </TableFrame>
        )}
      </SectionCard>

      {canEdit && form !== null && (
        <StationForm
          // A new key gives a fresh form when another station is picked.
          key={form === "new" ? "new" : `edit-${form.stationNo}`}
          editing={form === "new" ? null : form}
          stations={stations}
          machines={machines}
          defaultSortOrder={nextSort}
          onDone={() => setForm(null)}
        />
      )}
    </div>
  );
}

/** The dialog with the form of one station: a new one, or `editing`. */
function StationForm({
  editing,
  stations,
  machines,
  defaultSortOrder,
  onDone,
}: {
  editing: Station | null;
  stations: Station[];
  machines: OptiCloudMachine[] | null;
  defaultSortOrder: number;
  onDone: () => void;
}) {
  const formId = useId();
  const [stationNo, setStationNo] = useState(editing ? String(editing.stationNo) : "");
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<StationKind>(editing?.kind ?? "assembly");
  const [machineId, setMachineId] = useState(editing?.opticloudMachineId ?? "");
  const [sortOrder, setSortOrder] = useState(String(editing?.sortOrder ?? defaultSortOrder));
  const [active, setActive] = useState(editing?.active ?? true);
  const [maxOpen, setMaxOpen] = useState(String(editing?.maxOpen ?? 1));
  const { pending, result, run, fieldErrors } = useSettingsAction({
    okText: editing ? "Stationen er gemt." : "Stationen er tilføjet.",
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { stationNo, name, kind, opticloudMachineId: machineId, sortOrder, active, maxOpen };
    run(() => saveStationAction(editing ? "update" : "create", input), onDone);
  }

  const state = (field: string) => (fieldErrors[field] ? "error" : "none");

  // The choices: no machine, every machine of the account (with the station
  // that already uses it), and the stored id when OptiCloud no longer lists it.
  const machineItems = machines && [
    { value: "", label: "Ingen" },
    ...machines.map((machine) => {
      const usedBy = stations.find(
        (s) =>
          s.stationNo !== editing?.stationNo &&
          s.opticloudMachineId !== null &&
          sameId(s.opticloudMachineId, machine.id)
      );
      return { value: machine.id, label: usedBy ? `${machine.name} (bruges af ${usedBy.name})` : machine.name };
    }),
    ...(machineId && !machines.some((m) => sameId(m.id, machineId))
      ? [{ value: machineId, label: `Ukendt maskine (${machineId})` }]
      : []),
  ];
  const machineValue = machines?.find((m) => sameId(m.id, machineId))?.id ?? machineId;

  return (
    <Modal
      open
      // A save under way is not left half way.
      onClose={() => {
        if (!pending) onDone();
      }}
      title={editing ? `Rediger station ${editing.stationNo}` : "Tilføj station"}
      width={600}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onDone}>
            Annuller
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem station" : "Tilføj station"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <p className="mb-4 text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
          {editing
            ? "Stationsnummeret kan ikke ændres, fordi scanningerne henviser til det."
            : "En station kan ikke slettes igen, kun deaktiveres."}
        </p>

        <FieldRow>
          <div>
            <TextField
              label="Stationsnr."
              inputMode="numeric"
              value={stationNo}
              onChange={(e) => setStationNo(e.target.value)}
              disabled={editing !== null || pending}
              validation={state("stationNo")}
              aria-invalid={Boolean(fieldErrors.stationNo)}
            />
            <FieldError message={fieldErrors.stationNo} />
          </div>
          <div>
            <TextField
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
        </FieldRow>

        <FieldRow>
          <div>
            <Select
              label="Art"
              value={kind}
              onValueChange={(value) => setKind(value as StationKind)}
              items={KIND_ITEMS}
              disabled={pending}
              validation={state("kind")}
            />
            <FieldError message={fieldErrors.kind} />
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
        </FieldRow>

        <div className="mb-6">
          {machineItems ? (
            <Select
              label="Maskine i OptiCloud (valgfrit)"
              value={machineValue}
              onValueChange={setMachineId}
              items={machineItems}
              searchable={machineItems.length > 10}
              disabled={pending}
              validation={state("opticloudMachineId")}
            />
          ) : (
            // The list could not be read from OptiCloud: the id can still be typed.
            <TextField
              label="Maskine-id i OptiCloud (valgfrit)"
              helpText="Maskinlisten kunne ikke hentes fra OptiCloud lige nu."
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              disabled={pending}
              maxLength={100}
              validation={state("opticloudMachineId")}
              aria-invalid={Boolean(fieldErrors.opticloudMachineId)}
            />
          )}
          <FieldError message={fieldErrors.opticloudMachineId} />
        </div>

        <div className="mb-6 max-w-[280px]">
          <TextField
            label="Max i gang"
            inputMode="numeric"
            helpText={`Hvor mange elementer én person kan have i gang på én gang ved denne station, 1 til ${MAX_OPEN_LIMIT}. Sæt det samme tal på stationens pc.`}
            value={maxOpen}
            onChange={(e) => setMaxOpen(e.target.value)}
            disabled={pending}
            validation={state("maxOpen")}
            aria-invalid={Boolean(fieldErrors.maxOpen)}
          />
          <FieldError message={fieldErrors.maxOpen} />
        </div>

        <Switch label="Aktiv" checked={active} onCheckedChange={setActive} disabled={pending} />

        <FormMessage result={result} className="mt-4" />
      </form>
    </Modal>
  );
}
