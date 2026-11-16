// Row level security, tested against the real policies on PGlite.
//
// The first block is a meta test over the catalog: it covers every table in
// our schemas, also those added by later migrations. A new table must have
// RLS on and at least one policy, or be listed in SERVICE_ONLY below.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Claims, PortalRole } from "@/lib/db";
import { createTestDb, TEST_ACCOUNT_ID, testClaims, type TestDb } from "@/lib/db/testing";

const SCHEMAS = ["raw", "core", "doc", "config", "app", "ai", "rpt"];

/** Tables with RLS on, no policy and no grant: only service code touches them. */
const SERVICE_ONLY = new Set([
  "app.instance",
  "app.rate_limits",
  "raw.scans",
  "raw.order_documents",
]);

const ROLES: PortalRole[] = ["admin", "ledelse", "planner", "viewer"];
const OTHER_ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";

let db: TestDb;

const admin = testClaims("admin", "u-admin");
const ledelse = testClaims("ledelse", "u-ledelse");
const planner = testClaims("planner", "u-planner");
const viewer = testClaims("viewer", "u-viewer");
const otherViewer = testClaims("viewer", "u-other");

type Outcome = { rows: Record<string, unknown>[] } | { denied: string };

/** Runs one statement as a user. A Postgres error comes back as its SQLSTATE. */
async function run(claims: Claims, sql: string, params?: unknown[]): Promise<Outcome> {
  try {
    return { rows: await db.withUser(claims, (tx) => tx.query(sql, params)) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!code) throw error;
    return { denied: code };
  }
}

/** Rows a user can read from a table: 0 when RLS hides them or the grant is missing. */
async function visible(claims: Claims, table: string): Promise<number> {
  const outcome = await run(claims, `select count(*)::int as n from ${table}`);
  if ("denied" in outcome) {
    expect(outcome.denied, table).toBe("42501");
    return 0;
  }
  return outcome.rows[0].n as number;
}

const blocked = (result: number | "denied") => result === "denied" || result === 0;

