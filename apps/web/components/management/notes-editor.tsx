"use client";

import { useState, useTransition } from "react";
import { Button, ConfirmProvider, Textarea, useConfirm } from "@optipeople/ui";
import { FieldError, FormMessage, useSettingsAction } from "@/components/settings/use-settings-action";
import type { DraftResult } from "@/lib/management-view/draft";
import type { ActionResult } from "@/lib/settings/result";

type Save = (month: string, highlights: string, decisions: string) => Promise<ActionResult>;
type Draft = (month: string) => Promise<DraftResult>;

const DRAFT_HINT = "Udkast fra AI ud fra månedens tal. Tjek og ret det, og tryk Gem noter. Intet er gemt endnu.";

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

type NotesEditorProps = {
  /** "yyyy-MM". */
  month: string;
  highlights: string[];
  decisions: string[];
  /** "Senest rettet 3.11 kl. 09:12", or null when never written. */
  updatedText: string | null;
  onSave: Save;
  /** "Lav udkast". Left out: no draft button. */
  onDraft?: Draft;
  /** Why "Lav udkast" is disabled (AI not set up), or null when it may be used. */
  draftDisabledReason?: string | null;
};

/**
 * "Det vigtigste" and "Til beslutning" of one month. Read as two lists;
 * "Rediger" turns them into two text fields, one point per line. "Lav
 * udkast" asks the AI for a draft from the month's numbers and puts it in
 * the fields; only "Gem noter" saves.
 */
export function NotesEditor(props: NotesEditorProps) {
  return (
    <ConfirmProvider>
      <Editor {...props} />
    </ConfirmProvider>
  );
}

function Editor({
  month,
  highlights,
  decisions,
  updatedText,
  onSave,
  onDraft,
  draftDisabledReason = null,
}: NotesEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ highlights: "", decisions: "" });
  const [fromAi, setFromAi] = useState(false);
  const { pending, result, run, clear, fieldErrors } = useSettingsAction();
  const [drafting, startDrafting] = useTransition();
  const [draftError, setDraftError] = useState<ActionResult | null>(null);
  const confirm = useConfirm();

  function start() {
    setDraft({ highlights: highlights.join("\n"), decisions: decisions.join("\n") });
    clear();
    setDraftError(null);
    setFromAi(false);
    setEditing(true);
  }

  async function makeDraft() {
    if (!onDraft) return;
    // Never replace typed or saved text without asking.
    const current = editing ? draft : { highlights: highlights.join("\n"), decisions: decisions.join("\n") };
    if (current.highlights.trim() || current.decisions.trim()) {
      const yes = await confirm({
        title: "Erstat teksten med et udkast?",
        description:
          "Udkastet erstatter teksten i begge felter. Intet gemmes, før du trykker Gem noter, og Annuller beholder de gemte noter.",
        confirmLabel: "Lav udkast",
      });
      if (!yes) return;
    }
    setDraftError(null);
    clear();
    startDrafting(async () => {
      let answer: DraftResult;
      try {
        answer = await onDraft(month);
      } catch {
        answer = { ok: false, error: "Serveren kunne ikke nås. Prøv igen." };
      }
      if (!answer.ok) {
        setDraftError(answer);
        return;
      }
      setDraft({ highlights: answer.highlights, decisions: answer.decisions });
      setFromAi(true);
      setEditing(true);
    });
  }

  const draftButton = onDraft ? (
    <>
      <Button
        variant="secondary"
        size="compact"
        disabled={drafting || pending || draftDisabledReason !== null}
        aria-describedby={draftDisabledReason ? "notes-draft-reason" : undefined}
        onClick={() => void makeDraft()}
      >
        {drafting ? "Laver udkast…" : "Lav udkast"}
      </Button>
      {draftDisabledReason && (
        <span id="notes-draft-reason" className="text-[12px] text-[var(--ds-grey-medium-05)]">
          {draftDisabledReason}
        </span>
      )}
    </>
  ) : null;

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
          {draftButton}
          {updatedText && <span className="text-[12px] text-[var(--ds-grey-medium-05)]">{updatedText}</span>}
          <FormMessage result={result} />
          <FormMessage result={draftError} />
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
      {fromAi && (
        <p role="status" className="text-[13px] leading-[19px] text-[var(--ds-grey-medium-05)]">
          {DRAFT_HINT}
        </p>
      )}
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
        <Button type="submit" size="compact" disabled={pending || drafting}>
          {pending ? "Gemmer…" : "Gem noter"}
        </Button>
        <Button variant="secondary" size="compact" disabled={pending || drafting} onClick={() => setEditing(false)}>
          Annuller
        </Button>
        {draftButton}
        <FormMessage result={result && !result.ok ? result : null} />
        <FormMessage result={draftError} />
      </div>
    </form>
  );
}
