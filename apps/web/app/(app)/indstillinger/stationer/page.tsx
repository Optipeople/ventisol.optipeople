import type { Metadata } from "next";
import { StationsManager } from "@/components/settings/stations-manager";
import { requireCapability } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { listStations } from "@/lib/settings/stations";

export const metadata: Metadata = { title: "Stationer" };

// Open to everyone with the Indstillinger tab; only masterdata.edit (admin)
// gets the form and the buttons.
export default async function StationsPage() {
  const ctx = await requireCapability("/indstillinger/stationer", "settings.view");
  const stations = await listStations(ctx.claims);
  return <StationsManager stations={stations} canEdit={can(ctx.role, "masterdata.edit")} />;
}
