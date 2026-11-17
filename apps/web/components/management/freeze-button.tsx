"use client";

import { Button, ConfirmProvider, useConfirm } from "@optipeople/ui";
import { FormMessage, useSettingsAction } from "@/components/settings/use-settings-action";
import type { ActionResult } from "@/lib/settings/result";

function Inner({ month, monthName, onFreeze }: FreezeButtonProps) {
  const confirm = useConfirm();
  const { pending, result, run } = useSettingsAction();

  async function freeze() {
    const yes = await confirm({
      title: `Lås ${monthName}?`,
      description:
        "Månedens tal gemmes, som de er nu, og ændrer sig ikke længere, heller ikke hvis der kommer scanninger eller rettelser bagefter. Noterne kan stadig rettes.",
      confirmLabel: "Lås måned",
    });
    if (yes) run(() => onFreeze(month));
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" size="compact" disabled={pending} onClick={() => void freeze()}>
        {pending ? "Låser…" : "Lås måned"}
      </Button>
      <FormMessage result={result} />
    </div>
  );
}

type FreezeButtonProps = {
  /** "yyyy-MM". */
  month: string;
  /** "oktober 2026". */
  monthName: string;
  onFreeze: (month: string) => Promise<ActionResult>;
};

/** "Lås måned" with a confirmation. The page shows it to an admin, for a month that is over and not frozen. */
export function FreezeButton(props: FreezeButtonProps) {
  return (
    <ConfirmProvider>
      <Inner {...props} />
    </ConfirmProvider>
  );
}
