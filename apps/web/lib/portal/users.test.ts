// Portal users, role changes and the audit trail, against the real migrations
// on an in-process PGlite (createTestDb). Row level security is on, so these
// tests also show what the policies let each role do.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withService, withUser, type Claims } from "@/lib/db";
import { createTestDb } from "@/lib/db/testing";
import { audit, listAuditLog } from "@/lib/portal/audit";
import {
  LAST_SEEN_INTERVAL_MS,
  listPortalUsers,
  resetPortalUserCaches,
  resolvePortalUser,
  setPortalUserRole,
} from "@/lib/portal/users";
import type { PortalRole } from "@/lib/portal/roles";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

const anna = { id: "u-anna", email: "anna@ventisol.dk", name: "Anna" };
const bente = { id: "u-bente", email: "bente@ventisol.dk", name: "Bente" };
const staff = { id: "u-staff", email: "staff@optipeople.dk", name: "Staff" };

const claims = (optiUserId: string, role: PortalRole, accountId = ACCOUNT): Claims => ({
  accountId,
  optiUserId,
  role,
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  resetPortalUserCaches();
  await withService(async (db) => {
    await db.query("delete from app.audit_log");
    await db.query("delete from app.portal_users");
    await db.query("delete from app.instance");
  });
});

async function userRow(id: string) {
  const rows = await withService((db) =>
    db.query<{ role: string; email: string | null; name: string | null; last_seen_at: Date | string | null }>(
      "select role, email, name, last_seen_at from app.portal_users where opti_user_id = $1",
      [id]
    )
  );
  return rows[0];
}

async function auditRows() {
  return withService((db) =>
    db.query<{ opti_user_id: string | null; role: string | null; action: string; subject: string | null; detail: Record<string, unknown> }>(
      "select opti_user_id, role, action, subject, detail from app.audit_log order by id"
    )
  );
}

/** Give a user a row with this role, the way an admin would have. */
async function seed(user: typeof anna, role: PortalRole) {
  await withService((db) =>
    db.query(
      "insert into app.portal_users (opti_user_id, email, name, role, last_seen_at) values ($1, $2, $3, $4, now())",
      [user.id, user.email, user.name, role]
    )
  );
}

async function ensureInstance() {
  await resolvePortalUser(staff, ACCOUNT, { superAdmin: true });
}

