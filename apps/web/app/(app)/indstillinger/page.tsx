import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { noRolePath, requireCapability } from "@/lib/auth";
import { settingsSectionsFor } from "@/lib/settings/sections";

export const metadata: Metadata = { title: "Indstillinger" };

// /indstillinger has no content of its own: it opens the first section the
// user may see. The sections guard themselves.
export default async function SettingsPage() {
  const ctx = await requireCapability("/indstillinger", "settings.view");
  const first = settingsSectionsFor(ctx.role)[0];
  redirect(first ? first.href : noRolePath(ctx.roleDegraded));
}
