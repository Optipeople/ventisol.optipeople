// The one download control of a page or a table.
// A server component: it builds the links to the route handlers
// (app/api/export). One file gives a plain link, "Download Excel". Several files
// give a single "Download" button that opens a list (the shared DropdownButton).

import { buttonClasses } from "@optipeople/ui";
import type { ReportQueryName } from "@/lib/reports";
import { ExportMenuButton, type ExportMenuItem } from "./export-menu-button";

export type ExportParams = Record<string, string | number | undefined>;

export interface ExportEntry {
  /** The report query whose rows are exported. */
  report: ReportQueryName;
  /** The same parameters the page passes to the query. Undefined values are left out. */
  params: ExportParams;
  /** What the file holds, e.g. "Nøgletal". Needed when the menu has more than one report. */
  name?: string;
  /** Also offer a PDF. */
  pdf?: boolean;
}

export function exportHref(kind: "xlsx" | "pdf", report: ReportQueryName, params: ExportParams): string {
  const search = new URLSearchParams({ report });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return `/api/export/${kind}?${search.toString()}`;
}

/** The menu lines: "Nøgletal (Excel)", or just "Excel" when the entry has no name. */
export function exportItems(entries: ReadonlyArray<ExportEntry>): ExportMenuItem[] {
  const items: ExportMenuItem[] = [];
  for (const entry of entries) {
    const line = (format: string) => (entry.name ? `${entry.name} (${format})` : format);
    items.push({ label: line("Excel"), href: exportHref("xlsx", entry.report, entry.params) });
    if (entry.pdf) items.push({ label: line("PDF"), href: exportHref("pdf", entry.report, entry.params) });
  }
  return items;
}

export function ExportMenu({ entries }: { entries: ReadonlyArray<ExportEntry> }) {
  const items = exportItems(entries);
  if (items.length === 0) return null;
  if (items.length === 1) {
    return (
      <a href={items[0].href} download className={buttonClasses({ variant: "secondary" })}>
        Download {items[0].label}
      </a>
    );
  }
  return <ExportMenuButton label="Download" items={items} />;
}
