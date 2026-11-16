"use client";

import { Button } from "@optipeople/ui";
import type { ActionResult } from "@/lib/settings/result";
import { FormMessage, useSettingsAction } from "./use-settings-action";

/**
 * "Foreslå fra baseline": fills the normal times from the median of the
 * measured times. Disabled, with a line saying why, until `action` is
 * passed. Wiring it later is one prop on the Tider page:
 *
 *   <SuggestBaselineButton action={suggestNormalTimesAction} />
 *
 * where the action is a server action returning an ActionResult (and
 * revalidating the page itself).
 */
export function SuggestBaselineButton({
  action,
  disabledReason = "Kommer, når der er målt historik at foreslå ud fra.",
}: {
  action?: () => Promise<ActionResult>;
  /** Shown beside the button while there is no action. */
  disabledReason?: string;
}) {
  const { pending, result, run } = useSettingsAction();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="compact"
        disabled={!action || pending}
        aria-describedby={action ? undefined : "suggest-baseline-reason"}
        onClick={action ? () => run(action) : undefined}
      >
        {pending ? "Foreslår…" : "Foreslå fra baseline"}
      </Button>
      {!action && (
        <p
          id="suggest-baseline-reason"
          className="max-w-[240px] text-right text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]"
        >
          {disabledReason}
        </p>
      )}
      <FormMessage result={result} okText="Forslagene er sat ind." />
    </div>
  );
}
