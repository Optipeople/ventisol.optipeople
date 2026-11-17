"use client";

import { useCallback, useState, useTransition } from "react";
import { useToast } from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import type { ActionResult } from "@/lib/settings/result";

/**
 * Runs a settings server action from a client form: `pending` while it and
 * the refresh that follows are under way, `result` is what it answered.
 *
 * With `okText` a save that went well is said in a toast: the action's own
 * message when it has one, else `okText`. A failure is never a toast: it
 * stays in `result`, for FormMessage and the field messages.
 */
export function useSettingsAction({ okText }: { okText?: string } = {}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const toast = useToast();

  const run = useCallback(
    (action: () => Promise<ActionResult>, onOk?: () => void) => {
      startTransition(async () => {
        let answer: ActionResult;
        try {
          answer = await action();
        } catch {
          // The request itself failed (offline, server restarted).
          answer = { ok: false, error: "Serveren kunne ikke nås. Prøv igen." };
        }
        setResult(answer);
        if (answer.ok) {
          if (okText !== undefined) toast.success(answer.message ?? okText);
          onOk?.();
        }
      });
    },
    [okText, toast]
  );

  const clear = useCallback(() => setResult(null), []);
  const fieldErrors: Record<string, string> =
    result && !result.ok ? (result.fieldErrors ?? {}) : {};

  return { pending, result, run, clear, fieldErrors };
}

/** The error of the last save, announced at once. Nothing for a save that went well. */
export function FormMessage({
  result,
  className,
}: {
  result: ActionResult | null;
  className?: string;
}) {
  if (!result || result.ok) return null;
  return (
    <div role="alert" className={className}>
      <Notice tone="error">{result.error}</Notice>
    </div>
  );
}

/** The message of one field, under it. */
export function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="mt-[2px] text-[12px] leading-[17px] text-[var(--ds-red)]">{message}</p>;
}
