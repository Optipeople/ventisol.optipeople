"use client";

import { useCallback, useState, useTransition } from "react";
import { cn } from "@optipeople/ui";
import type { ActionResult } from "@/lib/settings/result";

/**
 * Runs a settings server action from a client form: `pending` while it and
 * the refresh that follows are under way, `result` is what it answered.
 */
export function useSettingsAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

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
        if (answer.ok) onOk?.();
      });
    },
    []
  );

  const clear = useCallback(() => setResult(null), []);
  const fieldErrors: Record<string, string> =
    result && !result.ok ? (result.fieldErrors ?? {}) : {};

  return { pending, result, run, clear, fieldErrors };
}

/** The answer of the last save: the error (announced at once) or a quiet "Gemt". */
export function FormMessage({
  result,
  okText = "Gemt.",
  className,
}: {
  result: ActionResult | null;
  okText?: string;
  className?: string;
}) {
  if (!result) return null;
  if (result.ok) {
    return (
      <p
        role="status"
        className={cn("text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]", className)}
      >
        {result.message ?? okText}
      </p>
    );
  }
  return (
    <p
      role="alert"
      className={cn(
        "rounded-[2px] border border-[var(--ds-tag-red-dark)] bg-[var(--ds-tag-red-light)] px-3 py-2 text-[13px] leading-[19px] text-[var(--ds-grey-dark-09)]",
        className
      )}
    >
      {result.error}
    </p>
  );
}

/** The message of one field, under it. */
export function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="mt-[2px] text-[12px] leading-[17px] text-[var(--ds-red)]">{message}</p>;
}
