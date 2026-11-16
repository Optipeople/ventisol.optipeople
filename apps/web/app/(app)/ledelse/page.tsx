import type { Metadata } from "next";
import { EmptyState, PageHeader, PageShell } from "@optipeople/ui/blocks";
import { requireCapability } from "@/lib/auth";

export const metadata: Metadata = { title: "Ledelse" };

// Placeholder until the Ledelse tab is built (docs/web-portal-plan.md 4.4).
// Only ledelse and admin get past the guard.
export default async function ManagementPage() {
  await requireCapability("/ledelse", "ledelse.view");
  return (
    <PageShell width="wide">
      <PageHeader title="Ledelse" intro="Månedens nøgletal, kalkule mod målt og månedsrapporten." />
      <EmptyState title="Kommer snart">Siden er på vej.</EmptyState>
    </PageShell>
  );
}
