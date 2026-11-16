// Test harness: a real Postgres (PGlite) with every migration applied, in
// process, no Docker and no network. Not imported by the app.
//
// Fastest pattern, one database per test file and a cheap reset per test:
//
//   let db: TestDb;
//   beforeAll(async () => { db = await createTestDb(); });
//   beforeEach(() => db.reset());
//   afterAll(() => db.close());
//
// A database per test also works (createTestDb in beforeEach, close in
// afterEach); it costs about ten times more per test. See the numbers at
// createTestDb.
//
// createTestDb() also installs itself as the active driver, so code under
// test that imports withUser/withService from "@/lib/db" hits this database.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  handleFor,
  installedDriver,
  resetDriver,
  setDriver,
  type Claims,
  type DbHandle,
  type PortalRole,
} from "./index";
import { listMigrations, type Migration } from "./migrations";
import { BOOTSTRAP_SQL, bootstrapPglite, openPglite, pgliteDriver } from "./pglite";

/** The account id in app.instance of every test database. */
export const TEST_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

/** Claims that pass app.has_role in a test database. */
export function testClaims(role: PortalRole = "admin", optiUserId = `test-${role}`): Claims {
  return { accountId: TEST_ACCOUNT_ID, optiUserId, role };
}

export interface TestDb extends DbHandle {
  /**
   * Back to the state right after the migrations: every table in our schemas
   * emptied, identity counters restarted, the rows the migrations seeded (and
   * app.instance) put back. Much cheaper than a new database.
   */
  reset(): Promise<void>;
  /** Frees the database and, if it is the active driver, uninstalls it. */
  close(): Promise<void>;
}

const OUR_SCHEMAS = ["raw", "core", "doc", "config", "app", "ai", "rpt"];

// Lives only in test databases. snapshot() copies every non-empty table of
// our schemas right after the migrations; reset() truncates everything and
// copies those rows back. Foreign key triggers are off during the copy, so
// the order of the tables does not matter.
const SUPPORT_SQL = `
create schema test_support;

create function test_support.our_tables()
returns table (schema_name name, table_name name)
language sql stable as $fn$
  select n.nspname, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname in (${OUR_SCHEMAS.map((s) => `'${s}'`).join(", ")});
$fn$;

create function test_support.snapshot()
returns void
language plpgsql as $fn$
declare
  t record;
  has_rows boolean;
begin
  for t in select * from test_support.our_tables() loop
    execute format('select exists (select 1 from %I.%I)', t.schema_name, t.table_name)
      into has_rows;
    if has_rows then
      execute format(
        'create table test_support.%I as select * from %I.%I',
        t.schema_name || '.' || t.table_name, t.schema_name, t.table_name
      );
    end if;
  end loop;
end
$fn$;

create function test_support.reset()
returns void
language plpgsql as $fn$
declare
  t record;
  targets text;
  cols text;
begin
  select string_agg(format('%I.%I', schema_name, table_name), ', ')
    into targets
    from test_support.our_tables();
  if targets is not null then
    execute 'truncate ' || targets || ' restart identity cascade';
  end if;

  perform set_config('session_replication_role', 'replica', true);
  for t in
    select c.relname as copy_name,
           split_part(c.relname, '.', 1) as schema_name,
           split_part(c.relname, '.', 2) as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'test_support' and c.relkind = 'r'
  loop
    -- Generated columns cannot be written; they recompute themselves.
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
      into cols
      from pg_attribute a
      where a.attrelid = format('%I.%I', t.schema_name, t.table_name)::regclass
        and a.attnum > 0
        and not a.attisdropped
        and a.attgenerated = '';
    execute format(
      'insert into %I.%I (%s) overriding system value select %s from test_support.%I',
      t.schema_name, t.table_name, cols, cols, t.copy_name
    );
  end loop;
  perform set_config('session_replication_role', 'origin', true);
end
$fn$;
`;

