import type { Metadata } from "next";
import { StationsManager } from "@/components/settings/stations-manager";
import { requireCapability } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { listOptiCloudMachines } from "@/lib/settings/machines";
import { listParallelHints, listStations } from "@/lib/settings/stations";

export const metadata: Metadata = { title: "Stationer" };

// Open to everyone with the Indstillinger tab; only masterdata.edit (admin)
// gets the form and the buttons.
export default async function StationsPage() {
  const ctx = await requireCapability("/indstillinger/stationer", "settings.view");
  const [stations, machines, parallelHints] = await Promise.all([
    listStations(ctx.claims),
    listOptiCloudMachines(ctx.token, ctx.accountId),
    listParallelHints(ctx.claims),
  ]);
  return (
    <StationsManager
      stations={stations}
      machines={machines.status === "ok" ? machines.machines : null}
      parallelHints={parallelHints}
      canEdit={can(ctx.role, "masterdata.edit")}
    />
  );
}
