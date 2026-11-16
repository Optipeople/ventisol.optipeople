// Portal users: who has which role in the Ventisol portal.
//
// WHO GETS IN, AND AS WHAT
//
// Identity is OptiCloud's (lib/auth.ts): only an OptiCloud super
// administrator or a user in the Ventisol account gets a session at all.
// What that user may do in the portal is decided here, from the table
// app.portal_users (opti_user_id -> role).
//
// - Roles: admin (Administrator), ledelse (Ledelse), planner (Planlægger),
//   viewer (Læser). What each may do is in lib/portal/roles.ts.
// - An OptiCloud super administrator is always admin. No row is needed and
//   none is created. If a row exists its role is ignored and only its
//   last_seen_at is kept fresh.
// - Any other user (so: a user in the Ventisol account) gets the role in
//   their row. At first login there is no row: one is created with the role
//   viewer, and an admin promotes them under Indstillinger. Nobody becomes
//   more than a viewer without an admin doing it.
// - last_seen_at, e-mail and name are refreshed at most every
//   LAST_SEEN_INTERVAL_MS, not on every request.
// - Roles are changed with setPortalUserRole. It runs as the acting user, so
//   row level security is what stops a non-admin. It is audited, an admin
//   cannot change their own role (another admin has to, so nobody locks
//   themselves out by a slip), and the last admin row cannot be demoted.
//
// WHEN THE DATABASE IS DOWN
//
// resolvePortalUser throws. lib/auth.ts catches that: a super administrator
// stays admin (they never needed the database), everyone else is treated as
// a viewer for that request, with roleDegraded set and the error logged.
// Pages that only need a valid OptiCloud login still render; everything
// gated above viewer answers "no access, try again" until the database is
// back. Nothing is cached across requests, so recovery is immediate.
//
// app.instance holds the OptiCloud account id of this deployment, which the
// RLS helper app.has_role compares every claim against. It is written once,
// by the first resolvePortalUser call that reaches the database, and never
// overwritten: a different VENTISOL_ACCOUNT_ID later is logged as an error
// and row level security then refuses everyone, which is the safe way round.

import {
  onFixtureDbReady,
  withService,
  withUser,
  type Claims,
  type Db,
} from "@/lib/db";
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_ROLE,
  FIXTURE_USER,
} from "@/lib/fixtures-flag";
import { audit, auditAsService } from "@/lib/portal/audit";
import {
  ADMIN_ROLE,
  can,
  DEFAULT_ROLE,
  isPortalRole,
  type PortalRole,
} from "@/lib/portal/roles";

/** How often a user's last_seen_at (and e-mail and name) is refreshed. */
export const LAST_SEEN_INTERVAL_MS = 5 * 60_000;

/** The part of the OptiCloud session user that the portal keeps. */
export type PortalSessionUser = {
  id: string;
  email: string;
  name: string | null;
};

export type PortalIdentity = {
  role: PortalRole;
  /** What withUser needs to run queries as this user. */
  claims: Claims;
  /** Where the role came from. "created" is a first login. */
  source: "super_admin" | "row" | "created";
};

export type PortalUser = {
  optiUserId: string;
  email: string | null;
  name: string | null;
  role: PortalRole;
  createdAt: Date;
  lastSeenAt: Date | null;
  createdBy: string | null;
};

type UserRow = {
  opti_user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  created_at: Date | string;
  last_seen_at: Date | string | null;
  created_by: string | null;
};

const USER_COLUMNS =
  "opti_user_id, email, name, role, created_at, last_seen_at, created_by";

function toPortalUser(row: UserRow): PortalUser {
  return {
    optiUserId: row.opti_user_id,
    email: row.email,
    name: row.name,
    // The table has a check constraint; this only guards against a role
    // added in the database before the code knows it.
    role: isPortalRole(row.role) ? row.role : DEFAULT_ROLE,
    createdAt: new Date(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at),
    createdBy: row.created_by,
  };
}

// --- app.instance ---

// Per server instance. Kept on globalThis, like the pool in lib/db: `next
// dev` evaluates this module again for every route and hot reload, and a
// module-level variable would forget what it knew each time.
type Memory = {
  /** The account id that is known to be in app.instance. */
  instanceEnsuredFor: string | null;
  /**
   * When a super administrator's optional row was last touched. Other users
   * are throttled by last_seen_at itself, which the role read returns anyway.
   */
  superAdminTouched: Map<string, number>;
};

const memoryKey = Symbol.for("ventisol.portal.users");
const memoryStore = globalThis as unknown as { [memoryKey]?: Memory };

function memory(): Memory {
  return (memoryStore[memoryKey] ??= {
    instanceEnsuredFor: null,
    superAdminTouched: new Map(),
  });
}

