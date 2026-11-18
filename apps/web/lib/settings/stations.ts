// config.stations: read, add, edit. A station is never deleted here, only
// made inactive, because scans and reports may refer to its number.

import { z } from "zod";
import { withUser, type Claims, type Db } from "@/lib/db";
import { audit } from "@/lib/portal/audit";
import {
  fail,
  intField,
  invalid,
  OK,
  optionalText,
  Refused,
  refuseForbidden,
  runWrite,
  type ActionResult,
} from "./result";

import { MAX_OPEN_LIMIT, PARALLEL_HINT_DAYS, PARALLEL_HINT_MIN, STATION_KINDS, type StationKind } from "./format";

export {
  MAX_OPEN_LIMIT,
  PARALLEL_HINT_DAYS,
  PARALLEL_HINT_MIN,
  STATION_KIND_LABELS,
  STATION_KINDS,
  type StationKind,
} from "./format";

export type Station = {
  stationNo: number;
  name: string;
  kind: StationKind;
  opticloudMachineId: string | null;
  sortOrder: number;
  active: boolean;
  /** "Max i gang": elements one person may have in progress here at once. 1: one at a time. */
  maxOpen: number;
};

type StationRow = {
  station_no: number;
  name: string;
  kind: StationKind;
  opticloud_machine_id: string | null;
  sort_order: number;
  active: boolean;
  max_open: number;
};

const COLUMNS = "station_no, name, kind, opticloud_machine_id, sort_order, active, max_open";

const toStation = (row: StationRow): Station => ({
  stationNo: row.station_no,
  name: row.name,
  kind: row.kind,
  opticloudMachineId: row.opticloud_machine_id,
  sortOrder: row.sort_order,
  active: row.active,
  maxOpen: Number(row.max_open),
});

export const stationSchema = z.object({
  stationNo: intField(1, 9999, "Stationsnummeret skal være et helt tal mellem 1 og 9999."),
  name: z
    .string({ error: "Skriv et navn." })
    .trim()
    .min(1, "Skriv et navn.")
    .max(80, "Navnet må højst være 80 tegn."),
  kind: z.enum(STATION_KINDS, { error: "Vælg en art." }),
  opticloudMachineId: optionalText(100, "Maskine-id må højst være 100 tegn."),
  sortOrder: intField(0, 9999, "Rækkefølgen skal være et helt tal mellem 0 og 9999."),
  active: z.boolean({ error: "Vælg om stationen er aktiv." }),
  /** Left out: 1 for a new station, unchanged for an edit. */
  maxOpen: intField(1, MAX_OPEN_LIMIT, `Max i gang skal være et helt tal mellem 1 og ${MAX_OPEN_LIMIT}.`).optional(),
});

export type StationInput = z.infer<typeof stationSchema>;

/** For code that already has a transaction. */
export async function readStations(db: Db): Promise<Station[]> {
  const rows = await db.query<StationRow>(
    `select ${COLUMNS} from config.stations order by sort_order, station_no`
  );
  return rows.map(toStation);
}

/** Every station, inactive ones included, in display order. */
export function listStations(claims: Claims): Promise<Station[]> {
  return withUser(claims, readStations);
}

async function findStation(db: Db, stationNo: number): Promise<Station | null> {
  const rows = await db.query<StationRow>(
    `select ${COLUMNS} from config.stations where station_no = $1`,
    [stationNo]
  );
  return rows[0] ? toStation(rows[0]) : null;
}

