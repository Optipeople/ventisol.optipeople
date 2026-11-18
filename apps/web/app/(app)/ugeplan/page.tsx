import type { Metadata } from "next";
import { PageHeader, PageShell } from "@optipeople/ui/blocks";
import { WeekPlanUpload } from "@/components/weekplan/weekplan-upload";
import { requireCapability } from "@/lib/auth";

export const metadata: Metadata = { title: "Ugeplan" };

// The office drops the week's 3E file here and gets one workbook back. The
// file is read in the browser (components/weekplan/weekplan-upload.tsx); only
// the plan goes to /api/ugeplan. Docs: docs/ugeplan.md.
export default async function WeekPlanPage() {
  await requireCapability("/ugeplan", "reports.view");

  return (
    <PageShell>
      <PageHeader
        title="Ugeplan"
        intro="Træk ugens 3E-fil (.MDB) herind, og hent én samlet Excel-fil med Kontor, BKS og Kim_Produktion. Filen læses på din egen computer; kun de felter, arket bruger, sendes til portalen, som lægger produktionsstatus på."
      />
      <WeekPlanUpload />
    </PageShell>
  );
}
