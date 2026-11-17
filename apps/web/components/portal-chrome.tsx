import type { ReactNode } from "react";
import {
  AppHeader,
  AppHeaderBadge,
  SectionNav,
  UserMenu,
} from "@optipeople/ui/blocks";
import { logout } from "@/app/login/actions";
import { ChatDock } from "@/components/chat/chat-dock";
import { getPortalAccess, getSession } from "@/lib/auth";
import { FIXTURE_USER, fixturesEnabled } from "@/lib/fixtures-flag";
import { navItemsFor } from "@/lib/portal/nav";
import { can, roleLabel } from "@/lib/portal/roles";

// App chrome for the authenticated views (as in optipeople.vola), shared by
// the layouts of app/(app) and app/(detail). It only *displays* the session
// and hides the tabs a role cannot use. Access enforcement lives in
// requireUser(), requireRole() and requireCapability(), called by every page,
// because layouts don't re-run on client navigation.
export async function PortalChrome({ children }: { children: ReactNode }) {
  const fixtures = fixturesEnabled();
  const session = fixtures ? null : await getSession();
  const user = fixtures ? FIXTURE_USER : session?.status === "ok" ? session.user : null;
  // Shared with the page through React cache: one role read per request.
  const access = user ? await getPortalAccess() : null;

  return (
    <>
      <AppHeader appName="Ventisol">
        {fixtures && <AppHeaderBadge>Eksempeldata</AppHeaderBadge>}
        {user && (
          <UserMenu
            user={{ email: user.email, name: user.name }}
            details={[
              {
                label: "Rolle",
                value: access
                  ? `${roleLabel(access.role)}${access.roleDegraded ? " (roller kunne ikke hentes)" : ""}`
                  : null,
              },
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
      {access && (
        <SectionNav items={navItemsFor(access.role)} width="wide" label="Portal" />
      )}
      <div className="flex-1">{children}</div>
      {/* The chat on every page. Shown by role only: the chat route checks the role itself. */}
      {access && can(access.role, "chat.use") && <ChatDock />}
    </>
  );
}