/** Add a station. The number is the one in the barcode scans and cannot be changed later. */
export async function createStation(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = stationSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const station = parsed.data;

  return runWrite(claims, async (db) => {
    if (await findStation(db, station.stationNo)) {
      const message = `Station ${station.stationNo} findes allerede.`;
      throw new Refused(fail(message, { stationNo: message }));
    }
    const after = { ...station, maxOpen: station.maxOpen ?? 1 };
    await db.query(
      `insert into config.stations (${COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        after.stationNo,
        after.name,
        after.kind,
        after.opticloudMachineId,
        after.sortOrder,
        after.active,
        after.maxOpen,
      ]
    );
    await audit(db, "station.create", String(after.stationNo), { after });
    return OK;
  });
}

/** Change a station. `stationNo` says which one; the number itself stays. */
export async function updateStation(claims: Claims, input: unknown): Promise<ActionResult> {
  return (await saveStationChanged(claims, "update", input)).result;
}

/**
 * createStation or updateStation, which also tells whether the station's
 * "Max i gang" is now other than before (a new station: other than 1). The
 * server action then has the read model rebuilt, since pairing rests on it.
 */
export async function saveStationChanged(
  claims: Claims,
  mode: "create" | "update",
  input: unknown
): Promise<{ result: ActionResult; maxOpenChanged: boolean }> {
  if (mode === "create") {
    const result = await createStation(claims, input);
    const parsed = stationSchema.safeParse(input);
    return { result, maxOpenChanged: result.ok && parsed.success && (parsed.data.maxOpen ?? 1) !== 1 };
  }
  const parsed = stationSchema.safeParse(input);
  if (!parsed.success) return { result: invalid(parsed.error), maxOpenChanged: false };
  const station = parsed.data;

  let maxOpenChanged = false;
  const result = await runWrite(claims, async (db) => {
    const before = await findStation(db, station.stationNo);
    if (!before) throw new Refused(fail(`Station ${station.stationNo} findes ikke.`));
    const after = { ...station, maxOpen: station.maxOpen ?? before.maxOpen };
    const updated = await db.query(
      `update config.stations
          set name = $2, kind = $3, opticloud_machine_id = $4, sort_order = $5, active = $6, max_open = $7
        where station_no = $1
        returning station_no`,
      [
        after.stationNo,
        after.name,
        after.kind,
        after.opticloudMachineId,
        after.sortOrder,
        after.active,
        after.maxOpen,
      ]
    );
    // The row can be read by every role, but only an admin's update touches it.
    if (updated.length === 0) refuseForbidden();
    await audit(db, "station.update", String(after.stationNo), { before, after });
    maxOpenChanged = after.maxOpen !== before.maxOpen;
    return OK;
  });
  return { result, maxOpenChanged: result.ok && maxOpenChanged };
}

const activeSchema = z.object({
  stationNo: intField(1, 9999, "Ukendt station."),
  active: z.boolean({ error: "Vælg om stationen er aktiv." }),
});

/** Deactivate or reactivate a station. The row and its history stay. */
export async function setStationActive(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = activeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { stationNo, active } = parsed.data;

  return runWrite(claims, async (db) => {
    const before = await findStation(db, stationNo);
    if (!before) throw new Refused(fail(`Station ${stationNo} findes ikke.`));
    if (before.active === active) return OK;
    const updated = await db.query(
      "update config.stations set active = $2 where station_no = $1 returning station_no",
      [stationNo, active]
    );
    if (updated.length === 0) refuseForbidden();
    await audit(db, active ? "station.activate" : "station.deactivate", String(stationNo), {
      before: { active: before.active },
      after: { active },
    });
    return OK;
  });
}

/**
 * Stations set to "Max i gang" 1 where an element was left in progress while
 * another element was scanned in, at least PARALLEL_HINT_MIN times in the
 * last PARALLEL_HINT_DAYS days: a sign the station works several at once and
 * its max should be raised. By station number, the count.
 *
 * A superseded pass (core.station_intervals, missing_reason superseded) was
 * taken over by another element when the same element has no later pass at
 * that station: a re-scan of the same element always leaves a later pass,
 * the In that won.
 */
export function listParallelHints(claims: Claims, now: number = Date.now()): Promise<Record<number, number>> {
  return withUser(claims, async (db) => {
    const rows = await db.query<{ station_no: number; n: number }>(
      `select i.station_no, count(*)::integer as n
         from core.station_intervals i
         join config.stations c on c.station_no = i.station_no and c.max_open = 1
        where i.status = 'missing_out'
          and i.missing_reason = 'superseded'
          and i.start_at >= $1::timestamptz
          and not exists (
            select 1 from core.station_intervals j
             where j.barcode = i.barcode and j.station_no = i.station_no and j.start_at > i.start_at
          )
        group by i.station_no
       having count(*) >= $2::integer`,
      [new Date(now - PARALLEL_HINT_DAYS * 86_400_000).toISOString(), PARALLEL_HINT_MIN]
    );
    return Object.fromEntries(rows.map((r) => [r.station_no, Number(r.n)]));
  });
}
