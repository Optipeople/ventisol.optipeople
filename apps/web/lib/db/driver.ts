// The seam between the public API in index.ts and the two engines behind it:
// node-postgres (hosted Supabase) and PGlite (tests and fixture mode).
// A driver only knows how to run one transaction. Roles and claims are set by
// index.ts with ordinary SQL, so both engines go through the same statements.

export interface Db {
  /**
   * Runs one statement and returns its rows. Values go in `params` as $1, $2:
   * never build SQL from input.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Driver {
  /** Runs `fn` in one transaction: commit when it resolves, rollback when it throws. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Frees connections or memory. The driver is not used again afterwards. */
  close(): Promise<void>;
}

// What a query returns, the same from both drivers:
//   bigint, numeric   number (count(*), sum() and avg() come back as these)
//   date              "YYYY-MM-DD" string, never a Date: a Date would shift
//                     the day with the server's time zone
//   timestamptz       Date
//   timestamp, time, interval   the text Postgres prints
//   json, jsonb       parsed
// What a parameter may be, the same for both drivers (node-postgres rules):
//   a JS array is sent as a Postgres array ('{1,2}'), so it fits int[] or
//   text[] but NOT jsonb. For a jsonb parameter pass JSON.stringify(value).
//   A plain object is sent as JSON.
