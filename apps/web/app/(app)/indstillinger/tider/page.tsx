import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, Notice } from "@optipeople/ui/blocks";
import { SuggestBaselineButton } from "@/components/settings/suggest-baseline-button";
import { TimesGrid, type TimesGridCell } from "@/components/settings/times-grid";
import { requireCapability } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { listElementTypes } from "@/lib/settings/element-types";
import { formatMinutes, timeCellKey } from "@/lib/settings/format";
import { listStations } from "@/lib/settings/stations";
import { listTimes, type TimeCell } from "@/lib/settings/times";
import { portalUserNames, whoLabel } from "@/lib/settings/who";
import { formatDateTime } from "@/lib/time";
import { applyBaselineAction, suggestBaselineAction } from "../actions";

export const metadata: Metadata = { title: "Tider" };

export default async function TimesPage() {
  const ctx = await requireCapability("/indstillinger/tider", "times.edit");
  const { claims } = ctx;

  const [allStations, allTypes, normal, calculated, names] = await Promise.all([
    listStations(claims),
    listElementTypes(claims),
    listTimes(claims, "normal"),
    listTimes(claims, "calculated"),
    portalUserNames(claims),
  ]);

  // Inactive stations and types keep their times in the database, but are
  // not offered for editing.
  const stations = allStations
    .filter((s) => s.active)
    .map((s) => ({ stationNo: s.stationNo, name: s.name }));
  const types = allTypes.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }));

  const toCells = (cells: TimeCell[]): Record<string, TimesGridCell> =>
    Object.fromEntries(
      cells.map((cell) => [
        timeCellKey(cell.stationNo, cell.elementTypeId),
        {
          minutes: formatMinutes(cell.seconds),
          source: cell.source,
          note:
            cell.source === "baseline"
              ? `Foreslået fra baseline ${formatDateTime(cell.updatedAt.getTime())}`
              : `Sat af ${whoLabel(names, cell.updatedBy, claims.optiUserId)} ${formatDateTime(cell.updatedAt.getTime())}`,
        },
      ])
    );

  const latest = (cells: TimeCell[]): string | null => {
    const last = cells.reduce<TimeCell | null>(
      (best, cell) => (best === null || cell.updatedAt > best.updatedAt ? cell : best),
      null
    );
    if (!last) return null;
    return `Senest ændret ${formatDateTime(last.updatedAt.getTime())} af ${whoLabel(names, last.updatedBy, claims.optiUserId)}.`;
  };

  if (stations.length === 0 || types.length === 0) {
    const canMaster = can(ctx.role, "masterdata.edit");
    return (
      <EmptyState title="Der mangler stamdata">
        <p>
          Tiderne sættes pr. station og elementtype, så begge dele skal findes først.{" "}
          {canMaster ? "Opret dem her:" : "Bed en administrator om at oprette dem."}
        </p>
        <p className="mt-2">
          {stations.length === 0 && (
            <Link href="/indstillinger/stationer" className="underline">
              Stationer
            </Link>
          )}
          {stations.length === 0 && types.length === 0 && " og "}
          {types.length === 0 && (
            <Link href="/indstillinger/elementtyper" className="underline">
              Elementtyper
            </Link>
          )}
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Notice tone="info">
        Tiderne skrives i minutter med decimaler: 12,5 er tolv et halvt minut. Et tomt felt betyder,
        at der ingen tid er sat. Skriv i felterne og tryk Gem under skemaet.
      </Notice>

      <TimesGrid
        kind="normal"
        title="Normaltider"
        description="Den tid et element af typen bør tage på stationen. Bruges til at vise, om en station er langsom."
        stations={stations}
        types={types}
        cells={toCells(normal)}
        latest={latest(normal)}
        headerAction={<SuggestBaselineButton suggest={suggestBaselineAction} apply={applyBaselineAction} />}
      />

      <TimesGrid
        kind="calculated"
        title="Kalkulerede tider (kalkule)"
        description="Den tid tilbuddet regner med for typen på stationen. Bruges til at sammenligne kalkule med målt tid. Vises ikke for læsere."
        stations={stations}
        types={types}
        cells={toCells(calculated)}
        latest={latest(calculated)}
      />
    </div>
  );
}
