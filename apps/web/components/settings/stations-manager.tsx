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
  Select,
  Tag,
  TextField,
  useConfirm,
} from "@optipeople/ui";
import { EmptyState, Notice, SectionCard, TableFrame } from "@optipeople/ui/blocks";
import { saveStationAction, setStationActiveAction } from "@/app/(app)/indstillinger/actions";
import { STATION_KIND_LABELS, STATION_KINDS, type StationKind } from "@/lib/settings/format";
import type { Station } from "@/lib/settings/stations";
import { FieldError, FormMessage, useSettingsAction } from "./use-settings-action";

const KIND_ITEMS = STATION_KINDS.map((kind) => ({ value: kind, label: STATION_KIND_LABELS[kind] }));

export function StationsManager({ stations, canEdit }: { stations: Station[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<Station | null>(null);
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
    <div className="flex flex-col gap-5">
      {!canEdit && (
        <Notice tone="info">Du kan se stationerne. Kun en administrator kan ændre dem.</Notice>
      )}

      <SectionCard
        title="Stationer"
        description="Stationsnummeret er det, scannerne sender. Rækkefølgen styrer, hvor stationen står i rapporterne."
        bodyClassName="p-0"
      >
        {toggle.result && !toggle.result.ok && (
          <FormMessage result={toggle.result} className="mx-4 mt-3" />
        )}
        {stations.length === 0 ? (
          <EmptyState title="Ingen stationer endnu" className="m-4">
            {canEdit
              ? "Tilføj den første station i formularen herunder. Brug det stationsnummer, som stationens scanner er sat op med."
              : "Bed en administrator om at oprette stationerne."}
          </EmptyState>
        ) : (
          <TableFrame className="border-0 shadow-none">
            <DataTable>
              <DataTableHead>
                <DataTableHeader align="right" className="w-[70px]">Nr.</DataTableHeader>
                <DataTableHeader>Navn</DataTableHeader>
                <DataTableHeader>Art</DataTableHeader>
                <DataTableHeader>Maskine i OptiCloud</DataTableHeader>
                <DataTableHeader align="right">Rækkefølge</DataTableHeader>
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
                      {station.opticloudMachineId ?? (
                        <span className="text-[var(--ds-grey-medium-05)]">Ingen</span>
                      )}
                    </DataTableCell>
                    <DataTableCell align="right" className="tabular-nums">{station.sortOrder}</DataTableCell>
                    <DataTableCell>
                      <Tag size="small" variant={station.active ? "positive" : "default"}>
                        {station.active ? "Aktiv" : "Inaktiv"}
                      </Tag>
                    </DataTableCell>
                    {canEdit && (
                      <DataTableCell align="right" className="whitespace-nowrap">
                        <span className="inline-flex gap-2">
                          <Button variant="ghost" size="pill" onClick={() => setEditing(station)}>
                            Rediger<span className="sr-only"> {station.name}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="pill"
                            disabled={toggle.pending}
                            onClick={() => void setActive(station, !station.active)}
                          >
                            {station.active ? "Deaktiver" : "Aktivér"}
                            <span className="sr-only"> {station.name}</span>
                          </Button>
                        </span>
                      </DataTableCell>
                    )}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </TableFrame>
        )}
      </SectionCard>

      {canEdit && (
        <StationForm
          // A new key gives a fresh form when another station is picked.
          key={editing ? `edit-${editing.stationNo}` : "new"}
          editing={editing}
          defaultSortOrder={nextSort}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function StationForm({
  editing,
  defaultSortOrder,
  onDone,
}: {
  editing: Station | null;
  defaultSortOrder: number;
  onDone: () => void;
}) {
  const [stationNo, setStationNo] = useState(editing ? String(editing.stationNo) : "");
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<StationKind>(editing?.kind ?? "assembly");
  const [machineId, setMachineId] = useState(editing?.opticloudMachineId ?? "");
  // Null: not typed in yet, the field shows the next free place in the order.
  const [typedSortOrder, setSortOrder] = useState<string | null>(
    editing ? String(editing.sortOrder) : null
  );
  const sortOrder = typedSortOrder ?? String(defaultSortOrder);
  const [active, setActive] = useState(editing?.active ?? true);
  const { pending, result, run, fieldErrors } = useSettingsAction();
  const nameRef = useRef<HTMLInputElement>(null);

  // "Rediger" in the table moves the keyboard to the form.
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { stationNo, name, kind, opticloudMachineId: machineId, sortOrder, active };
    run(() => saveStationAction(editing ? "update" : "create", input), () => {
      if (editing) {
        onDone();
      } else {
        setStationNo("");
        setName("");
        setMachineId("");
        setSortOrder(null);
      }
    });
  }

  const state = (field: string) => (fieldErrors[field] ? "error" : "none");

  return (
    <SectionCard
      id="station-form"
      title={editing ? `Rediger station ${editing.stationNo}` : "Tilføj station"}
      description={
        editing
          ? "Stationsnummeret kan ikke ændres, fordi scanningerne henviser til det."
          : "En station kan ikke slettes igen, kun deaktiveres."
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[150px_1fr_160px_1fr_150px]">
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
              label="Maskine-id i OptiCloud (valgfrit)"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              disabled={pending}
              maxLength={100}
              validation={state("opticloudMachineId")}
              aria-invalid={Boolean(fieldErrors.opticloudMachineId)}
            />
            <FieldError message={fieldErrors.opticloudMachineId} />
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

        <Checkbox
          label="Aktiv"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          disabled={pending}
        />

        <FormMessage result={result} okText={editing ? "Stationen er gemt." : "Stationen er tilføjet."} />

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Gemmer…" : editing ? "Gem station" : "Tilføj station"}
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
