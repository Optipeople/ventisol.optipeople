"use client";

import { useState } from "react";
import { Button, Textarea } from "@optipeople/ui";
import { FieldError, FormMessage, useSettingsAction } from "@/components/settings/use-settings-action";
import type { ActionResult } from "@/lib/settings/result";

type Save = (month: string, highlights: string, decisions: string) => Promise<ActionResult>;

function NoteList({ lines, empty }: { lines: string[]; empty: string }) {
  if (lines.length === 0) {
    return <p className="text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">{empty}</p>;
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * "Det vigtigste" and "Til beslutning" of one month. Read as two lists;
 * "Rediger" turns them into two text fields, one point per line.
 */
export function NotesEditor({
  month,
  highlights,
  decisions,
  updatedText,
  onSave,
}: {
  /** "yyyy-MM". */
  month: string;
  highlights: string[];
  decisions: string[];
  /** "Senest rettet 3.11 kl. 09:12", or null when never written. */
  updatedText: string | null;
  onSave: Save;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ highlights: "", decisions: "" });
  const { pending, result, run, clear, fieldErrors } = useSettingsAction();

  function start() {
    setDraft({ highlights: highlights.join("\n"), decisions: decisions.join("\n") });
    clear();
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="grid gap-6 md:grid-cols-2">
          <section>
            <h3 className="mb-2 text-[14px] font-bold text-[var(--ds-grey-dark-09)]">Det vigtigste</h3>
            <NoteList lines={highlights} empty="Ingen punkter skrevet endnu." />
          </section>
          <section>
            <h3 className="mb-2 text-[14px] font-bold text-[var(--ds-grey-dark-09)]">Til beslutning</h3>
            <NoteList lines={decisions} empty="Intet til beslutning endnu." />
          </section>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="compact" onClick={start}>
            Rediger noter
          </Button>
          {updatedText && <span className="text-[12px] text-[var(--ds-grey-medium-05)]">{updatedText}</span>}
          <FormMessage result={result} />
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => onSave(month, draft.highlights, draft.decisions), () => setEditing(false));
      }}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Textarea
            name="highlights"
            label="Det vigtigste"
            helpText="Et punkt pr. linje, 3 til 5 punkter."
            rows={6}
            autoGrow
            value={draft.highlights}
            validation={fieldErrors.highlights ? "error" : "none"}
            onChange={(e) => setDraft((d) => ({ ...d, highlights: e.target.value }))}
          />
          <FieldError message={fieldErrors.highlights} />
        </div>
        <div>
          <Textarea
            name="decisions"
            label="Til beslutning"
            helpText="Et punkt pr. linje."
            rows={6}
            autoGrow
            value={draft.decisions}
            validation={fieldErrors.decisions ? "error" : "none"}
            onChange={(e) => setDraft((d) => ({ ...d, decisions: e.target.value }))}
          />
          <FieldError message={fieldErrors.decisions} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="compact" disabled={pending}>
          {pending ? "Gemmer…" : "Gem noter"}
        </Button>
        <Button variant="secondary" size="compact" disabled={pending} onClick={() => setEditing(false)}>
          Annuller
        </Button>
        <FormMessage result={result && !result.ok ? result : null} />
      </div>
    </form>
  );
}
