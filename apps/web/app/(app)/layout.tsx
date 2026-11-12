import type { ReactNode } from "react";
import {
  AppHeader,
  AppHeaderBadge,
  SectionNav,
  UserMenu,
  type SectionNavItem,
} from "@optipeople/ui/blocks";
import { logout } from "@/app/login/actions";
import { getSession } from "@/lib/auth";
import { FIXTURE_USER, fixturesEnabled } from "@/lib/fixtures-flag";

// The order page belongs to the day overview it is opened from.
const NAV_ITEMS: ReadonlyArray<SectionNavItem> = [
  { label: "Dagsoverblik", href: "/", match: ["/", "/ordre"] },
  { label: "Periode", href: "/periode" },
];

// App chrome for the authenticated views (as in optipeople.vola). This layout
// only *displays* the session; access enforcement lives in requireUser(),
// called by every page, because layouts don't re-run on client navigation.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const fixtures = fixturesEnabled();
  const session = fixtures ? null : await getSession();
  const user = fixtures ? FIXTURE_USER : session?.status === "ok" ? session.user : null;

  return (
    <>
      <AppHeader appName="Ventisol">
        {fixtures && <AppHeaderBadge>Eksempeldata</AppHeaderBadge>}
        {user && (
          <UserMenu
            user={{ email: user.email, name: user.name }}
            details={[
              { label: "Rolle", value: user.roleName },
              { label: "Konto", value: user.accountName },
            ]}
            logoutAction={logout}
            labels={{
              welcome: "Velkommen, {name}",
              loggedInAs: "Logget ind som",
              logout: "Log ud",
            }}
          />
        )}
      </AppHeader>
      <SectionNav items={NAV_ITEMS} width="wide" label="Rapporter" />
      <div className="flex-1">{children}</div>
    </>
  );
}
