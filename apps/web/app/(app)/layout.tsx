import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { SectionNav } from "@/components/section-nav";
import { getSession } from "@/lib/auth";
import { FIXTURE_USER, fixturesEnabled } from "@/lib/fixtures-flag";

// App chrome for the authenticated views (as in optipeople.vola). This layout
// only *displays* the session; access enforcement lives in requireUser(),
// called by every page, because layouts don't re-run on client navigation.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const fixtures = fixturesEnabled();
  const session = fixtures ? null : await getSession();
  const source = fixtures ? FIXTURE_USER : session?.status === "ok" ? session.user : null;
  const user = source
    ? {
        email: source.email,
        name: source.name,
        roleName: source.roleName,
        accountName: source.accountName,
      }
    : undefined;

  return (
    <>
      <AppHeader user={user} fixtures={fixtures} />
      <SectionNav />
      <div className="flex-1">{children}</div>
    </>
  );
}
