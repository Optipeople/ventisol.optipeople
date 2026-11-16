import { redirect } from "next/navigation";
import { requireCapability } from "@/lib/auth";

// Placeholder until the Ordrer tab is built (docs/web-portal-plan.md 4.3):
// for now the tab shows the period report.
export default async function OrdersPage() {
  await requireCapability("/ordrer", "reports.view");
  redirect("/periode");
}