/**
 * Make sure app.instance holds this deployment's account id. Writes it when
 * the table is empty, never overwrites. Must run in a withService
 * transaction.
 */
export async function ensureInstance(db: Db, accountId: string): Promise<void> {
  const wanted = accountId.trim().toLowerCase();
  if (memory().instanceEnsuredFor === wanted) return;
  await db.query(
    // The table's key allows one row only, so a second writer does nothing.
    `insert into app.instance (account_id) values ($1::uuid)
     on conflict (id) do nothing`,
    [wanted]
  );
  const rows = await db.query<{ account_id: string }>(
    "select account_id::text as account_id from app.instance limit 1"
  );
  const stored = rows[0]?.account_id?.toLowerCase() ?? null;
  if (stored !== wanted) {
    console.error(
      `ensureInstance: app.instance holds account ${stored}, but this deployment runs as ${wanted}. ` +
        "Row level security will refuse every user until VENTISOL_ACCOUNT_ID and app.instance agree."
    );
    return;
  }
  memory().instanceEnsuredFor = wanted;
}

// Fixture mode (VENTISOL_FIXTURES=1 under `next dev`) never calls
// resolvePortalUser: the fixture user is admin without a lookup. So the
// fixture database gets its instance row, and a row for the fixture user,
// from this seed instead. Registering does nothing outside fixture mode.
onFixtureDbReady("portal-users", async ({ withService: service }) => {
  await service(async (db) => {
    await db.query(
      `insert into app.instance (account_id) values ($1::uuid)
       on conflict (id) do nothing`,
      [FIXTURE_ACCOUNT_ID]
    );
    await db.query(
      `insert into app.portal_users (opti_user_id, email, name, role, last_seen_at, created_by)
       values ($1, $2, $3, $4, now(), null)
       on conflict (opti_user_id) do nothing`,
      [FIXTURE_USER.id, FIXTURE_USER.email, FIXTURE_USER.name, FIXTURE_ROLE]
    );
  });
});

// --- Resolving the signed-in user ---

/** Forget the per-process memory. For tests, which swap the database under it. */
export function resetPortalUserCaches(): void {
  memory().instanceEnsuredFor = null;
  memory().superAdminTouched.clear();
}

/**
 * The portal role and claims of a signed-in OptiCloud user. See the header
 * of this file for the rules. Throws when the database cannot be reached,
 * except for a super administrator, who never needs it.
 *
 * `accountId` is the Ventisol account (ventisolAccountId()), not the user's
 * own account: a super administrator from another account acts on Ventisol's
 * data.
 */
export async function resolvePortalUser(
  user: PortalSessionUser,
  accountId: string,
  options: { superAdmin?: boolean; now?: number } = {}
): Promise<PortalIdentity> {
  const now = options.now ?? Date.now();
  const claimsFor = (role: PortalRole): Claims => ({
    accountId: accountId.trim().toLowerCase(),
    optiUserId: user.id,
    role,
  });

  if (options.superAdmin) {
    const touched = memory().superAdminTouched;
    const last = touched.get(user.id);
    if (last === undefined || now - last >= LAST_SEEN_INTERVAL_MS) {
      // Counted even when it fails, so a database that is down costs a super
      // administrator one slow request per interval, not every request.
      touched.set(user.id, now);
      try {
        await withService(async (db) => {
          await ensureInstance(db, accountId);
          await db.query(
            `update app.portal_users
                set last_seen_at = now(), email = $2, name = $3
              where opti_user_id = $1`,
            [user.id, user.email, user.name]
          );
        });
      } catch (err) {
        console.error(
          "resolvePortalUser: could not reach the database for a super administrator (still admin):",
          err
        );
      }
    }
    return { role: ADMIN_ROLE, claims: claimsFor(ADMIN_ROLE), source: "super_admin" };
  }

  return withService(async (db) => {
    await ensureInstance(db, accountId);

    const found = await db.query<UserRow>(
      `select ${USER_COLUMNS} from app.portal_users where opti_user_id = $1`,
      [user.id]
    );

    if (found.length === 0) {
      // First login. "do nothing" covers two first requests racing each other.
      const inserted = await db.query<{ role: string }>(
        `insert into app.portal_users (opti_user_id, email, name, role, last_seen_at, created_by)
         values ($1, $2, $3, $4, now(), null)
         on conflict (opti_user_id) do nothing
         returning role`,
        [user.id, user.email, user.name, DEFAULT_ROLE]
      );
      if (inserted.length > 0) {
        await auditAsService(
          db,
          { optiUserId: user.id, role: DEFAULT_ROLE },
          "portal_user.created",
          user.id,
          { role: DEFAULT_ROLE, reason: "first_login" }
        );
        return { role: DEFAULT_ROLE, claims: claimsFor(DEFAULT_ROLE), source: "created" };
      }
      const again = await db.query<UserRow>(
        `select ${USER_COLUMNS} from app.portal_users where opti_user_id = $1`,
        [user.id]
      );
      const role = again[0] ? toPortalUser(again[0]).role : DEFAULT_ROLE;
      return { role, claims: claimsFor(role), source: "row" };
    }

    const row = toPortalUser(found[0]);
    const stale =
      row.lastSeenAt === null ||
      now - row.lastSeenAt.getTime() >= LAST_SEEN_INTERVAL_MS;
    if (stale) {
      await db.query(
        `update app.portal_users
            set last_seen_at = now(), email = $2, name = $3
          where opti_user_id = $1`,
        [user.id, user.email, user.name]
      );
    }
    return { role: row.role, claims: claimsFor(row.role), source: "row" };
  });
}

