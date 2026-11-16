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

import { STATION_KINDS, type StationKind } from "./format";

export { STATION_KIND_LABELS, STATION_KINDS, type StationKind } from "./format";

export type Station = {
  stationNo: number;
  name: string;
  kind: StationKind;
  opticloudMachineId: string | null;
  sortOrder: number;
  active: boolean;
};

type StationRow = {
  station_no: number;
  name: string;
  kind: StationKind;
  opticloud_machine_id: string | null;
  sort_order: number;
  active: boolean;
};

const COLUMNS = "station_no, name, kind, opticloud_machine_id, sort_order, active";

const toStation = (row: StationRow): Station => ({
  stationNo: row.station_no,
  name: row.name,
  kind: row.kind,
  opticloudMachineId: row.opticloud_machine_id,
  sortOrder: row.sort_order,
  active: row.active,
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
    await db.query(
      `insert into config.stations (${COLUMNS}) values ($1, $2, $3, $4, $5, $6)`,
      [
        station.stationNo,
        station.name,
        station.kind,
        station.opticloudMachineId,
        station.sortOrder,
        station.active,
      ]
    );
    await audit(db, "station.create", String(station.stationNo), { after: station });
    return OK;
  });
}

/** Change a station. `stationNo` says which one; the number itself stays. */
export async function updateStation(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = stationSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const station = parsed.data;

  return runWrite(claims, async (db) => {
    const before = await findStation(db, station.stationNo);
    if (!before) throw new Refused(fail(`Station ${station.stationNo} findes ikke.`));
    const updated = await db.query(
      `update config.stations
          set name = $2, kind = $3, opticloud_machine_id = $4, sort_order = $5, active = $6
        where station_no = $1
        returning station_no`,
      [
        station.stationNo,
        station.name,
        station.kind,
        station.opticloudMachineId,
        station.sortOrder,
        station.active,
      ]
    );
    // The row can be read by every role, but only an admin's update touches it.
    if (updated.length === 0) refuseForbidden();
    await audit(db, "station.update", String(station.stationNo), { before, after: station });
    return OK;
  });
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
