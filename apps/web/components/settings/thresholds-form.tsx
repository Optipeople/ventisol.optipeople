"use client";

import { useState, type FormEvent } from "react";
import { Button, TextField } from "@optipeople/ui";
import { SectionCard } from "@optipeople/ui/blocks";
import { saveThresholdsAction } from "@/app/(app)/indstillinger/actions";
import { FieldError, FormMessage, useSettingsAction } from "./use-settings-action";

export type ThresholdRow = {
  key: string;
  label: string;
  unit: string;
  help: string;
  min: number;
  max: number;
  /** The stored value as text, "" when it is missing. */
  value: string;
  /** Who and when, formatted on the server. */
  changed: string;
};

export function ThresholdsForm({ thresholds }: { thresholds: ThresholdRow[] }) {
  // Only what is typed and not yet saved; the rest shows the stored value.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const { pending, result, run, clear, fieldErrors } = useSettingsAction({
    okText: "Grænseværdierne er gemt.",
  });

  const changed = thresholds.filter(
    (t) => edits[t.key] !== undefined && edits[t.key].trim() !== t.value
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (changed.length === 0) return;
    const values = Object.fromEntries(changed.map((t) => [t.key, edits[t.key]]));
    run(() => saveThresholdsAction(values), () => setEdits({}));
  }

  return (
    <SectionCard
      title="Grænseværdier"
      description="Tallene bag markeringerne i rapporterne. En ændring gælder med det samme, også for ældre data."
      bodyClassName="p-0"
    >
      <form onSubmit={submit} noValidate>
        <ul>
          {thresholds.map((t) => {
            const error = fieldErrors[t.key];
            const helpId = `threshold-${t.key}-help`;
            return (
              <li
                key={t.key}
                className="grid gap-x-6 gap-y-2 border-b border-[var(--ds-grey-light-02)] px-4 py-4 sm:grid-cols-[1fr_230px]"
              >
                <div className="min-w-0">
                  <label
                    htmlFor={`threshold-${t.key}`}
                    className="text-[14px] font-bold leading-[21px] text-[var(--ds-grey-dark-09)]"
                  >
                    {t.label}
                  </label>
                  <p id={helpId} className="text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
                    {t.help}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <div className="w-[110px] shrink-0">
                      <TextField
                        id={`threshold-${t.key}`}
                        inputMode="numeric"
                        autoComplete="off"
                        value={edits[t.key] ?? t.value}
                        onChange={(e) => {
                          clear();
                          setEdits((current) => ({ ...current, [t.key]: e.target.value }));
                        }}
                        disabled={pending}
                        validation={error ? "error" : "none"}
                        aria-invalid={Boolean(error)}
                        aria-describedby={helpId}
                      />
                    </div>
                    <span className="text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">{t.unit}</span>
                  </div>
                  <FieldError message={error} />
                  <p className="mt-[2px] text-[12px] leading-[17px] text-[var(--ds-grey-medium-05)]">
                    {t.min} til {t.max}. {t.changed}.
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Button type="submit" disabled={pending || changed.length === 0}>
            {pending ? "Gemmer…" : "Gem grænseværdier"}
          </Button>
          {changed.length > 0 && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                clear();
                setEdits({});
              }}
            >
              Fortryd
            </Button>
          )}
          <FormMessage result={result} />
        </div>
      </form>
    </SectionCard>
  );
}