async function allTables(): Promise<string[]> {
  const rows = await db.withService((tx) =>
    tx.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
       order by 1`,
      [SCHEMAS]
    )
  );
  return rows.map((r) => r.name);
}

beforeAll(async () => {
  db = await createTestDb();
  // One row at least in every table of the foundation, written as service.
  await db.withService(async (tx) => {
    await tx.query(
      `insert into app.portal_users (opti_user_id, email, name, role) values
         ('u-admin', 'a@x.dk', 'Admin', 'admin'),
         ('u-ledelse', 'l@x.dk', 'Ledelse', 'ledelse'),
         ('u-planner', 'p@x.dk', 'Planner', 'planner'),
         ('u-viewer', 'v@x.dk', 'Viewer', 'viewer'),
         ('u-other', 'o@x.dk', 'Other', 'viewer')`
    );
    await tx.query(
      "insert into app.audit_log (opti_user_id, role, action) values ('u-admin', 'admin', 'seed')"
    );
    await tx.query(
      "insert into app.rate_limits (key, window_start, count) values ('k', now(), 1)"
    );
    await tx.query("insert into app.sync_state (name, watermark) values ('scans', 'w1')");
    await tx.query(
      `insert into raw.scans (scan_id, barcode, order_no, position, sub_position, piece,
         station, station_no, station_kind, machine_id, direction, scan_time, device)
       values ('s1', '058556050103', 58556, 5, 1, 3, 'Station 10', 1, 'Assembly', '', 'In',
         '2026-10-21T08:00:00Z', 'PC')`
    );
    await tx.query(
      `insert into raw.order_documents (file_name, order_no, prefix, print_date)
       values ('58721_20261022.pdf', 58721, '', '2026-10-22')`
    );
    await tx.query(
      `insert into doc.document_chunks (file_name, order_no, position, chunk_index, content)
       values ('58721_20261022.pdf', 58721, 1, 0, 'Vindue 1 fag med glas')`
    );
    await tx.query(
      "insert into config.stations (station_no, name, kind) values (1, 'Station 10', 'assembly')"
    );
    await tx.query(
      "insert into config.element_types (id, name) values ('vindue_1_fag', 'Vindue 1 fag')"
    );
    await tx.query(
      "insert into config.normal_times (station_no, element_type_id, seconds) values (1, 'vindue_1_fag', 600)"
    );
    await tx.query(
      "insert into config.calculated_times (station_no, element_type_id, seconds) values (1, 'vindue_1_fag', 540)"
    );
    await tx.query(
      "insert into config.calendar_closed_days (day, name) values ('2026-12-24', 'Juleaften')"
    );
    await tx.query(
      `insert into ai.conversations (id, opti_user_id, title) values
         ('11111111-1111-4111-8111-111111111111', 'u-viewer', 'Mine'),
         ('22222222-2222-4222-8222-222222222222', 'u-other', 'Theirs')`
    );
    await tx.query(
      `insert into ai.messages (id, conversation_id, role) values
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'user'),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'user')`
    );
    await tx.query(
      `insert into ai.tool_calls (message_id, conversation_id, name) values
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'orders'),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'orders')`
    );
    await tx.query(
      `insert into ai.usage_events (conversation_id, message_id, opti_user_id, model, cost_usd) values
         ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'u-viewer', 'm', 0.01),
         ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'u-other', 'm', 0.02)`
    );
    await tx.query(
      `insert into ai.feedback (message_id, opti_user_id, rating) values
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'u-viewer', 1),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'u-other', -1)`
    );
    await tx.query(
      "insert into rpt.snapshots (month, numbers) values ('2026-10-01', '{}'::jsonb)"
    );
    await tx.query("insert into rpt.management_notes (month) values ('2026-10-01')");
  });
});

afterAll(() => db.close());

describe("catalog rules, for every table in our schemas", () => {
  it("has RLS enabled, and policies unless it is on the service-only list", async () => {
    const rows = await db.withService((tx) =>
      tx.query<{ name: string; rls: boolean; policies: number }>(
        `select n.nspname || '.' || c.relname as name,
                c.relrowsecurity as rls,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
         order by 1`,
        [SCHEMAS]
      )
    );
    expect(rows.length).toBeGreaterThan(20);

    const rlsOff = rows.filter((r) => !r.rls).map((r) => r.name);
    expect(rlsOff, "tables with row level security disabled").toEqual([]);

    const noPolicy = rows
      .filter((r) => r.policies === 0 && !SERVICE_ONLY.has(r.name))
      .map((r) => r.name);
    expect(noPolicy, "tables with RLS on but no policy and not service-only").toEqual([]);

    const names = new Set(rows.map((r) => r.name));
    const stale = [...SERVICE_ONLY].filter((name) => !names.has(name));
    expect(stale, "service-only entries that are not tables any more").toEqual([]);

    const serviceOnlyWithPolicy = rows
      .filter((r) => SERVICE_ONLY.has(r.name) && r.policies > 0)
      .map((r) => r.name);
    expect(serviceOnlyWithPolicy, "service-only tables must have no policy").toEqual([]);
  });

  it("grants authenticated nothing on service-only tables", async () => {
    const rows = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p')
           and n.nspname || '.' || c.relname = any($1::text[])
           and (has_table_privilege('authenticated', c.oid, 'select, insert, update, delete, truncate')
                or has_any_column_privilege('authenticated', c.oid, 'select, insert, update'))`,
        [[...SERVICE_ONLY]]
      )
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("grants anon (and so PUBLIC) nothing: no schema, no table, no column", async () => {
    const schemas = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select nspname::text as name from pg_namespace
         where nspname = any($1::text[]) and has_schema_privilege('anon', oid, 'usage, create')`,
        [SCHEMAS]
      )
    );
    expect(schemas.map((r) => r.name)).toEqual([]);

    const tables = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname = any($1::text[])
           and (has_table_privilege('anon', c.oid, 'select')
                or (c.relkind <> 'S' and (
                  has_table_privilege('anon', c.oid, 'insert, update, delete, truncate')
                  or has_any_column_privilege('anon', c.oid, 'select, insert, update'))))`,
        [SCHEMAS]
      )
    );
    expect(tables.map((r) => r.name)).toEqual([]);
  });

  it("writes every policy for the role authenticated only", async () => {
    const rows = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select n.nspname || '.' || c.relname || ': ' || p.polname as name
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1::text[])
           and p.polroles <> array[(select oid from pg_roles where rolname = 'authenticated')]`,
        [SCHEMAS]
      )
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("has no view that bypasses RLS (views must be security_invoker)", async () => {
    const rows = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'v' and n.nspname = any($1::text[])
           and not coalesce(c.reloptions @> array['security_invoker=true']
                            or c.reloptions @> array['security_invoker=on'], false)`,
        [SCHEMAS]
      )
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("pins search_path on every security definer function", async () => {
    const rows = await db.withService((tx) =>
      tx.query<{ name: string }>(
        `select n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1::text[]) and p.prosecdef
           and not exists (
             select 1 from unnest(coalesce(p.proconfig, '{}')) as c where c like 'search_path=%'
           )`,
        [SCHEMAS]
      )
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });
});