// --- The user list and role changes (Indstillinger) ---

/**
 * The portal users, by name. Runs as the caller: row level security gives an
 * admin every row and anyone else only their own.
 */
export async function listPortalUsers(claims: Claims): Promise<PortalUser[]> {
  return withUser(claims, async (db) => {
    const rows = await db.query<UserRow>(
      `select ${USER_COLUMNS}
         from app.portal_users
        order by lower(coalesce(name, email, opti_user_id)), opti_user_id`
    );
    return rows.map(toPortalUser);
  });
}

export type SetRoleResult =
  | { ok: true; user: PortalUser; changed: boolean }
  | {
      ok: false;
      reason:
        /** The caller may not manage users. */
        | "forbidden"
        /** No such portal user (they have never logged in). */
        | "not_found"
        | "invalid_role"
        /** An admin cannot change their own role: another admin has to. */
        | "own_role"
        /** It would leave the portal without an admin row. */
        | "last_admin";
    };

/** Danish text for a refused role change. */
export const SET_ROLE_ERRORS: Readonly<
  Record<Extract<SetRoleResult, { ok: false }>["reason"], string>
> = {
  forbidden: "Du har ikke rettigheder til at ændre brugeres roller.",
  not_found: "Brugeren findes ikke i portalen. Brugeren skal logge ind én gang først.",
  invalid_role: "Ukendt rolle.",
  own_role: "Du kan ikke ændre din egen rolle. Bed en anden administrator om det.",
  last_admin: "Portalen skal have mindst én administrator.",
};

/**
 * Give `targetUserId` the role `role`, as the user in `claims`.
 *
 * Runs in one withUser transaction, so the update is subject to row level
 * security (only an admin's update touches a row) and the audit row is saved
 * with it or not at all.
 */
export async function setPortalUserRole(
  claims: Claims,
  targetUserId: string,
  role: PortalRole
): Promise<SetRoleResult> {
  if (!isPortalRole(role)) return { ok: false, reason: "invalid_role" };
  // A friendly answer for the UI. The enforcement is the policy on the table.
  if (!can(claims.role, "users.manage")) return { ok: false, reason: "forbidden" };
  if (targetUserId === claims.optiUserId) return { ok: false, reason: "own_role" };

  return withUser(claims, async (db): Promise<SetRoleResult> => {
    // Lock the admin rows first, so two admins demoting each other at the
    // same moment cannot both pass the last-admin check.
    const admins = await db.query<{ opti_user_id: string }>(
      `select opti_user_id from app.portal_users where role = $1 for update`,
      [ADMIN_ROLE]
    );
    const found = await db.query<UserRow>(
      `select ${USER_COLUMNS} from app.portal_users where opti_user_id = $1 for update`,
      [targetUserId]
    );
    if (found.length === 0) return { ok: false, reason: "not_found" };

    const before = toPortalUser(found[0]);
    if (before.role === role) return { ok: true, user: before, changed: false };

    const isAdminRow = admins.some((a) => a.opti_user_id === targetUserId);
    if (isAdminRow && admins.length <= 1) return { ok: false, reason: "last_admin" };

    const updated = await db.query<UserRow>(
      `update app.portal_users set role = $2 where opti_user_id = $1 returning ${USER_COLUMNS}`,
      [targetUserId, role]
    );
    // The policy let the row be read but not written.
    if (updated.length === 0) return { ok: false, reason: "forbidden" };

    await audit(db, "portal_user.role_changed", targetUserId, {
      from: before.role,
      to: role,
      email: before.email,
    });
    return { ok: true, user: toPortalUser(updated[0]), changed: true };
  });
}
