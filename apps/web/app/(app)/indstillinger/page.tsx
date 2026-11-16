import type { Metadata } from "next";
import { EmptyState, PageHeader, PageShell } from "@optipeople/ui/blocks";
import { requireCapability } from "@/lib/auth";

export const metadata: Metadata = { title: "Indstillinger" };

// Placeholder until the settings pages are built (docs/web-portal-plan.md 4.6).
// Only admin and planner get past the guard. Each part inside needs its own
// capability check: users, stations and element types are admin only.
export default async function SettingsPage() {
  await requireCapability("/indstillinger", "settings.view");
  return (
    <PageShell width="wide">
      <PageHeader title="Indstillinger" intro="Brugere, stationer, elementtyper, tider og kalender." />
      <EmptyState title="Kommer snart">Siden er på vej.</EmptyState>
    </PageShell>
  );
}
