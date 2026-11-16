// config.settings: one jsonb value per key. The low-level read and write the
// calendar toggle and the thresholds share. Both run on a transaction the
// caller already holds.

import type { Db } from "@/lib/db";
import { audit } from "@/lib/portal/audit";
import { refuseForbidden } from "./result";

export type StoredSetting = {
  key: string;
  value: unknown;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export async function readSettings(
  db: Db,
  keys: ReadonlyArray<string>
): Promise<Map<string, StoredSetting>> {
  const rows = await db.query<{
    key: string;
    value: unknown;
    updated_at: Date | string | null;
    updated_by: string | null;
  }>("select key, value, updated_at, updated_by from config.settings where key = any($1::text[])", [
    [...keys],
  ]);
  return new Map(
    rows.map((row) => [
      row.key,
      {
        key: row.key,
        value: row.value,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at),
        // The seeded rows have no user: they are the defaults.
        updatedBy: row.updated_by,
      },
    ])
  );
}

/**
 * Store `value` under `key` as the user of the transaction and audit it as
 * "setting.update" with the value before and after. A role that may not
 * write settings is refused by the insert policy (the caller's runWrite
 * turns that into a result).
 */
export async function writeSetting(
  db: Db,
  key: string,
  value: boolean | number | string,
  before: unknown
): Promise<void> {
  const written = await db.query(
    `insert into config.settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), app.current_user_id())
     on conflict (key) do update
       set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
     returning key`,
    [key, JSON.stringify(value)]
  );
  if (written.length === 0) refuseForbidden();
  await audit(db, "setting.update", key, { before: before ?? null, after: value });
}
