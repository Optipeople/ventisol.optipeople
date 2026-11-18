"use client";

import { Select } from "@optipeople/ui";
import { SectionCard } from "@optipeople/ui/blocks";
import { setParallelSplitAction } from "@/app/(app)/indstillinger/actions";
import type { ParallelSplitChoice as Choice } from "@/lib/settings/parallel-split";
import { FormMessage, useSettingsAction } from "./use-settings-action";

const ITEMS: { value: Choice; label: string }[] = [
  { value: "calculated", label: "Efter kalkuletid" },
  { value: "equal", label: "Ligeligt" },
];

/** config.settings.parallel_split, saved on change like the off-shift switch. */
export function ParallelSplitChoice({ value, changed }: { value: Choice; changed: string }) {
  const { pending, result, run } = useSettingsAction({
    okText: "Gemt. Tiderne regnes om i baggrunden.",
  });

  return (
    <SectionCard title="Fordel tid ved parallelt arbejde">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[230px] shrink-0">
          <Select
            label="Fordel tid ved parallelt arbejde"
            value={value}
            onValueChange={(next) => {
              if (next !== value) run(() => setParallelSplitAction(next));
            }}
            items={ITEMS}
            disabled={pending}
          />
        </div>
        <div className="min-w-0 flex-1 basis-[280px] text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">
          <p>
            Ved en station med flere elementer i gang samtidig (Max i gang over 1) deles stationens tid
            mellem dem, så en time med fire elementer er en times arbejde, ikke fire.{" "}
            {value === "calculated"
              ? "Hvert element får en andel efter sin kalkuletid ved stationen. Mangler et element en kalkuletid, deles den tid ligeligt."
              : "Hvert element får lige meget."}
          </p>
          <p className="mt-2 text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]">
            Bruges til tid pr. stk., kalkule mod målt, forslag til normaltid og tid pr. ordre på
            stationerne. {changed}.
          </p>
          <FormMessage result={result} className="mt-3" />
        </div>
      </div>
    </SectionCard>
  );
}
