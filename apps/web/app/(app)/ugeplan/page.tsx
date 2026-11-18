import type { Metadata } from "next";
import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@optipeople/ui";
import { EmptyState, KpiRow, KpiTile, PageHeader, PageShell, SectionTitle, TableFrame } from "@optipeople/ui/blocks";
import { WeekPlanDownloadButton } from "@/components/weekplan/download-button";
import { UnknownPositionsNotice } from "@/components/weekplan/unknown-notice";
import { WeekNav } from "@/components/weekplan/week-nav";
import { WeekPlanUpload } from "@/components/weekplan/weekplan-upload";
import { requireCapability } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { orderHref } from "@/lib/orders-view/params";
import { capitalize, formatLongDay, requestTime } from "@/lib/time";
import { loadPortalWeekPlan } from "@/lib/weekplan/portal";
import { defaultPlanWeek, mondayOf, parseWeekParam, shiftWeek, weekParam, type PlanWeek } from "@/lib/weekplan/week";

export const metadata: Metadata = { title: "Ugeplan" };

const hoursFormat = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const countFormat = new Intl.NumberFormat("da-DK");

const hrefFor = (w: PlanWeek) => `/ugeplan?uge=${weekParam(w)}`;

// The office's three week sheets in one workbook. The portal's production
// lists of the week are the source; the week's 3E file (.MDB) is optional on
// top, read in the browser (components/weekplan/weekplan-upload.tsx) and
// merged by /api/ugeplan. Docs: docs/ugeplan.md.
export default async function WeekPlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.uge) ? params.uge[0] : params.uge;
  const week = parseWeekParam(raw) ?? defaultPlanWeek(requestTime());
  const param = weekParam(week);
  const ctx = await requireCapability(hrefFor(week), "reports.view");
  const plan = await loadPortalWeekPlan(ctx.claims, week.year, week.week);

  const elements = plan.orders.reduce((sum, o) => sum + o.elements, 0);
  const known = plan.orders.filter((o) => o.hours !== null);
  const hours = known.reduce((sum, o) => sum + (o.hours ?? 0), 0);
  const noHourAccess = plan.orders.length > 0 && known.length === 0;
  // Hours are null either because the role may not read config.calculated_times
  // (the costs.view roles may) or because no calculated times are set up yet.
  const seesTimes = can(ctx.claims.role, "costs.view");
  const noHours = seesTimes ? "Ingen tider" : "Ikke vist";

  return (
    <PageShell>
      <PageHeader
        title="Ugeplan"
        intro="Ugens ark samlet i én Excel-fil."
        actions={
          <WeekPlanDownloadButton week={param} />
        }
      />

      <WeekNav
        label={`Uge ${week.week}, ${week.year}`}
        monday={capitalize(formatLongDay(mondayOf(week)))}
        previousHref={hrefFor(shiftWeek(week, -1))}
        nextHref={hrefFor(shiftWeek(week, 1))}
      />

      <KpiRow className="mt-6 lg:grid-cols-3">
        <KpiTile label="Ordrer" value={countFormat.format(plan.orders.length)} hint="Med produktionsliste i portalen" />
        <KpiTile label="Elementer" value={countFormat.format(elements)} hint="Karme ifølge produktionslisterne" />
        <KpiTile
          label="Timer"
          value={noHourAccess ? noHours : hoursFormat.format(hours)}
          hint={
            !noHourAccess
              ? "Beregnet tid for elementerne"
              : seesTimes
                ? "Ingen kalkulerede tider endnu. De sættes under Indstillinger, Tider"
                : "Din rolle kan ikke se beregnede tider"
          }
        />
      </KpiRow>

      <SectionTitle title="Ordrer i ugen" aside="Fra produktionslisterne i portalen" />
      {plan.orders.length === 0 ? (
        <EmptyState title={`Ingen produktionslister for uge ${week.week} endnu.`}>
          3E-filen kan stadig trækkes ind.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <UnknownPositionsNotice orders={plan.orders} />
          <TableFrame>
            <DataTable>
              <DataTableHead>
                <DataTableHeader>Ordre</DataTableHeader>
                <DataTableHeader>Kunde</DataTableHeader>
                <DataTableHeader>Ansv.</DataTableHeader>
                <DataTableHeader align="right">Elementer</DataTableHeader>
                <DataTableHeader align="right">Timer</DataTableHeader>
              </DataTableHead>
              <DataTableBody>
                {plan.orders.map((o) => (
                  <DataTableRow key={o.orderNo}>
                    <DataTableCell className="tabular-nums">
                      <Link href={orderHref(o.orderNo)} className="font-bold hover:underline">
                        {o.orderNo}
                      </Link>
                    </DataTableCell>
                    <DataTableCell>{o.customer || "Ukendt kunde"}</DataTableCell>
                    <DataTableCell>{o.responsible}</DataTableCell>
                    <DataTableCell align="right" className="tabular-nums">
                      {countFormat.format(o.elements)}
                    </DataTableCell>
                    <DataTableCell align="right" className="tabular-nums">
                      {o.hours === null ? noHours : hoursFormat.format(o.hours)}
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </TableFrame>
        </div>
      )}

      <SectionTitle title="3E-filen (valgfri)" />
      {/* Keyed by the week: a new week starts the 3E part over. */}
      <WeekPlanUpload key={param} week={param} />
    </PageShell>
  );
}
