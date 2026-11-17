"use client";

import { useCallback, useState, useTransition } from "react";
import { Button } from "@optipeople/ui";
import { Note } from "@optipeople/ui/blocks";
import type { BaselineKept, BaselineProposal, BaselineProposalResult } from "@/lib/settings/baseline";
import type { ActionResult } from "@/lib/settings/result";
import { BaselinePreview } from "./baseline-preview";
import { FormMessage, useSettingsAction } from "./use-settings-action";

const UNREACHABLE: ActionResult = { ok: false, error: "Serveren kunne ikke nås. Prøv igen." };

/**
 * "Foreslå fra baseline": asks the server for the measured medians, shows
 * them in a preview to review, and saves only on "Brug forslag". Nothing is
 * ever written without that click. Disabled, with a line saying why, until
 * both actions are passed.
 */
export function SuggestBaselineButton({
  suggest,
  apply,
  disabledReason = "Kommer, når der er målt historik at foreslå ud fra.",
}: {
  /** Reads the proposal. Saves nothing. */
  suggest?: () => Promise<BaselineProposalResult>;
  /** Saves the kept rows and revalidates the page. */
  apply?: (kept: BaselineKept) => Promise<ActionResult>;
  /** Shown beside the button while there is no action. */
  disabledReason?: string;
}) {
  const enabled = Boolean(suggest && apply);
  const [loading, startLoading] = useTransition();
  const [proposal, setProposal] = useState<BaselineProposal | null>(null);
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const saving = useSettingsAction({ okText: "Gemt." });

  function open() {
    if (!suggest) return;
    setNotice(null);
    saving.clear();
    startLoading(async () => {
      let answer: BaselineProposalResult;
      try {
        answer = await suggest();
      } catch {
        setNotice(UNREACHABLE);
        return;
      }
      if (!answer.ok) setNotice(answer);
      else if (answer.rows.length === 0) {
        setNotice({
          ok: true,
          message:
            answer.unchanged > 0
              ? "Ingen nye forslag: normaltiderne svarer allerede til de målte tider."
              : `Ingen forslag: ingen station og elementtype har mindst ${answer.minSamples} målinger de seneste ${Math.round(answer.weeks)} uger.`,
        });
      } else setProposal(answer);
    });
  }

  const close = useCallback(() => setProposal(null), []);
  const { run } = saving;
  const onApply = useCallback(
    (kept: BaselineKept) => {
      if (!apply) return;
      run(
        () => apply(kept),
        () => setProposal(null)
      );
    },
    [apply, run]
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="compact"
        disabled={!enabled || loading}
        aria-describedby={enabled ? undefined : "suggest-baseline-reason"}
        onClick={enabled ? open : undefined}
      >
        {loading ? "Henter forslag…" : "Foreslå fra baseline"}
      </Button>
      {!enabled && (
        <p
          id="suggest-baseline-reason"
          className="max-w-[240px] text-right text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]"
        >
          {disabledReason}
        </p>
      )}
      {/* Why there is nothing to review stays beside the button: it is the
          answer to the click, and too long to read in a toast. */}
      {notice?.ok && notice.message && (
        <div role="status">
          <Note className="mt-0 max-w-[320px] text-right">{notice.message}</Note>
        </div>
      )}
      <FormMessage result={notice} className="max-w-[320px] text-left" />
      {proposal && (
        <BaselinePreview
          proposal={proposal}
          pending={saving.pending}
          result={saving.result}
          onApply={onApply}
          onClose={close}
        />
      )}
    </div>
  );
}
