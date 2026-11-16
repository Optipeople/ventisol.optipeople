import type { Metadata } from "next";
import { EmptyState, PageHeader, PageShell } from "@optipeople/ui/blocks";
import { requireCapability } from "@/lib/auth";

export const metadata: Metadata = { title: "Stationer" };

// Placeholder until the Stationer tab is built (docs/web-portal-plan.md 4.2).
export default async function StationsPage() {
  await requireCapability("/stationer", "reports.view");
  return (
    <PageShell width="wide">
      <PageHeader title="Stationer" intro="Hver station og maskine, dag for dag, mod det normale." />
      <EmptyState title="Kommer snart">Siden er på vej. Indtil da finder du stationernes tal under Overblik.</EmptyState>
    </PageShell>
  );
}
