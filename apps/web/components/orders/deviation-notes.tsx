import { Tag } from "@optipeople/ui";
import type { DeviationNote } from "@/lib/reports/types";

/** Notes shown before "Vis N mere". Problems come first, so they are always in view. */
const SHOWN = 6;

function NoteList({ notes }: { notes: DeviationNote[] }) {
  return (
    <ul className="mt-2 space-y-[6px]">
      {notes.map((n, i) => (
        <li key={`${n.code}-${n.barcode ?? ""}-${n.stationNo ?? ""}-${i}`} className="flex items-start gap-2 text-[14px] leading-[21px]">
          <Tag size="small" variant={n.severity === "problem" ? "issue" : "warning"} className="mt-[1px] shrink-0">
            {n.severity === "problem" ? "Problem" : "Hold øje"}
          </Tag>
          <span className="text-[var(--ds-grey-dark-09)]">{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Her gik det galt" / "Hold øje med" / "Ingen afvigelser", with the notes. Texts come from lib/reports. */
export function DeviationNotes({ notes, headline }: { notes: DeviationNote[]; headline: string }) {
  const problems = notes.filter((n) => n.severity === "problem").length;
  const tone =
    problems > 0
      ? "border-[var(--ds-tag-red-dark)] bg-[var(--ds-tag-red-light)]"
      : notes.length > 0
        ? "border-[var(--ds-tag-orange-dark)] bg-[var(--ds-tag-orange-light)]"
        : "border-[var(--ds-tag-green-dark)] bg-[var(--ds-tag-green-light)]";

  return (
    <section aria-label="Afvigelser" className={`rounded-[2px] border-l-4 p-4 ${tone}`}>
      <h2 className="text-[16px] font-bold leading-[22px] text-[var(--ds-grey-dark-09)]">{headline}</h2>
      {notes.length === 0 ? (
        <p className="mt-1 text-[14px] leading-[21px] text-[var(--ds-grey-dark-08)]">
          Ingen forsinkelse, intet omarbejde, ingen lange ventetider og ingen manglende scanninger.
        </p>
      ) : (
        <>
          <NoteList notes={notes.slice(0, SHOWN)} />
          {notes.length > SHOWN && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[14px] font-bold leading-[21px] text-[var(--ds-midnight-green)]">
                Vis {notes.length - SHOWN} mere
              </summary>
              <NoteList notes={notes.slice(SHOWN)} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
