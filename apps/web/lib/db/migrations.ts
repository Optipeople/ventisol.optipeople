// Reads the SQL migrations in supabase/migrations at the repo root.
// Used by the PGlite harness (tests, fixture mode). The hosted project gets
// the same files through the Supabase tooling, not through this module.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Migration {
  /** File name, e.g. 20261116100000_foundation.sql. */
  name: string;
  sql: string;
}

const FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

/**
 * Finds supabase/migrations by walking up from `from` (default: the working
 * directory). Works from the repo root, from apps/web and from any folder
 * below it.
 */
export function migrationsDir(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "supabase", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No supabase/migrations folder found above ${resolve(from)}`);
    }
    dir = parent;
  }
}

/** Every migration, in name order (which is the order they are applied in). */
export function listMigrations(dir: string = migrationsDir()): Migration[] {
  const names = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) {
      throw new Error(
        `Migration ${name} is not named <yyyymmddhhmmss>_<lower_snake_name>.sql`
      );
    }
  }
  // Plain code unit order, not locale order: the same on every machine.
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Applies every migration in order through `exec`, which must accept a whole
 * file of SQL (several statements). Stops at the first failure and says which
 * file it was.
 */
export async function applyMigrations(
  exec: (sql: string) => Promise<unknown>,
  migrations: Migration[] = listMigrations()
): Promise<string[]> {
  for (const migration of migrations) {
    try {
      await exec(migration.sql);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.name} failed: ${reason}`, { cause: error });
    }
  }
  return migrations.map((migration) => migration.name);
}