describe("claims that must see nothing, on every table", () => {
  const cases: [string, Claims][] = [
    ["no claims at all", {} as Claims],
    ["an unknown role", { ...admin, role: "superuser" as PortalRole }],
    ["an empty role", { ...admin, role: "" as PortalRole }],
    ["a role in the wrong case", { ...admin, role: "Admin" as PortalRole }],
    ["no account id", { ...admin, accountId: undefined as unknown as string }],
    ["an account id that is not a uuid", { ...admin, accountId: "ventisol" }],
    ...ROLES.map(
      (role): [string, Claims] => [
        `${role} of another account`,
        { accountId: OTHER_ACCOUNT_ID, optiUserId: `u-${role}`, role },
      ]
    ),
  ];

  it.each(cases)("%s", async (_name, claims) => {
    for (const table of await allTables()) {
      expect(await visible(claims, table), table).toBe(0);
    }
  });

  it("nobody sees anything while app.instance is empty", async () => {
    await db.withService((tx) => tx.query("delete from app.instance"));
    try {
      const [row] = await db.withUser(admin, (tx) =>
        tx.query<{ ok: boolean }>("select app.has_role('admin') as ok")
      );
      expect(row.ok).toBe(false);
      for (const table of await allTables()) {
        expect(await visible(admin, table), table).toBe(0);
      }
    } finally {
      await db.withService((tx) =>
        tx.query("insert into app.instance (account_id) values ($1)", [TEST_ACCOUNT_ID])
      );
    }
  });

  it("has_role is false, never null, for claims it cannot read", async () => {
    const [row] = await db.withUser({} as Claims, (tx) =>
      tx.query("select app.has_role('admin') as a, app.current_role() as r")
    );
    expect(row).toEqual({ a: false, r: null });
  });
});

