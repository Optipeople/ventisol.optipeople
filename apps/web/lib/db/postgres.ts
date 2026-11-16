// The node-postgres driver: a small pool against the Supabase transaction
// pooler. Imported only by index.ts.

import pg from "pg";
import type { Db, Driver } from "./driver";

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

/**
 * Pool settings for a connection string. Exported for the unit test.
 *
 * - TLS is always on, except to a local Postgres or when the string says
 *   sslmode=disable. The certificate chain is not verified: Supabase's pooler
 *   presents a certificate signed by Supabase's own CA, which Node does not
 *   know, and the string's own sslmode=require would make node-postgres
 *   reject it. The link is still encrypted.
 * - The query parameters are dropped (sslmode, and extras the Vercel
 *   integration adds such as supa=...), so they cannot override this.
 * - Small pool: one serverless instance serves few requests at a time, and
 *   the transaction pooler shares its server connections between instances.
 */
export function poolConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const sslDisabled =
    url.searchParams.get("sslmode") === "disable" || LOCAL_HOSTS.has(url.hostname);
  url.search = "";
  return {
    connectionString: url.toString(),
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
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