function instanceSql(): string {
  return `insert into app.instance (account_id) values ('${TEST_ACCOUNT_ID}');`;
}

async function buildTemplate(migrations: Migration[]): Promise<Blob> {
  const db = await openPglite();
  try {
    await bootstrapPglite(db, migrations);
    await db.exec(instanceSql());
    await db.exec(SUPPORT_SQL);
    await db.exec("select test_support.snapshot()");
    return await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}

// --- the template on disk ---------------------------------------------------
// Building the template runs initdb and every migration: about 1.5 s.
// Restoring it takes about 0.3 s. Vitest runs each test file in its own
// worker, so without a file on disk every test file would pay the 1.5 s.
// The file is keyed by a hash of everything that goes into it, so a changed
// migration simply builds a new one. Set VENTISOL_TEST_DB_CACHE=0 to turn the
// disk cache off.

function nearestNodeModules(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function pgliteVersion(nodeModules: string | undefined): string {
  if (!nodeModules) return "unknown";
  try {
    const file = join(nodeModules, "@electric-sql", "pglite", "package.json");
    return String(JSON.parse(readFileSync(file, "utf8")).version);
  } catch {
    return "unknown";
  }
}

function cacheEnabled(): boolean {
  return process.env.VENTISOL_TEST_DB_CACHE !== "0";
}

async function loadOrBuildTemplate(): Promise<Blob> {
  const migrations = listMigrations();
  if (!cacheEnabled()) return buildTemplate(migrations);

  const nodeModules = nearestNodeModules(process.cwd());
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        pgliteVersion(nodeModules),
        BOOTSTRAP_SQL,
        SUPPORT_SQL,
        instanceSql(),
        migrations.map((m) => [m.name, m.sql]),
      ])
    )
    .digest("hex")
    .slice(0, 24);
  const dir = nodeModules
    ? join(nodeModules, ".cache", "ventisol-test-db")
    : join(tmpdir(), "ventisol-test-db");
  const file = join(dir, `${hash}.tar`);

  try {
    return new Blob([readFileSync(file)]);
  } catch {
    // Not built yet (or unreadable): build it below.
  }

  const template = await buildTemplate(migrations);
  try {
    mkdirSync(dir, { recursive: true });
    // Write beside it and rename, so a parallel worker never reads half a file.
    const partial = join(dir, `${hash}.${process.pid}.partial`);
    writeFileSync(partial, Buffer.from(await template.arrayBuffer()));
    renameSync(partial, file);
    // Templates of older migrations are dead weight (about 40 MB each).
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".tar") && name !== `${hash}.tar`) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // The cache is only a shortcut: a failed write must not fail the test.
  }
  return template;
}

let template: Promise<Blob> | undefined;

function getTemplate(): Promise<Blob> {
  template ??= loadOrBuildTemplate().catch((error) => {
    template = undefined;
    throw error;
  });
  return template;
}

/**
 * A fresh database with the Supabase roles, every migration in
 * supabase/migrations, and app.instance set to TEST_ACCOUNT_ID. Installs
 * itself as the active driver of "@/lib/db".
 *
 * Measured on the development PC (see testing.test.ts, which prints them):
 * the first call in a test file about 0.3 to 0.5 s (1.5 to 2 s when the
 * template file has to be built, once per migration change), every further
 * call about 0.2 to 0.3 s, reset() about 0.03 s.
 */
export async function createTestDb(): Promise<TestDb> {
  const db = await openPglite({ loadDataDir: await getTemplate() });
  const driver = pgliteDriver(db);
  const handle = handleFor(driver);
  setDriver(driver);

  return {
    withUser: handle.withUser,
    withService: handle.withService,
    async reset() {
      await driver.transaction((tx) => tx.query("select test_support.reset()"));
    },
    async close() {
      if (installedDriver() === driver) resetDriver();
      await driver.close();
    },
  };
}
