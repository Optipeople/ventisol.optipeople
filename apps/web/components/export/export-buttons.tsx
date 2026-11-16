// Excel and PDF download links for a report table or page.
// A server component: plain links styled as @optipeople/ui buttons, the
// route handlers (app/api/export) do the work.

import { buttonClasses } from "@optipeople/ui";
import type { ReportQueryName } from "@/lib/reports";

export interface ExportButtonsProps {
  /** The report query whose rows are exported. */
  report: ReportQueryName;
  /** The same parameters the page passes to the query. Undefined values are left out. */
  params: Record<string, string | number | undefined>;
  /** Also offer a PDF of the page. */
  pdf?: boolean;
  /** Optional text before the links, e.g. "Hent". */
  label?: string;
}

export function exportHref(kind: "xlsx" | "pdf", report: ReportQueryName, params: ExportButtonsProps["params"]): string {
  const search = new URLSearchParams({ report });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return `/api/export/${kind}?${search.toString()}`;
}

const linkClass = buttonClasses({ variant: "secondary", size: "sm" });

export function ExportButtons({ report, params, pdf = false, label }: ExportButtonsProps) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="Eksport">
      {label ? <span className="text-xs opacity-70">{label}</span> : null}
      <a href={exportHref("xlsx", report, params)} download className={linkClass} title="Hent som Excel">
        Excel
      </a>
      {pdf ? (
        <a href={exportHref("pdf", report, params)} download className={linkClass} title="Hent som PDF">
          PDF
        </a>
      ) : null}
    </div>
  );
}
