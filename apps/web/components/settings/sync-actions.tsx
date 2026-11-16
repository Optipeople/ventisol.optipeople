"use client";

import { Button, useConfirm } from "@optipeople/ui";
import type { ActionResult } from "@/lib/settings/result";
import { FormMessage, useSettingsAction } from "./use-settings-action";

/**
 * "Synkroniser nu" and "Genopbyg". Each button is disabled, with a line
 * saying why, until its action is passed. The Synkronisering page passes both:
 *
 *   <SyncActions onSync={requestSyncAction} onRebuild={requestRebuildAction} />
 *
 * where each is a server action returning an ActionResult (and revalidating
 * the page itself). "Genopbyg" asks for confirmation first.
 */
export function SyncActions({
  onSync,
  onRebuild,
  disabledReason = "Knapperne bliver aktive, når synkroniseringen er sat i drift.",
}: {
  onSync?: () => Promise<ActionResult>;
  onRebuild?: () => Promise<ActionResult>;
  /** Shown while at least one of the actions is missing. */
  disabledReason?: string;
}) {
  const confirm = useConfirm();
  const { pending, result, run } = useSettingsAction();

  async function rebuild() {
    if (!onRebuild) return;
    const yes = await confirm({
      title: "Genopbyg de afledte data?",
      description:
        "Alle beregnede tal bygges op igen fra de rå scanninger. Det kan tage flere minutter, og rapporterne kan vise ufuldstændige tal imens.",
      confirmLabel: "Genopbyg",
    });
    if (yes) run(onRebuild);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          size="compact"
          disabled={!onSync || pending}
          onClick={onSync ? () => run(onSync) : undefined}
        >
          Synkroniser nu
        </Button>
        <Button
          variant="secondary"
          size="compact"
          disabled={!onRebuild || pending}
          onClick={() => void rebuild()}
        >
          Genopbyg
        </Button>
      </div>
      {(!onSync || !onRebuild) && (
        <p className="max-w-[320px] text-right text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]">
          {disabledReason}
        </p>
      )}
      <FormMessage result={result} okText="Sat i gang." />
    </div>
  );
}
