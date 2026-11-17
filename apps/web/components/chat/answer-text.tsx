// The assistant's text: the little markdown the system prompt allows
// (paragraphs, bullet and numbered lists, **bold**, `code`, simple pipe
// tables), set like the Markdown of @optipeople/ui that Opti Assist uses:
// same sizes, bullets, step badges and table frame. Hand-rolled because that
// entry needs seven libraries this app does not install, and nothing here
// renders HTML from the model.

import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    out.push(
      token.startsWith("**") ? (
        <strong key={m.index} className="font-semibold text-[var(--color-foreground)]">
          {token.slice(2, -2)}
        </strong>
      ) : (
        <code key={m.index} className="rounded-[4px] bg-[var(--color-muted)] px-1.5 py-0.5 text-[0.86em]">
          {token.slice(1, -1)}
        </code>
      )
    );
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "h"; text: string };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const prev = out[out.length - 1];
    if (trimmed === "") {
      out.push({ kind: "p", lines: [] });
      continue;
    }
    if (/^#{1,4}\s/.test(trimmed)) {
      out.push({ kind: "h", text: trimmed.replace(/^#+\s*/, "") });
      continue;
    }
    if (trimmed.startsWith("|") && /^\|?\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? "")) {
      const head = cells(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i -= 1;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1];
      if (prev?.kind === kind) prev.items.push(item);
      else out.push({ kind, items: [item] });
      continue;
    }
    if (prev?.kind === "p") prev.lines.push(trimmed);
    else out.push({ kind: "p", lines: [trimmed] });
  }
  return out.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

// A bullet, or a numbered step badge when the list is numbered.
const ITEM = [
  "relative pl-5 leading-[1.6]",
  "before:absolute before:left-1 before:top-[0.68em] before:h-[6px] before:w-[6px] before:rounded-full before:bg-[var(--color-accent)]/70",
].join(" ");
const STEP = [
  "relative pl-9 leading-[1.6] [counter-increment:step] before:content-[counter(step)]",
  "before:absolute before:left-0 before:top-[0.12em] before:flex before:h-[2.1em] before:w-[2.1em]",
  "before:items-center before:justify-center before:rounded-full before:bg-[var(--color-brand)]",
  "before:text-[0.7em] before:font-semibold before:leading-none before:text-white before:tabular-nums",
].join(" ");

export function AnswerText({ text }: { text: string }) {
  return (
    <div className="break-words text-[16px] leading-[1.6] text-[var(--color-foreground)] sm:text-[19px] sm:leading-[1.7]">
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <p key={i} className="mb-2 mt-6 text-[1.08em] font-semibold leading-snug tracking-tight first:mt-0">
                {inline(b.text)}
              </p>
            );
          case "p":
            return (
              <p key={i} className="my-3 leading-[1.65] first:mt-0 last:mb-0">
                {b.lines.flatMap((l, j) => (j === 0 ? inline(l) : [<br key={`br${j}`} />, ...inline(l)]))}
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="my-3 list-none space-y-1.5 first:mt-0 last:mb-0">
                {b.items.map((item, j) => (
                  <li key={j} className={ITEM}>
                    {inline(item)}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="my-3 list-none space-y-2.5 [counter-reset:step] first:mt-0 last:mb-0">
                {b.items.map((item, j) => (
                  <li key={j} className={STEP}>
                    {inline(item)}
                  </li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div
                key={i}
                className="my-4 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-hairline)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]"
              >
                <table className="w-full border-collapse text-[0.84em] leading-[1.5]">
                  <thead className="bg-[var(--ds-panel-header-bg)] text-left">
                    <tr>
                      {b.head.map((h, j) => (
                        <th
                          key={j}
                          className="whitespace-nowrap border-b border-[var(--color-border)] px-3.5 py-2.5 text-[0.86em] font-semibold uppercase tracking-[0.04em] text-[var(--ds-grey-medium-05)]"
                        >
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&>tr:nth-child(even)]:bg-[var(--ds-grey-light-01)]">
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((c, k) => (
                          <td
                            key={k}
                            className="border-b border-[var(--color-hairline)] px-3.5 py-2.5 align-top [tr:last-child>&]:border-b-0"
                          >
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
