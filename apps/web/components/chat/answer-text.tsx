// The assistant's text: the little markdown the system prompt allows
// (paragraphs, bullet and numbered lists, **bold**, `code`, simple pipe
// tables). Hand-rolled on purpose: the Markdown entry of @optipeople/ui
// pulls seven extra libraries, and nothing here renders HTML from the model.

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
        <strong key={m.index}>{token.slice(2, -2)}</strong>
      ) : (
        <code key={m.index} className="rounded-[2px] bg-[var(--ds-grey-light-01)] px-1 text-[13px]">
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

export function AnswerText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-[14px] leading-[22px] text-[var(--ds-grey-dark-09)]">
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <p key={i} className="font-bold">
                {inline(b.text)}
              </p>
            );
          case "p":
            return <p key={i}>{b.lines.flatMap((l, j) => (j === 0 ? inline(l) : [<br key={`br${j}`} />, ...inline(l)]))}</p>;
          case "ul":
            return (
              <ul key={i} className="list-disc pl-5">
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal pl-5">
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} className="border-b border-[var(--ds-grey-light-03)] px-2 py-1 text-left font-bold">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((c, k) => (
                          <td key={k} className="border-b border-[var(--ds-grey-light-02)] px-2 py-1">
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
