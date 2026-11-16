// The only module that opens database connections (docs/portal-architecture.md §2).
//
//   withUser(claims, fn)   one transaction as `authenticated` with the user's
//                          claims. Row level security applies.
//   withService(fn)        one transaction as the connection's own role. Row
//                          level security does not apply. Sync, cron, the
//                          first-login row.
//
// Behind it one of three drivers:
//   1. a driver installed with setDriver() (tests, see testing.ts)
//   2. node-postgres, when DATABASE_URL or POSTGRES_URL is set
//   3. an in-process PGlite with all migrations, when fixture mode is on
// Otherwise DatabaseNotConfiguredError.

import { AsyncLocalStorage } from "node:async_hooks";
import { fixturesEnabled } from "@/lib/fixtures-flag";
import type { Db, Driver } from "./driver";
import { createPostgresDriver } from "./postgres";

export type { Db, Driver } from "./driver";

export type PortalRole = "admin" | "ledelse" | "planner" | "viewer";

export interface Claims {
  accountId: string;
  optiUserId: string;
  role: PortalRole;
}

/** What a fixture seed gets: the same two functions, bound to the fixture database. */
export interface DbHandle {
  withUser<T>(claims: Claims, fn: (db: Db) => Promise<T>): Promise<T>;
  withService<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export type FixtureSeed = (db: DbHandle) => Promise<void>;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "No database is configured: set DATABASE_URL (or POSTGRES_URL) to the pooled " +
        "Postgres connection string, or run `next dev` with VENTISOL_FIXTURES=1 to " +
        "use the in-process fixture database."
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

/**
 * Thrown when withUser or withService is called inside the callback of
 * another one. On Postgres that would take a second connection while holding
 * the first (a deadlock once the small pool is full) and the two transactions
 * would not see each other's writes; on PGlite, which has one connection, it
 * would hang. Use the `db` you were given, or finish the first call first.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "withUser/withService was called inside another withUser/withService callback. " +
        "Use the db handle you already have, or run the calls one after the other."
    );
    this.name = "NestedTransactionError";
  }
}

// Statement timeouts, in milliseconds. A page query that runs longer than the
// first is a bug; sync and reconcile jobs get more room.
const USER_STATEMENT_TIMEOUT_MS = 15_000;
const SERVICE_STATEMENT_TIMEOUT_MS = 120_000;

// One round trip. Everything is transaction local (third argument true), so
// nothing survives on a pooled connection. set_config('role', ..., true) is
// `set local role`; it comes last, so the settings before it are made as the
// connection's own role.
const USER_SETUP_SQL =
  "select set_config('request.jwt.claims', $1, true), " +
  "set_config('statement_timeout', $2, true), " +
  "set_config('role', 'authenticated', true)";

const SERVICE_SETUP_SQL =
  "select set_config('request.jwt.claims', '', true), " +
  "set_config('statement_timeout', $1, true)";

interface FixtureState {
  driver?: Promise<Driver>;
  seeds: Map<string, FixtureSeed>;
  done: Set<string>;
  seeding: Promise<void>;
}

interface State {
  override?: Driver;
  postgres?: { connectionString: string; driver: Driver };
  fixture: FixtureState;
  /** True inside a withUser/withService callback. */
  inTransaction: AsyncLocalStorage<true>;
  /** True inside a fixture seed. */
  inSeed: AsyncLocalStorage<true>;
}

// Kept on globalThis: `next dev` re-evaluates this module on hot reload, and
// a module-level pool or PGlite would leak one per reload.
const globalKey = Symbol.for("ventisol.db.state");
const globalStore = globalThis as unknown as { [globalKey]?: State };

function state(): State {
  return (globalStore[globalKey] ??= {
    fixture: { seeds: new Map(), done: new Set(), seeding: Promise.resolve() },
    inTransaction: new AsyncLocalStorage<true>(),
    inSeed: new AsyncLocalStorage<true>(),
  });
}

function connectionString(): string | undefined {
  const value = (process.env.DATABASE_URL ?? "").trim() || (process.env.POSTGRES_URL ?? "").trim();
  return value || undefined;
}