describe("what each role reads", () => {
  // Expected visible row counts in the seeded database. "all" = every row.
  const settingsCount = () => visible(admin, "config.settings");

  it("everyone with a role reads the shared config, core and doc tables", async () => {
    for (const claims of [admin, ledelse, planner, viewer]) {
      expect(await visible(claims, "config.stations"), claims.role).toBe(1);
      expect(await visible(claims, "config.element_types"), claims.role).toBe(1);
      expect(await visible(claims, "config.normal_times"), claims.role).toBe(1);
      expect(await visible(claims, "config.calendar_shifts"), claims.role).toBe(5);
      expect(await visible(claims, "config.calendar_closed_days"), claims.role).toBe(1);
      expect(await visible(claims, "config.settings"), claims.role).toBe(await settingsCount());
      expect(await visible(claims, "doc.document_chunks"), claims.role).toBe(1);
    }
  });

  it("calculated times are hidden from viewer only", async () => {
    expect(await visible(admin, "config.calculated_times")).toBe(1);
    expect(await visible(ledelse, "config.calculated_times")).toBe(1);
    expect(await visible(planner, "config.calculated_times")).toBe(1);
    expect(await visible(viewer, "config.calculated_times")).toBe(0);
  });

  it("snapshots and management notes are for admin and ledelse", async () => {
    for (const table of ["rpt.snapshots", "rpt.management_notes"]) {
      expect(await visible(admin, table), table).toBe(1);
      expect(await visible(ledelse, table), table).toBe(1);
      expect(await visible(planner, table), table).toBe(0);
      expect(await visible(viewer, table), table).toBe(0);
    }
  });

  it("nobody reads raw.*, app.rate_limits or app.instance as a user", async () => {
    for (const claims of [admin, ledelse, planner, viewer]) {
      for (const table of SERVICE_ONLY) {
        const outcome = await run(claims, `select * from ${table}`);
        expect(outcome, `${claims.role} ${table}`).toEqual({ denied: "42501" });
      }
    }
  });

  it("sync state and the audit log are for admin", async () => {
    for (const table of ["app.sync_state", "app.audit_log"]) {
      expect(await visible(admin, table), table).toBe(1);
      for (const claims of [ledelse, planner, viewer]) {
        expect(await visible(claims, table), `${claims.role} ${table}`).toBe(0);
      }
    }
  });

  it("a user reads its own portal_users row, admin reads all", async () => {
    expect(await visible(admin, "app.portal_users")).toBe(5);
    for (const claims of [ledelse, planner, viewer]) {
      const outcome = await run(claims, "select opti_user_id from app.portal_users");
      expect(outcome).toEqual({ rows: [{ opti_user_id: claims.optiUserId }] });
    }
  });

  it("a user reads only its own conversations and what hangs on them", async () => {
    for (const table of ["ai.conversations", "ai.messages", "ai.tool_calls", "ai.feedback", "ai.usage_events"]) {
      expect(await visible(viewer, table), table).toBe(1);
      expect(await visible(otherViewer, table), table).toBe(1);
      expect(await visible(planner, table), table).toBe(0);
    }
    const mine = await run(viewer, "select title from ai.conversations");
    expect(mine).toEqual({ rows: [{ title: "Mine" }] });
  });

  it("admin reads all usage events but not other people's conversations", async () => {
    expect(await visible(admin, "ai.usage_events")).toBe(2);
    for (const table of ["ai.conversations", "ai.messages", "ai.tool_calls", "ai.feedback"]) {
      expect(await visible(admin, table), table).toBe(0);
    }
  });
});