describe("resolvePortalUser", () => {
  it("creates a viewer row at first login, audits it and writes app.instance", async () => {
    const identity = await resolvePortalUser(anna, ACCOUNT);
    expect(identity).toEqual({
      role: "viewer",
      claims: { accountId: ACCOUNT, optiUserId: "u-anna", role: "viewer" },
      source: "created",
    });

    const row = await userRow("u-anna");
    expect(row).toMatchObject({ role: "viewer", email: "anna@ventisol.dk", name: "Anna" });
    expect(row.last_seen_at).not.toBeNull();

    expect(await auditRows()).toEqual([
      {
        opti_user_id: "u-anna",
        role: "viewer",
        action: "portal_user.created",
        subject: "u-anna",
        detail: { role: "viewer", reason: "first_login" },
      },
    ]);

    const instance = await withService((db) =>
      db.query<{ account_id: string }>("select account_id::text as account_id from app.instance")
    );
    expect(instance).toEqual([{ account_id: ACCOUNT }]);
  });

  it("the claims it returns pass row level security", async () => {
    const identity = await resolvePortalUser(anna, ACCOUNT);
    const own = await listPortalUsers(identity.claims);
    expect(own.map((u) => u.optiUserId)).toEqual(["u-anna"]);
  });

  it("returns the existing row afterwards, without a second row or audit entry", async () => {
    await resolvePortalUser(anna, ACCOUNT);
    const again = await resolvePortalUser(anna, ACCOUNT);
    expect(again.source).toBe("row");
    expect(again.role).toBe("viewer");
    expect(await auditRows()).toHaveLength(1);
  });

  it("uses the role an admin has given", async () => {
    await seed(bente, "planner");
    const identity = await resolvePortalUser(bente, ACCOUNT);
    expect(identity.role).toBe("planner");
    expect(identity.claims.role).toBe("planner");
    expect(identity.source).toBe("row");
  });

  it("refreshes last_seen_at, e-mail and name only after the interval", async () => {
    await resolvePortalUser(anna, ACCOUNT);
    const first = new Date((await userRow("u-anna")).last_seen_at!).getTime();

    // Inside the interval: nothing is written, not even a changed name.
    const renamed = { ...anna, name: "Anna Hansen", email: "anna.hansen@ventisol.dk" };
    await resolvePortalUser(renamed, ACCOUNT, { now: first + LAST_SEEN_INTERVAL_MS - 1000 });
    let row = await userRow("u-anna");
    expect(new Date(row.last_seen_at!).getTime()).toBe(first);
    expect(row.name).toBe("Anna");

    // After it: one write, and the row follows OptiCloud.
    await new Promise((r) => setTimeout(r, 5));
    await resolvePortalUser(renamed, ACCOUNT, { now: first + LAST_SEEN_INTERVAL_MS });
    row = await userRow("u-anna");
    expect(new Date(row.last_seen_at!).getTime()).toBeGreaterThan(first);
    expect(row).toMatchObject({ name: "Anna Hansen", email: "anna.hansen@ventisol.dk" });
  });

  it("a super administrator is admin without a row, and none is created", async () => {
    const identity = await resolvePortalUser(staff, ACCOUNT, { superAdmin: true });
    expect(identity).toEqual({
      role: "admin",
      claims: { accountId: ACCOUNT, optiUserId: "u-staff", role: "admin" },
      source: "super_admin",
    });
    expect(await userRow("u-staff")).toBeUndefined();
    // The instance row is there, so the admin claims work at once.
    expect(await listPortalUsers(identity.claims)).toEqual([]);
  });

  it("a super administrator is admin whatever their row says", async () => {
    await seed(staff, "viewer");
    const identity = await resolvePortalUser(staff, ACCOUNT, { superAdmin: true });
    expect(identity.role).toBe("admin");
    expect((await userRow("u-staff")).role).toBe("viewer");
  });

  it("never overwrites app.instance: another account id is logged and refused by RLS", async () => {
    await resolvePortalUser(anna, ACCOUNT);
    resetPortalUserCaches();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const identity = await resolvePortalUser(bente, OTHER_ACCOUNT);
      expect(error).toHaveBeenCalledTimes(1);
      const instance = await withService((db) =>
        db.query<{ account_id: string }>("select account_id::text as account_id from app.instance")
      );
      expect(instance).toEqual([{ account_id: ACCOUNT }]);
      // Claims of the wrong account see nothing, not even their own row.
      expect(await listPortalUsers(identity.claims)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("listPortalUsers", () => {
  beforeEach(async () => {
    await ensureInstance();
    await seed(anna, "admin");
    await seed(bente, "planner");
  });

  it("an admin sees everyone, by name", async () => {
    const users = await listPortalUsers(claims("u-anna", "admin"));
    expect(users.map((u) => [u.name, u.role])).toEqual([
      ["Anna", "admin"],
      ["Bente", "planner"],
    ]);
    expect(users[0].createdAt).toBeInstanceOf(Date);
  });

  it("anyone else sees only their own row", async () => {
    const users = await listPortalUsers(claims("u-bente", "planner"));
    expect(users.map((u) => u.optiUserId)).toEqual(["u-bente"]);
  });

  it("a claimed admin role from another account sees nothing", async () => {
    expect(await listPortalUsers(claims("u-anna", "admin", OTHER_ACCOUNT))).toEqual([]);
  });
});

describe("setPortalUserRole", () => {
  beforeEach(async () => {
    await ensureInstance();
    await seed(anna, "admin");
    await seed(bente, "viewer");
  });

  it("an admin changes a role, and it is audited with who, what, from and to", async () => {
    const result = await setPortalUserRole(claims("u-anna", "admin"), "u-bente", "planner");
    expect(result).toMatchObject({ ok: true, changed: true, user: { optiUserId: "u-bente", role: "planner" } });
    expect((await userRow("u-bente")).role).toBe("planner");
    expect(await auditRows()).toEqual([
      {
        opti_user_id: "u-anna",
        role: "admin",
        action: "portal_user.role_changed",
        subject: "u-bente",
        detail: { from: "viewer", to: "planner", email: "bente@ventisol.dk" },
      },
    ]);
  });

  it("setting the role a user already has changes and audits nothing", async () => {
    const result = await setPortalUserRole(claims("u-anna", "admin"), "u-bente", "viewer");
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditRows()).toEqual([]);
  });

  it("refuses anyone who is not an admin", async () => {
    for (const role of ["ledelse", "planner", "viewer"] as const) {
      expect(await setPortalUserRole(claims("u-bente", role), "u-anna", "viewer")).toEqual({
        ok: false,
        reason: "forbidden",
      });
    }
    expect((await userRow("u-anna")).role).toBe("admin");
  });

  it("row level security is the enforcement: a non-admin's own update touches no row", async () => {
    const updated = await withUser(claims("u-bente", "viewer"), (db) =>
      db.query("update app.portal_users set role = 'admin' returning opti_user_id")
    );
    expect(updated).toEqual([]);
    expect((await userRow("u-bente")).role).toBe("viewer");

    // And a non-admin cannot add a row either.
    await expect(
      withUser(claims("u-bente", "viewer"), (db) =>
        db.query("insert into app.portal_users (opti_user_id, role) values ('u-new', 'admin')")
      )
    ).rejects.toThrow();
  });

  it("an admin cannot change their own role", async () => {
    await seed({ id: "u-carl", email: "carl@ventisol.dk", name: "Carl" }, "admin");
    expect(await setPortalUserRole(claims("u-anna", "admin"), "u-anna", "viewer")).toEqual({
      ok: false,
      reason: "own_role",
    });
    expect((await userRow("u-anna")).role).toBe("admin");
  });

  it("the last admin row cannot be demoted, not even by a super administrator", async () => {
    const result = await setPortalUserRole(claims("u-staff", "admin"), "u-anna", "viewer");
    expect(result).toEqual({ ok: false, reason: "last_admin" });
    expect((await userRow("u-anna")).role).toBe("admin");
    expect(await auditRows()).toEqual([]);
  });

  it("with two admins, one can demote the other", async () => {
    await seed({ id: "u-carl", email: "carl@ventisol.dk", name: "Carl" }, "admin");
    const result = await setPortalUserRole(claims("u-anna", "admin"), "u-carl", "ledelse");
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await userRow("u-carl")).role).toBe("ledelse");
  });

  it("answers not_found for a user who has never logged in", async () => {
    expect(await setPortalUserRole(claims("u-anna", "admin"), "u-nobody", "planner")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("refuses a role that does not exist", async () => {
    expect(
      await setPortalUserRole(claims("u-anna", "admin"), "u-bente", "boss" as PortalRole)
    ).toEqual({ ok: false, reason: "invalid_role" });
  });
});

describe("audit", () => {
  beforeEach(async () => {
    await ensureInstance();
  });

  it("records the user and role of the surrounding transaction", async () => {
    await withUser(claims("u-bente", "planner"), (db) =>
      audit(db, "normal_time.updated", "3/vindue-1-fag", { seconds: 420 })
    );
    expect(await auditRows()).toEqual([
      {
        opti_user_id: "u-bente",
        role: "planner",
        action: "normal_time.updated",
        subject: "3/vindue-1-fag",
        detail: { seconds: 420 },
      },
    ]);
  });

  it("is rolled back with the write it describes", async () => {
    await expect(
      withUser(claims("u-bente", "planner"), async (db) => {
        await audit(db, "something.changed", "x");
        throw new Error("the write failed");
      })
    ).rejects.toThrow("the write failed");
    expect(await auditRows()).toEqual([]);
  });

  it("cannot be written in someone else's name or role", async () => {
    await expect(
      withUser(claims("u-bente", "planner"), (db) =>
        db.query(
          "insert into app.audit_log (opti_user_id, role, action) values ('u-anna', 'planner', 'forged')"
        )
      )
    ).rejects.toThrow();
    await expect(
      withUser(claims("u-bente", "planner"), (db) =>
        db.query(
          "insert into app.audit_log (opti_user_id, role, action) values ('u-bente', 'admin', 'forged')"
        )
      )
    ).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
  });

  it("only an admin reads the log, newest first", async () => {
    await withUser(claims("u-bente", "planner"), (db) => audit(db, "first", null));
    await withUser(claims("u-anna", "admin"), (db) => audit(db, "second", "s", { a: 1 }));

    const forAdmin = await withUser(claims("u-anna", "admin"), (db) => listAuditLog(db));
    expect(forAdmin.map((e) => e.action)).toEqual(["second", "first"]);
    expect(forAdmin[0]).toMatchObject({ optiUserId: "u-anna", role: "admin", subject: "s", detail: { a: 1 } });
    expect(forAdmin[0].at).toBeInstanceOf(Date);

    const forPlanner = await withUser(claims("u-bente", "planner"), (db) => listAuditLog(db));
    expect(forPlanner).toEqual([]);
  });
});