async function fixtureDriver(s: State): Promise<Driver> {
  const fixture = s.fixture;
  fixture.driver ??= (async () => {
    // Dynamic, so a production bundle never loads PGlite.
    const { createPglite, pgliteDriver } = await import("./pglite");
    return pgliteDriver(await createPglite());
  })();
  const driver = await fixture.driver;
  // Code running inside a seed must get through; everyone else waits until
  // every registered seed has run.
  if (!s.inSeed.getStore()) await runPendingSeeds(s);
  return driver;
}

function runPendingSeeds(s: State): Promise<void> {
  const fixture = s.fixture;
  fixture.seeding = fixture.seeding.then(async () => {
    for (const [key, seed] of fixture.seeds) {
      if (fixture.done.has(key)) continue;
      fixture.done.add(key);
      try {
        await s.inSeed.run(true, () => seed({ withUser, withService }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Fixture seed "${key}" failed: ${reason}`, { cause: error });
      }
    }
  });
  return fixture.seeding;
}

async function activeDriver(): Promise<Driver> {
  const s = state();
  if (s.override) return s.override;

  const url = connectionString();
  if (url) {
    if (s.postgres?.connectionString !== url) {
      void s.postgres?.driver.close().catch(() => {});
      s.postgres = { connectionString: url, driver: createPostgresDriver(url) };
    }
    return s.postgres.driver;
  }

  if (fixturesEnabled()) return fixtureDriver(s);
  throw new DatabaseNotConfiguredError();
}

async function transaction<T>(
  source: () => Promise<Driver>,
  setupSql: string,
  setupParams: unknown[],
  fn: (db: Db) => Promise<T>
): Promise<T> {
  const s = state();
  if (s.inTransaction.getStore()) throw new NestedTransactionError();
  const driver = await source();
  return driver.transaction((db) =>
    s.inTransaction.run(true, async () => {
      await db.query(setupSql, setupParams);
      return fn(db);
    })
  );
}

function userTransaction<T>(
  source: () => Promise<Driver>,
  claims: Claims,
  fn: (db: Db) => Promise<T>
): Promise<T> {
  const jwtClaims = JSON.stringify({
    account_id: claims.accountId,
    opti_user_id: claims.optiUserId,
    role: claims.role,
  });
  return transaction(source, USER_SETUP_SQL, [jwtClaims, String(USER_STATEMENT_TIMEOUT_MS)], fn);
}

function serviceTransaction<T>(
  source: () => Promise<Driver>,
  fn: (db: Db) => Promise<T>
): Promise<T> {
  return transaction(source, SERVICE_SETUP_SQL, [String(SERVICE_STATEMENT_TIMEOUT_MS)], fn);
}

/** One transaction as `authenticated` with these claims. RLS applies. */
export function withUser<T>(claims: Claims, fn: (db: Db) => Promise<T>): Promise<T> {
  return userTransaction(activeDriver, claims, fn);
}

/** One transaction as the connection's own role. RLS does not apply. Sync jobs, first-login row, cron. */
export function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return serviceTransaction(activeDriver, fn);
}

/**
 * withUser and withService bound to one driver, whatever the active driver
 * is. For the test harness.
 */
export function handleFor(driver: Driver): DbHandle {
  const source = () => Promise.resolve(driver);
  return {
    withUser: (claims, fn) => userTransaction(source, claims, fn),
    withService: (fn) => serviceTransaction(source, fn),
  };
}

/** The driver installed with setDriver, if any. */
export function installedDriver(): Driver | undefined {
  return state().override;
}

/**
 * Makes `driver` the one behind withUser and withService, ahead of the
 * environment. For tests: createTestDb() in testing.ts calls this.
 */
export function setDriver(driver: Driver): void {
  state().override = driver;
}

/** Undoes setDriver. The environment decides again. Does not close anything. */
export function resetDriver(): void {
  state().override = undefined;
}

/**
 * Registers a function that fills the fixture database (VENTISOL_FIXTURES=1,
 * no connection string). It runs once per process and per `key`, after the
 * migrations and before the first query from anywhere else is answered. The
 * seed may call the module-level withUser/withService (or the handle it is
 * given): calls made inside a seed are let through, all others wait for it.
 * Registering is cheap and does nothing outside fixture mode. A seed that
 * throws makes every later query fail with its error.
 */
export function onFixtureDbReady(key: string, seed: FixtureSeed): void {
  const fixture = state().fixture;
  if (fixture.done.has(key)) return;
  fixture.seeds.set(key, seed);
}
