// PGlite: Postgres in WASM, in process. The engine behind the tests and
// fixture mode. Never loaded in production: index.ts imports this file
// dynamically and only when fixture mode is on.

import { PGlite, types } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import pg from "pg";
import type { Db, Driver } from "./driver";
import { applyMigrations, type Migration } from "./migrations";

/**
 * What hosted Supabase has before our first migration and PGlite lacks: the
 * three API roles. The connection's own role (postgres) is a superuser in
 * PGlite, so it can `set role authenticated` like the postgres role on
 * Supabase, which is a member of it.
 */
export const BOOTSTRAP_SQL = `
do $bootstrap$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$bootstrap$;
`;

const asText = (text: string) => text;

// Same result types as the node-postgres driver (see driver.ts). PGlite
// already returns bigint as a number and uses these for array elements too.
const PARSERS = {
  [types.NUMERIC]: Number,
  [types.DATE]: asText,
  [types.TIMESTAMP]: asText,
};

/** An empty PGlite with our extensions, or one restored from a data dir dump. */
export function openPglite(options: { loadDataDir?: Blob } = {}): Promise<PGlite> {
  return PGlite.create({
    extensions: { vector, pg_trgm },
    parsers: PARSERS,
    loadDataDir: options.loadDataDir,
  });
}

/** Creates the Supabase roles and applies every migration. */
export async function bootstrapPglite(
  db: PGlite,
  migrations?: Migration[]
): Promise<string[]> {
  await db.exec(BOOTSTRAP_SQL);
  return applyMigrations((sql) => db.exec(sql), migrations);
}

/** A fresh PGlite with roles and all migrations, ready for a driver. */
export async function createPglite(): Promise<PGlite> {
  const db = await openPglite();
  await bootstrapPglite(db);
  return db;
}

// node-postgres turns every parameter into text before sending it. PGlite
// would serialise by the parameter's type instead, and so accept things that
// fail on the real database (a JS array for a jsonb parameter is the common
// one). Running node-postgres's own conversion first makes a test fail where
// production would.
const prepareValue = (pg as unknown as { utils: { prepareValue(value: unknown): unknown } })
  .utils.prepareValue;

function prepareParam(value: unknown): unknown {
  // Buffers stay binary: PGlite's bytea serialiser wants the bytes.
  if (value instanceof Uint8Array) return value;
  return prepareValue(value);
}

export function pgliteDriver(db: PGlite): Driver {
  return {
    transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // PGlite has one connection: transactions queue behind each other.
      return db.transaction(async (tx) => {
        const handle: Db = {
          async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
            const result = await tx.query<R>(sql, params?.map(prepareParam));
            return result.rows;
          },
        };
        return fn(handle);
      }) as Promise<T>;
    },
    async close() {
      if (!db.closed) await db.close();
    },
  };
}
