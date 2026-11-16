import type { Metadata } from "next";
import { ElementTypesManager } from "@/components/settings/element-types-manager";
import { requireCapability } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { listElementTypes } from "@/lib/settings/element-types";

export const metadata: Metadata = { title: "Elementtyper" };

// Open to everyone with the Indstillinger tab; only masterdata.edit (admin)
// gets the form and the buttons.
export default async function ElementTypesPage() {
  const ctx = await requireCapability("/indstillinger/elementtyper", "settings.view");
  const types = await listElementTypes(ctx.claims);
  return <ElementTypesManager types={types} canEdit={can(ctx.role, "masterdata.edit")} />;
}
