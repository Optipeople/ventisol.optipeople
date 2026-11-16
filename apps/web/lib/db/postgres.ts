// The node-postgres driver: a small pool against the Supabase transaction
// pooler. Imported only by index.ts.

import pg from "pg";
import type { Db, Driver } from "./driver";
import { SUPABASE_ROOT_CA } from "./supabase-ca";

// Type oids whose default node-postgres parsing differs from PGlite's or
// loses information. See the table in driver.ts.
const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const TIMESTAMP = 1114;
const INTERVAL = 1186;
const INT8_ARRAY = 1016;
const NUMERIC_ARRAY = 1231;
const DATE_ARRAY = 1182;
const TIMESTAMP_ARRAY = 1115;
const INTERVAL_ARRAY = 1187;

function parseInt8(text: string): number | bigint {
  const value = BigInt(text);
  return value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)
    ? value
    : Number(value);
}

const asText = (text: string) => text;

// pg-types 2 exports arrayParser as { create(source, transform).parse() },
// not as the function its type declaration says.
const arrayParser = pg.types.arrayParser as unknown as {
  create(source: string, transform: (entry: string) => unknown): { parse(): unknown[] };
};

function arrayOf(parse: (text: string) => unknown) {
  return (text: string) => arrayParser.create(text, parse).parse();
}

const TEXT_PARSERS: Record<number, (text: string) => unknown> = {
  [INT8]: parseInt8,
  [NUMERIC]: Number,
  [DATE]: asText,
  [TIMESTAMP]: asText,
  [INTERVAL]: asText,
  [INT8_ARRAY]: arrayOf(parseInt8),
  [NUMERIC_ARRAY]: arrayOf(Number),
  [DATE_ARRAY]: arrayOf(asText),
  [TIMESTAMP_ARRAY]: arrayOf(asText),
  [INTERVAL_ARRAY]: arrayOf(asText),
};

/** Per-pool type parsers, so nothing global in `pg` is changed. */
export const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format !== "binary" && TEXT_PARSERS[oid]) return TEXT_PARSERS[oid];
    return pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isSupabaseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith(".supabase.com") || host.endsWith(".supabase.co");
}

/**
 * The TLS setting for a database host. Exported for the unit test.
 *
 * - Local Postgres, or sslmode=disable in the string: no TLS.
 * - DATABASE_SSL_INSECURE=1: TLS without checking the certificate. Only for
 *   an emergency, e.g. Supabase rotating its CA before this file follows.
 * - Supabase (pooler and direct): the certificate chain and host name are
 *   checked against Supabase's own root CA (supabase-ca.ts), which Node's
 *   built-in list does not hold.
 * - Any other host: checked against Node's built-in CAs.
 */
export function sslFor(
  hostname: string,
  sslmode: string | null,
  env: Record<string, string | undefined> = process.env
): pg.PoolConfig["ssl"] {
  if (sslmode === "disable" || LOCAL_HOSTS.has(hostname)) return false;
  if (env.DATABASE_SSL_INSECURE === "1") return { rejectUnauthorized: false };
  if (isSupabaseHost(hostname)) return { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

/**
 * Pool settings for a connection string. Exported for the unit test.
 *
 * - TLS as `sslFor` says.
 * - The query parameters are dropped (sslmode, and extras the Vercel
 *   integration adds such as supa=...), so they cannot override this.
 * - Small pool: one serverless instance serves few requests at a time, and
 *   the transaction pooler shares its server connections between instances.
 */
export function poolConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env
): pg.PoolConfig {
  const url = new URL(connectionString);
  const ssl = sslFor(url.hostname, url.searchParams.get("sslmode"), env);
  url.search = "";
  return {
    connectionString: url.toString(),
    ssl,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    keepAlive: true,
    types: typeParsers,
    application_name: "ventisol-portal",
  };
}

export function createPostgresDriver(connectionString: string): Driver {
  const pool = new pg.Pool(poolConfig(connectionString));
  // An idle client that loses its connection emits here. Without a listener
  // that would crash the process; the pool has already dropped the client.
  pool.on("error", (error) => {
    console.error("[db] idle connection error:", error.message);
  });

  return {
    async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      const db: Db = {
        // Unnamed statements only: the transaction pooler cannot keep a named
        // prepared statement between transactions.
        async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params);
          return result.rows as R[];
        },
      };
      try {
        await client.query("begin");
        const value = await fn(db);
        await client.query("commit");
        return value;
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // The connection is gone or in an unknown state: do not reuse it.
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
