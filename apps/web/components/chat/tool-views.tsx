// A tool result in the chat: the small tables, bars and figures the tool
// prepared (ToolView in lib/tools/types.ts). Values come formatted from the
// server, so this file knows nothing about the report types.

import Link from "next/link";
import { BarList, KpiRow, KpiTile, Note } from "@optipeople/ui/blocks";
import {
  CheckIcon,
  CircleExclamationIcon,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import type { ToolResult, ToolView } from "@/lib/tools/types";

/** What the user sees while a tool runs and above its result. */
export const TOOL_LABELS: Record<string, string> = {
  find_order: "Finder ordrer",
  order_status: "Henter ordrestatus",
  order_route: "Henter ordrens rute",
  finished_orders: "Henter afsluttede ordrer",
  orders_in_progress: "Henter ordrer i gang",
  bottleneck: "Finder flaskehalsen",
  period_kpis: "Henter nøgletal",
  lead_time_series: "Henter gennemløbstid over tid",
  kpi_summary: "Henter overblikket",
  today: "Henter dagens tal",
  stations: "Henter stationer",
  station_day: "Henter stationernes dag",
  station_performance: "Henter stationernes ydelse",
  calc_vs_measured: "Sammenligner kalkule og målt",
  management_kpis: "Henter ledelsens nøgletal",
  monthly_lead_time: "Henter gennemløbstid pr. måned",
  missing_scan_outs: "Finder manglende ud-scanninger",
  incomplete_packed_orders: "Finder ordrer med manglende elementer",
  baseline_suggestion: "Beregner forslag til normaltider",
  capacity_plan: "Henter kapacitetsplan",
  staffing_analysis: "Henter bemanding",
  search_documents: "Søger i produktionslisterne",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

// The heading over one view, set like the small uppercase heading in an answer.
const VIEW_TITLE =
  "mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--ds-grey-medium-05)]";

function View({ view }: { view: ToolView }) {
  switch (view.kind) {
    case "note":
      return <p className="text-[14px] leading-[1.5] text-[var(--color-foreground)] sm:text-[15px]">{view.text}</p>;
    case "kpis":
      return (
        <div>
          <p className={VIEW_TITLE}>{view.title}</p>
          <KpiRow>
            {view.items.map((item) => (
              <KpiTile key={item.label} label={item.label} value={item.value} hint={item.note} />
            ))}
          </KpiRow>
        </div>
      );
    case "bars": {
      const display = new Map(view.items.map((i) => [i.value, i.display]));
      return (
        <div>
          <p className={VIEW_TITLE}>{view.title}</p>
          <BarList
            items={view.items.map((i) => ({ label: i.label, value: i.value, title: `${i.label}: ${i.display}` }))}
            formatValue={(v) => display.get(v) ?? String(v)}
            emptyLabel="Ingen data endnu"
          />
        </div>
      );
    }
    case "table":
      return (
        <div>
          <p className={VIEW_TITLE}>{view.title}</p>
          {view.rows.length === 0 ? (
            <Note className="mt-0">Ingen rækker.</Note>
          ) : (
            <div className="scroll-area max-h-[360px] overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-hairline)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
              <DataTable>
                <DataTableHead>
                  {view.columns.map((c) => (
                    <DataTableHeader key={c.key} align={c.align}>
                      {c.label}
                    </DataTableHeader>
                  ))}
                </DataTableHead>
                <DataTableBody>
                  {view.rows.map((row, i) => (
                    <DataTableRow key={i}>
                      {view.columns.map((c) => (
                        <DataTableCell key={c.key} align={c.align}>
                          {row[c.key]}
                        </DataTableCell>
                      ))}
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
          )}
          {view.total != null && view.total > view.rows.length && (
            <Note className="mt-1">
              Viser {view.rows.length} af {view.total}.
            </Note>
          )}
        </div>
      );
  }
}

/** A tool call that failed: one quiet line, kept in the stored conversation too. */
export function ToolFailedLine({ name }: { name: string }) {
  return (
    <p className="msg-in flex items-center gap-2 text-[14px] text-[var(--color-muted-foreground)] sm:text-[15px]">
      <CircleExclamationIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ds-red)]" />
      {toolLabel(name)}: tallene kunne ikke hentes.
    </p>
  );
}

/**
 * One finished tool call, without a box around it: a finished step line as in
 * Opti Assist, a link to the page with the same numbers, then its views.
 */
export function ToolResultCard({ name, result }: { name: string; result: ToolResult | undefined }) {
  const views = result?.views ?? [];
  return (
    <div className="msg-in flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[14px] text-[var(--color-muted-foreground)] sm:text-[15px]">
        <span className="flex items-center gap-2">
          <CheckIcon className="h-3.5 w-3.5 shrink-0" />
          {toolLabel(name)}
        </span>
        {result?.href && (
          <Link href={result.href} className="font-medium text-[var(--color-brand)] underline underline-offset-2">
            Se i portalen
          </Link>
        )}
      </div>
      {views.length === 0 ? (
        <p className="text-[14px] text-[var(--color-muted-foreground)] sm:text-[15px]">Data hentet.</p>
      ) : (
        views.map((view, i) => <View key={i} view={view} />)
      )}
    </div>
  );
}
