import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseNotConfiguredError,
  NestedTransactionError,
  onFixtureDbReady,
  resetDriver,
  setDriver,
  withService,
  withUser,
  type Claims,
} from "@/lib/db";
import { applyMigrations, listMigrations, migrationsDir } from "@/lib/db/migrations";
import { createPglite } from "@/lib/db/pglite";
import { poolConfig, typeParsers } from "@/lib/db/postgres";
import { createTestDb, TEST_ACCOUNT_ID, testClaims, type TestDb } from "@/lib/db/testing";

describe("migrations", () => {
  it("finds supabase/migrations from apps/web and from a folder below it", () => {
    const dir = migrationsDir();
    expect(dir.replaceAll("\\", "/")).toMatch(/\/supabase\/migrations$/);
    expect(migrationsDir(`${process.cwd()}/lib/db`)).toBe(dir);
  });

  it("lists them in name order, foundation first", () => {
    const names = listMigrations().map((m) => m.name);
    expect(names[0]).toBe("20261116100000_foundation.sql");
    expect(names).toEqual([...names].sort());
  });

  it("has no em dash or en dash in any migration", () => {
    // U+2013 and U+2014, written as code points so this file has none either.
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const migration of listMigrations()) {
      expect(migration.sql, migration.name).not.toMatch(dashes);
    }
  });

  it("applies cleanly on an empty PGlite, without the cached template", async () => {
    const db = await createPglite();
    try {
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from config.settings"
      );
      expect(rows[0].n).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it("says which file failed", async () => {
    const exec = async (sql: string) => {
      if (sql.includes("boom")) throw new Error("syntax error");
    };
    await expect(
      applyMigrations(exec, [
        { name: "1_ok.sql", sql: "select 1" },
        { name: "2_bad.sql", sql: "boom" },
      ])
    ).rejects.toThrow("Migration 2_bad.sql failed: syntax error");
  });
});

describe("withUser and withService", () => {
  let db: TestDb;
  const planner = testClaims("planner", "user-7");

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(() => db.reset());
  afterAll(() => db.close());

  const whoAmI = "select current_user::text as who, app.claims() as claims";

  it("withUser runs as authenticated with the claims", async () => {
    const [row] = await withUser(planner, (tx) =>
      tx.query<{ who: string; claims: Record<string, string> }>(whoAmI)
    );
    expect(row.who).toBe("authenticated");
    expect(row.claims).toEqual({
      account_id: TEST_ACCOUNT_ID,
      opti_user_id: "user-7",
      role: "planner",
    });
    const [helpers] = await withUser(planner, (tx) =>
      tx.query(
        "select app.current_role() as role, app.current_user_id() as uid, " +
          "app.current_account_id()::text as account, app.has_role('planner') as yes, " +
          "app.has_role('admin', 'ledelse') as no"
      )
    );
    expect(helpers).toEqual({
      role: "planner",
      uid: "user-7",
      account: TEST_ACCOUNT_ID,
      yes: true,
      no: false,
    });
  });

  it("withService runs as the connection's own role, without claims", async () => {
    const [row] = await withService((tx) =>
      tx.query<{ who: string; claims: unknown }>(whoAmI)
    );
    expect(row.who).not.toBe("authenticated");
    expect(row.claims).toEqual({});
  });

  it("the role and the claims do not leak into the next transaction", async () => {
    await withUser(planner, (tx) => tx.query("select 1"));
    const [row] = await withService((tx) =>
      tx.query<{ who: string; claims: unknown }>(whoAmI)
    );
    expect(row.who).not.toBe("authenticated");
    expect(row.claims).toEqual({});
  });

  it("rolls back and drops the role when the callback throws", async () => {
    await expect(
      withUser(planner, async (tx) => {
        await tx.query(
          "insert into config.settings (key, value) values ('temp', '1'::jsonb)"
        );
        throw new Error("stop");
      })
    ).rejects.toThrow("stop");

    const [row] = await withService((tx) =>
      tx.query<{ who: string; claims: unknown; n: number }>(
        "select current_user::text as who, app.claims() as claims, " +
          "(select count(*)::int from config.settings where key = 'temp') as n"
      )
    );
    expect(row.who).not.toBe("authenticated");
    expect(row.claims).toEqual({});
    expect(row.n).toBe(0);
  });

  it("drops the role after a failed statement too", async () => {
    await expect(
      withUser(planner, (tx) => tx.query("select * from raw.scans"))
    ).rejects.toMatchObject({ code: "42501" });
    const [row] = await withService((tx) => tx.query<{ who: string }>(whoAmI));
    expect(row.who).not.toBe("authenticated");
  });

  it("commits what the callback wrote", async () => {
    await withUser(planner, (tx) =>
      tx.query("insert into config.settings (key, value) values ($1, $2::jsonb)", [
        "kept",
        JSON.stringify({ a: 1 }),
      ])
    );
    const rows = await withService((tx) =>
      tx.query("select value from config.settings where key = 'kept'")
    );
    expect(rows).toEqual([{ value: { a: 1 } }]);
  });

  it("refuses a call nested inside another one", async () => {
    await expect(
      withService(() => withUser(planner, (tx) => tx.query("select 1")))
    ).rejects.toBeInstanceOf(NestedTransactionError);
    // And the outer handle still works afterwards.
    expect(await withService((tx) => tx.query("select 1 as one"))).toEqual([{ one: 1 }]);
  });

  it("returns the same JS types as the node-postgres driver is set up to", async () => {
    const [row] = await withService((tx) =>
      tx.query(
        "select count(*) as big, 1.5::numeric as num, avg(2) as average, " +
          "date '2026-11-01' as day, timestamptz '2026-11-01 12:00:00+00' as at, " +
          "time '06:00' as t, array[1, 2]::bigint[] as bigs, " +
          "array[date '2026-11-01'] as days, '{\"a\": [1]}'::jsonb as doc " +
          "from config.calendar_shifts"
      )
    );
    expect(row).toEqual({
      big: 5,
      num: 1.5,
      average: 2,
      day: "2026-11-01",
      at: new Date("2026-11-01T12:00:00Z"),
      t: "06:00:00",
      bigs: [1, 2],
      days: ["2026-11-01"],
      doc: { a: [1] },
    });
  });

  it("treats parameters the way node-postgres does", async () => {
    // A JS array is a Postgres array: fine for any($1), wrong for jsonb.
    const rows = await withService((tx) =>
      tx.query<{ weekday: number }>(
        "select weekday from config.calendar_shifts where weekday = any($1::int[]) order by 1",
        [[1, 2]]
      )
    );
    expect(rows.map((r) => r.weekday)).toEqual([1, 2]);

    await expect(
      withService((tx) => tx.query("select $1::jsonb as doc", [[1, 2]]))
    ).rejects.toThrow(/json/i);

    const [asJson] = await withService((tx) =>
      tx.query("select $1::jsonb as list, $2::jsonb as obj, $3::timestamptz as at, $4::boolean as flag", [
        JSON.stringify([1, 2]),
        { a: 1 },
        new Date("2026-11-01T12:00:00Z"),
        true,
      ])
    );
    expect(asJson).toEqual({
      list: [1, 2],
      obj: { a: 1 },
      at: new Date("2026-11-01T12:00:00Z"),
      flag: true,
    });
  });
});

describe("createTestDb", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the active driver until it is closed", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("VENTISOL_FIXTURES", "");
    const db = await createTestDb();
    const [row] = await withUser(testClaims("viewer"), (tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from config.settings")
    );
    expect(row.n).toBeGreaterThan(0);
    await db.close();
    await expect(withService((tx) => tx.query("select 1"))).rejects.toBeInstanceOf(
      DatabaseNotConfiguredError
    );
  });

  it("gives every test its own data, and reset() restores the seeded rows", async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    try {
      const countSettings = "select count(*)::int as n from config.settings";
      const [{ n: seeded }] = await first.withService((tx) => tx.query<{ n: number }>(countSettings));

      await first.withService(async (tx) => {
        await tx.query("delete from config.settings");
        await tx.query("insert into raw.scans (scan_id) values ('a')");
        await tx.query(
          "insert into app.audit_log (action) values ('one'), ('two')"
        );
      });
      const [other] = await second.withService((tx) => tx.query<{ n: number }>(countSettings));
      expect(other.n).toBe(seeded);

      await first.reset();
      const [after] = await first.withService((tx) =>
        tx.query(
          "select (select count(*)::int from config.settings) as settings, " +
            "(select count(*)::int from config.calendar_shifts) as shifts, " +
            "(select count(*)::int from raw.scans) as scans, " +
            "(select account_id::text from app.instance) as account"
        )
      );
      expect(after).toEqual({ settings: seeded, shifts: 5, scans: 0, account: TEST_ACCOUNT_ID });

      // Identity counters start again.
      const [log] = await first.withService((tx) =>
        tx.query<{ id: number }>("insert into app.audit_log (action) values ('x') returning id")
      );
      expect(log.id).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("is fast enough to call per test (prints the timings)", async () => {
    const time = async <T,>(fn: () => Promise<T>): Promise<[T, number]> => {
      const start = performance.now();
      const value = await fn();
      return [value, performance.now() - start];
    };
    const [db, createMs] = await time(() => createTestDb());
    const [, resetMs] = await time(() => db.reset());
    const [, closeMs] = await time(() => db.close());
    console.info(
      `[db] createTestDb ${createMs.toFixed(0)} ms, reset ${resetMs.toFixed(0)} ms, close ${closeMs.toFixed(0)} ms`
    );
    expect(createMs).toBeLessThan(5_000);
    expect(resetMs).toBeLessThan(1_000);
  });
});

describe("driver selection", () => {
  beforeEach(() => {
    resetDriver();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("VENTISOL_FIXTURES", "");
  });
  afterEach(() => {
    resetDriver();
    vi.unstubAllEnvs();
  });

  it("throws DatabaseNotConfiguredError without a connection string or fixture mode", async () => {
    await expect(withService((tx) => tx.query("select 1"))).rejects.toBeInstanceOf(
      DatabaseNotConfiguredError
    );
    await expect(
      withUser(testClaims("admin"), (tx) => tx.query("select 1"))
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("never uses fixture mode in production", async () => {
    vi.stubEnv("VENTISOL_FIXTURES", "1");
    vi.stubEnv("NODE_ENV", "production");
    await expect(withService((tx) => tx.query("select 1"))).rejects.toBeInstanceOf(
      DatabaseNotConfiguredError
    );
  });

  it("setDriver wins over the environment", async () => {
    const calls: string[] = [];
    setDriver({
      async transaction(fn) {
        return fn({
          async query(sql: string) {
            calls.push(sql);
            return [];
          },
        });
      },
      async close() {},
    });
    await withUser(testClaims("viewer"), (tx) => tx.query("select 42"));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("request.jwt.claims");
    expect(calls[0]).toContain("'authenticated'");
    expect(calls[1]).toBe("select 42");
  });

  it("fixture mode: one migrated PGlite, seeded once before the first query is answered", async () => {
    vi.stubEnv("VENTISOL_FIXTURES", "1");
    let runs = 0;
    const seed = async () => {
      runs++;
      // A seed uses the module-level functions, like the real sync code will.
      await withService((tx) =>
        tx.query("insert into app.instance (account_id) values ($1)", [TEST_ACCOUNT_ID])
      );
      await withService((tx) =>
        tx.query("insert into raw.scans (scan_id, order_no) values ('seeded', 1)")
      );
    };
    onFixtureDbReady("test-seed", seed);
    onFixtureDbReady("test-seed", seed);

    const count = () =>
      withService((tx) => tx.query<{ n: number }>("select count(*)::int as n from raw.scans"));
    const [a, b] = await Promise.all([count(), count()]);
    expect(a[0].n).toBe(1);
    expect(b[0].n).toBe(1);

    // Registering again later (hot reload) does not seed twice.
    onFixtureDbReady("test-seed", seed);
    expect((await count())[0].n).toBe(1);
    expect(runs).toBe(1);

    const admin: Claims = testClaims("admin");
    const [row] = await withUser(admin, (tx) =>
      tx.query<{ ok: boolean }>("select app.has_role('admin') as ok")
    );
    expect(row.ok).toBe(true);
  });
});

describe("node-postgres settings", () => {
  // TLS settings per host: lib/db/postgres.test.ts.
  it("drops the query string and keeps the pool small", () => {
    const config = poolConfig(
      "postgres://postgres.ref:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x"
    );
    expect(config.connectionString).toBe(
      "postgres://postgres.ref:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"
    );
    expect(config.max).toBeLessThanOrEqual(5);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("parses bigint, numeric and date like the PGlite driver", () => {
    const parse = (oid: number, text: string) => typeParsers.getTypeParser(oid, "text")(text);
    expect(parse(20, "42")).toBe(42);
    expect(parse(20, "9007199254740993")).toBe(BigInt("9007199254740993"));
    expect(parse(1700, "1.50")).toBe(1.5);
    expect(parse(1082, "2026-11-01")).toBe("2026-11-01");
    expect(parse(1114, "2026-11-01 06:00:00")).toBe("2026-11-01 06:00:00");
    expect(parse(1016, "{1,2,NULL}")).toEqual([1, 2, null]);
    expect(parse(1231, "{1.5}")).toEqual([1.5]);
    expect(parse(1182, "{2026-11-01}")).toEqual(["2026-11-01"]);
    // Untouched types keep node-postgres's own parser.
    expect(parse(23, "7")).toBe(7);
    expect(parse(1184, "2026-11-01 12:00:00+00")).toEqual(new Date("2026-11-01T12:00:00Z"));
  });
});
