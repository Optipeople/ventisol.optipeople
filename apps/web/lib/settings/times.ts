// config.normal_times and config.calculated_times: seconds per station and
// element type.
//
// The portal shows and takes these times in minutes with decimals (see
// format.ts) and stores whole seconds. An empty field means "no time": the
// row is deleted.

import { z } from "zod";
import { withUser, type Claims, type Db } from "@/lib/db";
import { audit } from "@/lib/portal/audit";
import { MAX_TIME_MINUTES, parseMinutes, timeCellKey } from "./format";
import {
  fail,
  intField,
  invalid,
  INVALID_MESSAGE,
  OK,
  Refused,
  refuseForbidden,
  runWrite,
  type ActionResult,
} from "./result";

export type TimeKind = "normal" | "calculated";

// Fixed names, never built from input.
const TABLES: Readonly<Record<TimeKind, string>> = {
  normal: "config.normal_times",
  calculated: "config.calculated_times",
};

const AUDIT_PREFIX: Readonly<Record<TimeKind, string>> = {
  normal: "normal_time",
  calculated: "calculated_time",
};

export { formatMinutes, MAX_TIME_MINUTES, parseMinutes, TIME_FORMAT_HELP, timeCellKey } from "./format";

export type TimeCell = {
  stationNo: number;
  elementTypeId: string;
  seconds: number;
  source: "manual" | "baseline";
  updatedAt: Date;
  /** OptiCloud user id of who set it. */
  updatedBy: string | null;
};

type TimeRow = {
  station_no: number;
  element_type_id: string;
  seconds: number;
  source: "manual" | "baseline";
  updated_at: Date | string;
  updated_by: string | null;
};

async function readTimes(db: Db, kind: TimeKind): Promise<TimeCell[]> {
  const rows = await db.query<TimeRow>(
    `select station_no, element_type_id, seconds, source, updated_at, updated_by
       from ${TABLES[kind]}
      order by station_no, element_type_id`
  );
  return rows.map((row) => ({
    stationNo: row.station_no,
    elementTypeId: row.element_type_id,
    seconds: row.seconds,
    source: row.source,
    updatedAt: new Date(row.updated_at),
    updatedBy: row.updated_by,
  }));
}

/** Every stored time of one kind. A viewer gets no calculated times (row level security). */
export function listTimes(claims: Claims, kind: TimeKind): Promise<TimeCell[]> {
  return withUser(claims, (db) => readTimes(db, kind));
}

const kindSchema = z.enum(["normal", "calculated"], { error: "Ukendt tidstype." });

const entriesSchema = z
  .array(
    z.object({
      stationNo: intField(1, 9999, "Ukendt station."),
      elementTypeId: z.string({ error: "Ukendt elementtype." }).min(1, "Ukendt elementtype.").max(40, "Ukendt elementtype."),
      /** As typed: minutes with decimals, empty to clear. */
      minutes: z.string({ error: "Skriv tiden i minutter." }).max(20, "Skriv tiden i minutter."),
    }),
    { error: "Ingen tider at gemme." }
  )
  .max(2000, "For mange tider på én gang.");

export type TimeEntry = { stationNo: number; elementTypeId: string; minutes: string };

/**
 * Save a set of cells of one grid in one transaction. Each entry is the text
 * of one cell: a time sets it (source "manual", with who and when), an empty
 * text deletes it. Cells whose time does not change are left untouched, so
 * they keep who set them. Every change is audited as "<kind>_time.set" or
 * "<kind>_time.clear". One bad cell stops the whole save.
 */
export async function saveTimes(
  claims: Claims,
  kind: unknown,
  entries: unknown,
  /** "baseline" when the times come from an accepted baseline suggestion. Server code only. */
  source: "manual" | "baseline" = "manual"
): Promise<ActionResult> {
  const parsedKind = kindSchema.safeParse(kind);
  if (!parsedKind.success) return invalid(parsedKind.error);
  const parsed = entriesSchema.safeParse(entries);
  if (!parsed.success) return fail("Tiderne kunne ikke læses. Genindlæs siden og prøv igen.");

  const table = TABLES[parsedKind.data];
  const prefix = AUDIT_PREFIX[parsedKind.data];

  const fieldErrors: Record<string, string> = {};
  const wanted = new Map<string, { stationNo: number; elementTypeId: string; seconds: number | null }>();
  for (const entry of parsed.data) {
    const key = timeCellKey(entry.stationNo, entry.elementTypeId);
    const seconds = parseMinutes(entry.minutes);
    if (seconds === "invalid") {
      fieldErrors[key] = `Skriv minutter fra 0 til ${MAX_TIME_MINUTES} med højst to decimaler, for eksempel 12,5.`;
      continue;
    }
    wanted.set(key, { stationNo: entry.stationNo, elementTypeId: entry.elementTypeId, seconds });
  }
  if (Object.keys(fieldErrors).length > 0) return fail(INVALID_MESSAGE, fieldErrors);

  return runWrite(claims, async (db) => {
    const stations = new Set(
      (await db.query<{ station_no: number }>("select station_no from config.stations")).map(
        (r) => r.station_no
      )
    );
    const types = new Set(
      (await db.query<{ id: string }>("select id from config.element_types")).map((r) => r.id)
    );
    const current = new Map(
      (await readTimes(db, parsedKind.data)).map((c) => [timeCellKey(c.stationNo, c.elementTypeId), c])
    );

    for (const [key, cell] of wanted) {
      if (!stations.has(cell.stationNo)) {
        throw new Refused(fail(`Station ${cell.stationNo} findes ikke.`, { [key]: "Ukendt station." }));
      }
      if (!types.has(cell.elementTypeId)) {
        throw new Refused(
          fail(`Elementtypen "${cell.elementTypeId}" findes ikke.`, { [key]: "Ukendt elementtype." })
        );
      }
      const before = current.get(key);
      const subject = `${cell.stationNo}/${cell.elementTypeId}`;

      if (cell.seconds === null) {
        // Nothing there as far as this user can see. For a role that cannot
        // read the table that is also all it may know.
        if (!before) continue;
        const deleted = await db.query(
          `delete from ${table} where station_no = $1 and element_type_id = $2 returning station_no`,
          [cell.stationNo, cell.elementTypeId]
        );
        if (deleted.length === 0) refuseForbidden();
        await audit(db, `${prefix}.clear`, subject, {
          before: { seconds: before.seconds, source: before.source },
          after: null,
        });
        continue;
      }

      if (before && before.seconds === cell.seconds && before.source === source) continue;
      const written = await db.query(
        `insert into ${table} (station_no, element_type_id, seconds, source, updated_at, updated_by)
         values ($1, $2, $3, $4, now(), app.current_user_id())
         on conflict (station_no, element_type_id) do update
           set seconds = excluded.seconds, source = excluded.source,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by
         returning station_no`,
        [cell.stationNo, cell.elementTypeId, cell.seconds, source]
      );
      if (written.length === 0) refuseForbidden();
      await audit(db, `${prefix}.set`, subject, {
        before: before ? { seconds: before.seconds, source: before.source } : null,
        after: { seconds: cell.seconds, source },
      });
    }
    return OK;
  });
}
