import type { ReactNode } from "react";
import { ConfirmProvider } from "@optipeople/ui";
import { PageHeader, PageShell, SubNav } from "@optipeople/ui/blocks";
import { getPortalAccess } from "@/lib/auth";
import { settingsSectionsFor } from "@/lib/settings/sections";

// The frame of Indstillinger: the page header and the sub-navigation with
// the sections this role may open. It only decides what is shown: every page
// below guards itself (a layout does not run again on client navigation),
// and row level security guards the data.
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const access = await getPortalAccess();
  const sections = access ? settingsSectionsFor(access.role) : [];

  return (
    <PageShell width="wide">
      <PageHeader
        title="Indstillinger"
        intro="Stamdata, tider, kalender og grænseværdier bag rapporterne, og hvem der har adgang."
      />
      {sections.length > 0 && (
        <SubNav
          label="Indstillinger"
          items={sections.map((s) => ({ label: s.label, href: s.href, hint: s.intro }))}
        />
      )}
      <ConfirmProvider>{children}</ConfirmProvider>
    </PageShell>
  );
}
