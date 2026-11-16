import type { Metadata } from "next";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { EmptyState, FilterBar, SectionTitle, TableFrame } from "@optipeople/ui/blocks";
import { AuditPager } from "@/components/settings/audit-pager";
import { requireCapability } from "@/lib/auth";
import { isPortalRole, roleLabel } from "@/lib/portal/roles";
import { getAuditLogPage } from "@/lib/settings/audit-log";
import { dayKey, formatClock, formatCount, formatDisplayDay } from "@/lib/time";

export const metadata: Metadata = { title: "Hændelseslog" };

const PATH = "/indstillinger/log";

// Danish for the action codes the portal writes. A code that is not here is
// shown as it is, so a new action never disappears from the log.
const ACTION_LABELS: Readonly<Record<string, string>> = {
  "portal_user.created": "Bruger oprettet ved første login",
  "portal_user.role_changed": "Rolle ændret",
  "station.create": "Station tilføjet",
  "station.update": "Station ændret",
  "station.activate": "Station aktiveret",
  "station.deactivate": "Station deaktiveret",
  "element_type.create": "Elementtype tilføjet",
  "element_type.update": "Elementtype ændret",
  "element_type.restore_defaults": "Standardtyper gendannet",
  "normal_time.set": "Normaltid sat",
  "normal_time.clear": "Normaltid fjernet",
  "calculated_time.set": "Kalkuleret tid sat",
  "calculated_time.clear": "Kalkuleret tid fjernet",
  "calendar_shift.create": "Skift tilføjet",
  "calendar_shift.update": "Skift ændret",
  "calendar_shift.delete": "Skift fjernet",
  "closed_day.create": "Lukkedag tilføjet",
  "closed_day.update": "Lukkedag ændret",
  "closed_day.delete": "Lukkedag fjernet",
  "setting.update": "Indstilling ændret",
};

const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

/** The detail as one line of JSON: it is our own audit data, shown to admins only. */
function detailText(detail: Record<string, unknown>): string {
  return Object.keys(detail).length === 0 ? "" : JSON.stringify(detail);
}

type Search = { bruger?: string; handling?: string; side?: string };

const one = (value: unknown): string => (typeof value === "string" ? value : "");

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const user = one(params.bruger);
  const action = one(params.handling);
  const wantedPage = Number.parseInt(one(params.side), 10);

  const filters: Record<string, string> = {};
  if (user) filters.bruger = user;
  if (action) filters.handling = action;
  const qs = new URLSearchParams(filters);
  if (wantedPage > 1) qs.set("side", String(wantedPage));

  const ctx = await requireCapability(qs.size ? `${PATH}?${qs}` : PATH, "audit.view");
  const log = await getAuditLogPage(ctx.claims, {
    user,
    action,
    page: Number.isFinite(wantedPage) ? wantedPage : 1,
  });

  // A filter value from the URL that is not in the log still has to show in
  // its select, or the select would look empty while filtering.
  const userOptions = log.users.map((u) => ({ value: u.id, label: u.name }));
  if (user && !userOptions.some((o) => o.value === user)) userOptions.push({ value: user, label: user });
  const actionOptions = log.actions.map((a) => ({ value: a, label: actionLabel(a) }));
  if (action && !actionOptions.some((o) => o.value === action)) {
    actionOptions.push({ value: action, label: actionLabel(action) });
  }

  return (
    <div>
      <FilterBar
        basePath={PATH}
        searchable
        selects={[
          { param: "bruger", label: "Bruger", value: user, options: userOptions },
          { param: "handling", label: "Handling", value: action, options: actionOptions },
        ]}
        labels={{ all: "Alle", clear: "Ryd filtre", updating: "Opdaterer…" }}
      />

      <SectionTitle
        title="Hændelser"
        aside={
          log.total > 0
            ? `${formatCount(log.total, "hændelse", "hændelser")}, nyeste først. Side ${log.page} af ${log.pageCount}.`
            : undefined
        }
      />

      {log.entries.length === 0 ? (
        <EmptyState title={user || action ? "Ingen hændelser med de filtre" : "Ingen hændelser endnu"}>
          {user || action
            ? "Vælg en anden bruger eller handling, eller ryd filtrene."
            : "Hver ændring under Indstillinger og hver ny bruger bliver skrevet her."}
        </EmptyState>
      ) : (
        <>
          <TableFrame>
            <DataTable stickyHeader>
              <DataTableHead>
                <DataTableHeader>Tidspunkt</DataTableHeader>
                <DataTableHeader>Bruger</DataTableHeader>
                <DataTableHeader>Rolle</DataTableHeader>
                <DataTableHeader>Handling</DataTableHeader>
                <DataTableHeader>Emne</DataTableHeader>
                <DataTableHeader>Detaljer</DataTableHeader>
              </DataTableHead>
              <DataTableBody>
                {log.entries.map((entry) => {
                  const ms = entry.at.getTime();
                  return (
                    <DataTableRow key={entry.id}>
                      <DataTableCell className="whitespace-nowrap align-top tabular-nums">
                        {formatDisplayDay(dayKey(ms))} {formatClock(ms)}
                      </DataTableCell>
                      <DataTableCell className="align-top">
                        {entry.userName ?? entry.optiUserId ?? "Systemet"}
                      </DataTableCell>
                      <DataTableCell className="align-top">
                        {isPortalRole(entry.role) ? roleLabel(entry.role) : (entry.role ?? "")}
                      </DataTableCell>
                      <DataTableCell className="align-top" title={entry.action}>
                        {actionLabel(entry.action)}
                      </DataTableCell>
                      <DataTableCell className="align-top">{entry.subject ?? ""}</DataTableCell>
                      <DataTableCell className="max-w-[420px] break-all align-top font-mono text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
                        {detailText(entry.detail)}
                      </DataTableCell>
                    </DataTableRow>
                  );
                })}
              </DataTableBody>
            </DataTable>
          </TableFrame>
          {log.pageCount > 1 && (
            <div className="mt-4 flex justify-end">
              <AuditPager page={log.page} pageCount={log.pageCount} basePath={PATH} params={filters} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
