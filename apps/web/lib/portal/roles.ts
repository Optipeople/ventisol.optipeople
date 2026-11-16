// Portal roles and what each may do. Pure: no I/O, safe to import anywhere,
// client components included.
//
// This is the only file that compares roles. Everything else asks
// can(role, capability) or hasAnyRole(role, roles), so a change to who may do
// what happens here and nowhere else. The database enforces the same table
// through row level security (docs/portal-architecture.md, section 3): this
// file decides what the portal shows and offers, RLS decides what a query
// may touch.

import type { PortalRole } from "@/lib/db";

export type { PortalRole };

/** Every role, most powerful first. */
export const PORTAL_ROLES: ReadonlyArray<PortalRole> = [
  "admin",
  "ledelse",
  "planner",
  "viewer",
];

/** The role with every capability. An OptiCloud super administrator always has it. */
export const ADMIN_ROLE: PortalRole = "admin";

/** What an unknown Ventisol user gets at first login, and the fallback when roles cannot be read. */
export const DEFAULT_ROLE: PortalRole = "viewer";

/** Danish names, as shown in the user menu and the user list. */
export const ROLE_LABELS: Readonly<Record<PortalRole, string>> = {
  admin: "Administrator",
  ledelse: "Ledelse",
  planner: "Planlægger",
  viewer: "Læser",
};

export function roleLabel(role: PortalRole): string {
  return ROLE_LABELS[role];
}

export function isPortalRole(value: unknown): value is PortalRole {
  return (
    typeof value === "string" &&
    (PORTAL_ROLES as ReadonlyArray<string>).includes(value)
  );
}

/** True when `role` is one of `roles`. */
export function hasAnyRole(
  role: PortalRole,
  roles: ReadonlyArray<PortalRole>
): boolean {
  return roles.includes(role);
}

export type Capability =
  /** Overblik, Stationer, Ordrer and the order page. */
  | "reports.view"
  /** The Ledelse tab: monthly reports, management notes, snapshots. */
  | "ledelse.view"
  /** Cost figures (kalkule, config.calculated_times). Never for a viewer. */
  | "costs.view"
  | "chat.use"
  /** The Indstillinger tab itself. What is inside it has its own capability. */
  | "settings.view"
  /** Normal times, calculated times, calendar and thresholds. */
  | "times.edit"
  /** Stations and element types. */
  | "masterdata.edit"
  /** Portal users and their roles. */
  | "users.manage"
  | "audit.view"
  | "sync.view";

const ALL = PORTAL_ROLES;

// Mirrors the access table in docs/portal-architecture.md section 3 and the
// role table in docs/web-portal-plan.md section 3.3.
const CAPABILITIES: Readonly<Record<Capability, ReadonlyArray<PortalRole>>> = {
  "reports.view": ALL,
  "ledelse.view": ["admin", "ledelse"],
  "costs.view": ["admin", "ledelse", "planner"],
  "chat.use": ALL,
  "settings.view": ["admin", "planner"],
  "times.edit": ["admin", "planner"],
  "masterdata.edit": ["admin"],
  "users.manage": ["admin"],
  "audit.view": ["admin"],
  "sync.view": ["admin"],
};

export const CAPABILITY_LIST = Object.keys(CAPABILITIES) as Capability[];

export function can(role: PortalRole, capability: Capability): boolean {
  return CAPABILITIES[capability].includes(role);
}

/** The roles that have `capability`, most powerful first. */
export function rolesWith(capability: Capability): ReadonlyArray<PortalRole> {
  return CAPABILITIES[capability];
}
