import type { Metadata } from "next";
import { ThresholdsForm } from "@/components/settings/thresholds-form";
import { requireCapability } from "@/lib/auth";
import { getThresholds } from "@/lib/settings/thresholds";
import { portalUserNames, whoLabel } from "@/lib/settings/who";
import { formatDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Grænseværdier" };

export default async function ThresholdsPage() {
  const ctx = await requireCapability("/indstillinger/graensevaerdier", "times.edit");
  const [thresholds, names] = await Promise.all([
    getThresholds(ctx.claims),
    portalUserNames(ctx.claims),
  ]);

  return (
    <ThresholdsForm
      thresholds={thresholds.map((t) => ({
        key: t.key,
        label: t.label,
        unit: t.unit,
        help: t.help,
        min: t.min,
        max: t.max,
        value: t.value === null ? "" : String(t.value),
        // The seeded defaults have no user.
        changed:
          t.updatedBy !== null && t.updatedAt !== null
            ? `Ændret ${formatDateTime(t.updatedAt.getTime())} af ${whoLabel(names, t.updatedBy, ctx.claims.optiUserId)}`
            : "Standardværdi",
      }))}
    />
  );
}