describe("what each role writes", () => {
  // Every statement here either fails or is rolled back by a thrown marker,
  // so the seeded data stays as it is for the other tests.
  const ROLLBACK = "rollback-marker";
  async function tryWrite(claims: Claims, sql: string, params?: unknown[]) {
    try {
      await db.withUser(claims, async (tx) => {
        await tx.query(sql, params);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if ((error as Error).message === ROLLBACK) return "written" as const;
      const code = (error as { code?: string }).code;
      if (code === "42501") return "denied" as const;
      throw error;
    }
    throw new Error("unreachable");
  }
  /** Rows an update or delete touches, then rolled back. */
  async function touched(claims: Claims, sql: string, params?: unknown[]): Promise<number | "denied"> {
    let n = 0;
    try {
      await db.withUser(claims, async (tx) => {
        n = (await tx.query(`${sql} returning 1`, params)).length;
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if ((error as Error).message === ROLLBACK) return n;
      if ((error as { code?: string }).code === "42501") return "denied";
      throw error;
    }
    return n;
  }

  const configWrites: Record<string, { insert: string; update: string; remove: string }> = {
    "config.stations": {
      insert: "insert into config.stations (station_no, name, kind) values (2, 'Pakning', 'packing')",
      update: "update config.stations set name = 'X'",
      remove: "delete from config.stations",
    },
    "config.element_types": {
      insert: "insert into config.element_types (id, name) values ('door', 'Dør')",
      update: "update config.element_types set name = 'X'",
      remove: "delete from config.element_types",
    },
    "config.normal_times": {
      insert: "insert into config.normal_times (station_no, element_type_id, seconds) values (2, 'vindue_1_fag', 1)",
      update: "update config.normal_times set seconds = 1",
      remove: "delete from config.normal_times",
    },
    "config.calculated_times": {
      insert: "insert into config.calculated_times (station_no, element_type_id, seconds) values (2, 'vindue_1_fag', 1)",
      update: "update config.calculated_times set seconds = 1",
      remove: "delete from config.calculated_times",
    },
    "config.calendar_shifts": {
      insert: "insert into config.calendar_shifts (weekday, start_time, end_time) values (6, '06:00', '12:00')",
      update: "update config.calendar_shifts set end_time = '15:00'",
      remove: "delete from config.calendar_shifts",
    },
    "config.calendar_closed_days": {
      insert: "insert into config.calendar_closed_days (day, name) values ('2026-12-31', 'Nytår')",
      update: "update config.calendar_closed_days set name = 'X'",
      remove: "delete from config.calendar_closed_days",
    },
    "config.settings": {
      insert: "insert into config.settings (key, value) values ('new', '1'::jsonb)",
      update: "update config.settings set value = '1'::jsonb",
      remove: "delete from config.settings",
    },
  };

  const writers: Record<string, PortalRole[]> = {
    "config.stations": ["admin"],
    "config.element_types": ["admin"],
    "config.normal_times": ["admin", "planner"],
    "config.calculated_times": ["admin", "planner"],
    "config.calendar_shifts": ["admin", "planner"],
    "config.calendar_closed_days": ["admin", "planner"],
    "config.settings": ["admin", "planner"],
  };

  const users: Record<PortalRole, Claims> = { admin, ledelse, planner, viewer };

  it.each(Object.keys(configWrites))("%s: only its writers can insert, update or delete", async (table) => {
    const sql = configWrites[table];
    for (const role of ROLES) {
      const claims = users[role];
      const may = writers[table].includes(role);
      const label = `${role} on ${table}`;
      expect(await tryWrite(claims, sql.insert), `${label} insert`).toBe(may ? "written" : "denied");
      const updated = await touched(claims, sql.update);
      const removed = await touched(claims, sql.remove);
      if (may) {
        expect(updated, `${label} update`).toBeGreaterThan(0);
        expect(removed, `${label} delete`).toBeGreaterThan(0);
      } else {
        expect(blocked(updated), `${label} update`).toBe(true);
        expect(blocked(removed), `${label} delete`).toBe(true);
      }
    }
  });

  it("viewer cannot write any config table (spelled out)", async () => {
    for (const [table, sql] of Object.entries(configWrites)) {
      expect(await tryWrite(viewer, sql.insert), table).toBe("denied");
      expect(blocked(await touched(viewer, sql.update)), table).toBe(true);
      expect(blocked(await touched(viewer, sql.remove)), table).toBe(true);
    }
  });

  it("only admin writes portal_users", async () => {
    const insert = "insert into app.portal_users (opti_user_id, role) values ('u-new', 'viewer')";
    const promote = "update app.portal_users set role = 'admin' where opti_user_id = $1";
    const remove = "delete from app.portal_users where opti_user_id = 'u-other'";
    for (const claims of [ledelse, planner, viewer]) {
      expect(await tryWrite(claims, insert), claims.role).toBe("denied");
      // Not even its own row: nobody promotes itself.
      expect(blocked(await touched(claims, promote, [claims.optiUserId])), claims.role).toBe(true);
      expect(blocked(await touched(claims, remove)), claims.role).toBe(true);
    }
    expect(await tryWrite(admin, insert)).toBe("written");
    expect(await touched(admin, promote, ["u-viewer"])).toBe(1);
    expect(await touched(admin, remove)).toBe(1);
  });

  it("any role adds to the audit log as itself, and only as itself", async () => {
    const insert =
      "insert into app.audit_log (opti_user_id, role, action, subject, detail) values ($1, $2, 'test', 's', $3::jsonb)";
    for (const claims of [admin, ledelse, planner, viewer]) {
      expect(
        await tryWrite(claims, insert, [claims.optiUserId, claims.role, JSON.stringify({ a: 1 })]),
        claims.role
      ).toBe("written");
    }
    // Someone else's user id, or a role it does not hold.
    expect(await tryWrite(viewer, insert, ["u-admin", "viewer", "{}"])).toBe("denied");
    expect(await tryWrite(viewer, insert, ["u-viewer", "admin", "{}"])).toBe("denied");
    // The time and the id are not the writer's to choose.
    expect(
      await tryWrite(
        admin,
        "insert into app.audit_log (at, opti_user_id, role, action) values ('2000-01-01', 'u-admin', 'admin', 'old')"
      )
    ).toBe("denied");
  });

  it("nobody updates or deletes the audit log as a user", async () => {
    for (const claims of [admin, ledelse, planner, viewer]) {
      expect(await touched(claims, "update app.audit_log set action = 'x'"), claims.role).toBe("denied");
      expect(await touched(claims, "delete from app.audit_log"), claims.role).toBe("denied");
    }
  });

  it("nobody writes raw.*, sync state, rate limits, doc or snapshots as a user", async () => {
    const statements = [
      "insert into raw.scans (scan_id) values ('x')",
      "update raw.scans set barcode = 'x'",
      "delete from raw.scans",
      "insert into raw.order_documents (file_name) values ('x.pdf')",
      "update raw.order_documents set prefix = 'x'",
      "delete from raw.order_documents",
      "insert into app.sync_state (name) values ('x')",
      "update app.sync_state set watermark = 'x'",
      "delete from app.sync_state",
      "insert into app.rate_limits (key, window_start, count) values ('x', now(), 1)",
      "delete from app.rate_limits",
      "update app.instance set account_id = gen_random_uuid()",
      "insert into doc.document_chunks (file_name, chunk_index, content) values ('58721_20261022.pdf', 1, 'x')",
      "delete from doc.document_chunks",
      "insert into rpt.snapshots (month, numbers) values ('2026-09-01', '{}'::jsonb)",
      "update rpt.snapshots set pdf_path = 'x'",
      "delete from rpt.snapshots",
    ];
    for (const claims of [admin, ledelse, planner, viewer]) {
      for (const sql of statements) {
        expect(await tryWrite(claims, sql), `${claims.role}: ${sql}`).toBe("denied");
      }
    }
  });

  it("management notes are written by admin and ledelse only", async () => {
    const insert = "insert into rpt.management_notes (month) values ('2026-11-01')";
    const update = "update rpt.management_notes set highlights = '[\"x\"]'::jsonb";
    for (const claims of [admin, ledelse]) {
      expect(await tryWrite(claims, insert), claims.role).toBe("written");
      expect(await touched(claims, update), claims.role).toBe(1);
    }
    for (const claims of [planner, viewer]) {
      expect(await tryWrite(claims, insert), claims.role).toBe("denied");
      expect(blocked(await touched(claims, update)), claims.role).toBe(true);
    }
  });

  it("a user writes its own conversations and nothing in anyone else's", async () => {
    const mine = "11111111-1111-4111-8111-111111111111";
    const theirs = "22222222-2222-4222-8222-222222222222";
    const myMessage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const theirMessage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // Own.
    expect(
      await tryWrite(viewer, "insert into ai.conversations (opti_user_id, title) values ('u-viewer', 'New')")
    ).toBe("written");
    expect(
      await tryWrite(viewer, "insert into ai.messages (conversation_id, role, parts) values ($1, 'user', $2::jsonb)", [
        mine,
        JSON.stringify([{ type: "text", text: "Hej" }]),
      ])
    ).toBe("written");
    expect(
      await tryWrite(viewer, "insert into ai.tool_calls (conversation_id, message_id, name) values ($1, $2, 't')", [
        mine,
        myMessage,
      ])
    ).toBe("written");
    expect(
      await tryWrite(
        viewer,
        "insert into ai.usage_events (conversation_id, opti_user_id, model) values ($1, 'u-viewer', 'm')",
        [mine]
      )
    ).toBe("written");
    expect(
      await tryWrite(
        viewer,
        "insert into ai.feedback (message_id, opti_user_id, rating) values ($1, 'u-viewer', -1) " +
          "on conflict (message_id, opti_user_id) do update set rating = excluded.rating",
        [myMessage]
      )
    ).toBe("written");
    expect(await touched(viewer, "update ai.conversations set title = 'Renamed' where id = $1", [mine])).toBe(1);
    expect(await touched(viewer, "delete from ai.conversations where id = $1", [mine])).toBe(1);

    // Someone else's, also for admin.
    for (const claims of [viewer, admin]) {
      const who = claims.role;
      expect(
        await tryWrite(claims, "insert into ai.conversations (opti_user_id) values ('u-other')"),
        who
      ).toBe("denied");
      expect(
        await tryWrite(claims, "insert into ai.messages (conversation_id, role) values ($1, 'user')", [theirs]),
        who
      ).toBe("denied");
      expect(
        await tryWrite(claims, "insert into ai.tool_calls (conversation_id, name) values ($1, 't')", [theirs]),
        who
      ).toBe("denied");
      expect(
        await tryWrite(
          claims,
          "insert into ai.usage_events (conversation_id, opti_user_id, model) values ($1, $2, 'm')",
          [theirs, claims.optiUserId]
        ),
        who
      ).toBe("denied");
      expect(
        await tryWrite(claims, "insert into ai.usage_events (opti_user_id, model) values ('u-other', 'm')"),
        who
      ).toBe("denied");
      expect(
        await tryWrite(claims, "insert into ai.feedback (message_id, opti_user_id, rating) values ($1, $2, 1)", [
          theirMessage,
          claims.optiUserId,
        ]),
        who
      ).toBe("denied");
      expect(await touched(claims, "update ai.conversations set title = 'x' where id = $1", [theirs]), who).toBe(0);
      expect(await touched(claims, "delete from ai.conversations where id = $1", [theirs]), who).toBe(0);
      expect(await touched(claims, "delete from ai.messages where id = $1", [theirMessage]), who).toBe(0);
      expect(await touched(claims, "update ai.tool_calls set name = 'x' where conversation_id = $1", [theirs]), who).toBe(0);
      expect(await touched(claims, "delete from ai.feedback where message_id = $1", [theirMessage]), who).toBe(0);
    }

    // A user cannot hand its conversation to someone else, or rewrite costs.
    expect(
      await touched(viewer, "update ai.conversations set opti_user_id = 'u-other' where id = $1", [mine])
    ).toBe("denied");
    expect(await touched(viewer, "update ai.usage_events set cost_usd = 0")).toBe("denied");
    expect(await touched(admin, "delete from ai.usage_events")).toBe("denied");
  });

  it("deleting a conversation keeps its usage events", async () => {
    let kept = -1;
    try {
      await db.withService(async (tx) => {
        await tx.query("delete from ai.conversations");
        const [row] = await tx.query<{ n: number; linked: number }>(
          "select count(*)::int as n, count(conversation_id)::int as linked from ai.usage_events"
        );
        kept = row.n;
        expect(row.linked).toBe(0);
        const [gone] = await tx.query<{ n: number }>("select count(*)::int as n from ai.messages");
        expect(gone.n).toBe(0);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error;
    }
    expect(kept).toBe(2);
  });
});
