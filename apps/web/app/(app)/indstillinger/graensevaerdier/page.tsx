import type { Metadata } from "next";
import { ParallelSplitChoice } from "@/components/settings/parallel-split-choice";
import { ThresholdsForm } from "@/components/settings/thresholds-form";
import { requireCapability } from "@/lib/auth";
import { getParallelSplit } from "@/lib/settings/parallel-split";
import { getThresholds } from "@/lib/settings/thresholds";
import { portalUserNames, whoLabel } from "@/lib/settings/who";
import { formatDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Grænseværdier" };

export default async function ThresholdsPage() {
  const ctx = await requireCapability("/indstillinger/graensevaerdier", "times.edit");
  const [thresholds, split, names] = await Promise.all([
    getThresholds(ctx.claims),
    getParallelSplit(ctx.claims),
    portalUserNames(ctx.claims),
  ]);

  return (
    <div className="flex flex-col gap-6">
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
      <ParallelSplitChoice
        value={split.value}
        changed={
          split.updatedBy !== null && split.updatedAt !== null
            ? `Ændret ${formatDateTime(split.updatedAt.getTime())} af ${whoLabel(names, split.updatedBy, ctx.claims.optiUserId)}`
            : "Standardværdi"
        }
      />
    </div>
  );
}
