// A tool result in the chat: the small tables, bars and figures the tool
// prepared (ToolView in lib/tools/types.ts). Values come formatted from the
// server, so this file knows nothing about the report types.

import Link from "next/link";
import { BarList, KpiRow, KpiTile, Note } from "@optipeople/ui/blocks";
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableRow } from "@optipeople/ui";
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

function View({ view }: { view: ToolView }) {
  switch (view.kind) {
    case "note":
      return <p className="text-[13px] leading-[19px] text-[var(--ds-grey-dark-09)]">{view.text}</p>;
    case "kpis":
      return (
        <div>
          <p className="mb-2 text-[12px] font-bold text-[var(--ds-grey-medium-05)]">{view.title}</p>
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
          <p className="mb-2 text-[12px] font-bold text-[var(--ds-grey-medium-05)]">{view.title}</p>
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
          <p className="mb-2 text-[12px] font-bold text-[var(--ds-grey-medium-05)]">{view.title}</p>
          {view.rows.length === 0 ? (
            <Note className="mt-0">Ingen rækker.</Note>
          ) : (
            <div className="max-h-[360px] overflow-auto rounded-[2px] border border-[var(--ds-grey-light-02)]">
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

/** One finished tool call: its views and a link to the page with the same numbers. */
export function ToolResultCard({ name, result }: { name: string; result: ToolResult | undefined }) {
  const views = result?.views ?? [];
  return (
    <div className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--ds-grey-medium-04)]">
          {toolLabel(name)}
        </span>
        {result?.href && (
          <Link href={result.href} className="text-[12px] text-[var(--ds-blue-primary)] hover:underline">
            Se i portalen
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {views.length === 0 ? (
          <p className="text-[13px] text-[var(--ds-grey-medium-05)]">Data hentet.</p>
        ) : (
          views.map((view, i) => <View key={i} view={view} />)
        )}
      </div>
    </div>
  );
}
