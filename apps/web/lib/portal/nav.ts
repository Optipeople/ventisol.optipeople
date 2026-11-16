// The portal's top navigation, by role. Pure, so it is unit tested.
//
// This only decides which tabs are shown. It protects nothing: every page
// calls requireUser, requireRole or requireCapability itself, because a
// layout does not run again on client navigation.

import { can, type Capability, type PortalRole } from "@/lib/portal/roles";

export type NavItem = {
  label: string;
  href: string;
  /** Paths the tab is active on, pages below them included. Defaults to href. */
  match?: string[];
};

type NavEntry = NavItem & { needs: Capability };

const NAV: ReadonlyArray<NavEntry> = [
  { label: "Overblik", href: "/", needs: "reports.view" },
  { label: "Stationer", href: "/stationer", needs: "reports.view" },
  {
    label: "Ordrer",
    href: "/ordrer",
    // /ordrer shows the period report for now, and the order page belongs here.
    match: ["/ordrer", "/periode", "/ordre"],
    needs: "reports.view",
  },
  { label: "Ledelse", href: "/ledelse", needs: "ledelse.view" },
  { label: "Chat", href: "/chat", needs: "chat.use" },
  { label: "Indstillinger", href: "/indstillinger", needs: "settings.view" },
];

/** The tabs `role` sees, in order. Plain objects, safe to hand to a client component. */
export function navItemsFor(role: PortalRole): NavItem[] {
  return NAV.filter((entry) => can(role, entry.needs)).map(
    ({ label, href, match }) => (match ? { label, href, match } : { label, href })
  );
}
