// The settings data layer against the real migrations on an in-process
// PGlite. Row level security is on: the functions under test have no role
// checks of their own, so every refusal below is the database's.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Claims } from "@/lib/db";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { DEFAULT_ELEMENT_TYPE_RULES, ELEMENT_TYPES } from "@/lib/orderdoc/element-types";
import { getAuditLogPage } from "./audit-log";
import {
  getCalendar,
  overlappingShift,
  removeClosedDay,
  removeShift,
  saveClosedDay,
  saveShift,
  setDeductOffShift,
} from "./calendar";
import {
  activeElementTypeRules,
  createElementType,
  listElementTypes,
  parseStoredRule,
  restoreDefaultElementTypes,
  updateElementType,
} from "./element-types";
import { formatMinutes, parseMinutes } from "./format";
import { FORBIDDEN_MESSAGE, type ActionResult } from "./result";
import { settingsSectionsFor } from "./sections";
import {
  createStation,
  listParallelHints,
  listStations,
  saveStationChanged,
  setStationActive,
  updateStation,
} from "./stations";
import { getParallelSplit, setParallelSplit } from "./parallel-split";
import { getThresholds, saveThresholds, THRESHOLDS } from "./thresholds";
import { DEFAULT_CALENDAR, deriveOrder, insertSql, type DerivedOrder } from "@/lib/derive";
import type { Scan } from "@/lib/scans";
import { at, pass, scan } from "@/lib/test-helpers";
import { listTimes, saveTimes } from "./times";

const admin = testClaims("admin");
const planner = testClaims("planner");
const ledelse = testClaims("ledelse");
const viewer = testClaims("viewer");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

beforeEach(async () => {
  await testDb.reset();
});

afterAll(async () => {
  await testDb?.close();
});

type AuditRow = { opti_user_id: string | null; role: string | null; action: string; subject: string | null; detail: Record<string, unknown> };

function auditRows(): Promise<AuditRow[]> {
  return testDb.withService((db) =>
    db.query<AuditRow>("select opti_user_id, role, action, subject, detail from app.audit_log order by id")
  );
}

function expectForbidden(result: ActionResult) {
  expect(result).toEqual({ ok: false, error: FORBIDDEN_MESSAGE });
}

function fieldErrors(result: ActionResult): Record<string, string> {
  if (result.ok) throw new Error("expected a failed result");
  return result.fieldErrors ?? {};
}

const montage = {
  stationNo: 1,
  name: "Montage 1",
  kind: "assembly",
  opticloudMachineId: "",
  sortOrder: "10",
  active: true,
};

const door = {
  id: "doer",
  name: "Dør",
  sortOrder: 20,
  active: true,
  anyOpeningContains: "dør",
  noOpeningContains: "",
  minFields: "",
  maxFields: "",
};

async function seedMasterData() {
  expect(await createStation(admin, montage)).toEqual({ ok: true });
  expect(await createStation(admin, { ...montage, stationNo: 2, name: "Pakning", kind: "packing" })).toEqual({ ok: true });
  expect(await createElementType(admin, door)).toEqual({ ok: true });
}

describe("minutes format", () => {
  it("reads minutes with a decimal comma or point as whole seconds", () => {
    expect(parseMinutes("12")).toBe(720);
    expect(parseMinutes("12,5")).toBe(750);
    expect(parseMinutes(" 0.25 ")).toBe(15);
    expect(parseMinutes("0")).toBe(0);
    expect(parseMinutes("")).toBeNull();
    expect(parseMinutes("1440")).toBe(86_400);
  });

  it("refuses negative, too large, too precise and non-numeric text", () => {
    for (const bad of ["-1", "1441", "1,234", "abc", "1:30", "1,", ",5", "1e3"]) {
      expect(parseMinutes(bad), bad).toBe("invalid");
    }
  });

  it("formats seconds so they read back to the same seconds", () => {
    expect(formatMinutes(750)).toBe("12,5");
    expect(formatMinutes(720)).toBe("12");
    for (const seconds of [0, 1, 59, 100, 101, 3599, 86_400]) {
      expect(parseMinutes(formatMinutes(seconds)), String(seconds)).toBe(seconds);
    }
  });
});

describe("sections", () => {
  it("shows each role the sections it may open", () => {
    expect(settingsSectionsFor("admin").map((s) => s.id)).toEqual([
      "brugere", "stationer", "elementtyper", "tider", "kalender", "graensevaerdier", "synkronisering", "log",
    ]);
    expect(settingsSectionsFor("planner").map((s) => s.id)).toEqual([
      "stationer", "elementtyper", "tider", "kalender", "graensevaerdier",
    ]);
    expect(settingsSectionsFor("ledelse")).toEqual([]);
    expect(settingsSectionsFor("viewer")).toEqual([]);
  });
});

describe("stations", () => {
  it("lets an admin add, edit and deactivate, with audit rows", async () => {
    expect(await createStation(admin, montage)).toEqual({ ok: true });
    expect(await listStations(admin)).toEqual([
      { stationNo: 1, name: "Montage 1", kind: "assembly", opticloudMachineId: null, sortOrder: 10, active: true, maxOpen: 1 },
    ]);

    expect(
      await updateStation(admin, { ...montage, name: "Montage A", opticloudMachineId: " m-17 ", sortOrder: 5 })
    ).toEqual({ ok: true });
    expect(await setStationActive(admin, { stationNo: 1, active: false })).toEqual({ ok: true });

    const [station] = await listStations(viewer);
    expect(station).toMatchObject({ name: "Montage A", opticloudMachineId: "m-17", sortOrder: 5, active: false });

    const log = await auditRows();
    expect(log.map((r) => r.action)).toEqual(["station.create", "station.update", "station.deactivate"]);
    expect(log[1]).toMatchObject({ opti_user_id: "test-admin", role: "admin", subject: "1" });
    expect(log[1].detail).toMatchObject({ before: { name: "Montage 1" }, after: { name: "Montage A" } });
  });

  it("keeps Max i gang when an edit leaves it out, and tells when it changed", async () => {
    expect(await createStation(admin, { ...montage, maxOpen: "6" })).toEqual({ ok: true });
    expect((await listStations(admin))[0].maxOpen).toBe(6);
    expect(await saveStationChanged(admin, "update", { ...montage, name: "Glas" })).toEqual({
      result: { ok: true },
      maxOpenChanged: false,
    });
    expect((await listStations(admin))[0]).toMatchObject({ name: "Glas", maxOpen: 6 });
    expect(await saveStationChanged(admin, "update", { ...montage, maxOpen: 1 })).toEqual({
      result: { ok: true },
      maxOpenChanged: true,
    });
    expect(await saveStationChanged(admin, "create", { ...montage, stationNo: 2, maxOpen: 3 })).toEqual({
      result: { ok: true },
      maxOpenChanged: true,
    });
    expect(fieldErrors(await updateStation(admin, { ...montage, maxOpen: "21" }))).toHaveProperty("maxOpen");
    expect(fieldErrors(await updateStation(admin, { ...montage, maxOpen: "0" }))).toHaveProperty("maxOpen");
  });

  it("refuses bad input with a message per field", async () => {
    const result = await createStation(admin, { ...montage, stationNo: "0", name: "  ", kind: "robot", sortOrder: "-1" });
    expect(Object.keys(fieldErrors(result)).sort()).toEqual(["kind", "name", "sortOrder", "stationNo"]);
    expect(await listStations(admin)).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses a number that is taken and an edit of a station that is not there", async () => {
    await createStation(admin, montage);
    expect(fieldErrors(await createStation(admin, montage))).toHaveProperty("stationNo");
    expect(await updateStation(admin, { ...montage, stationNo: 99 })).toMatchObject({ ok: false });
    expect(await setStationActive(admin, { stationNo: 99, active: false })).toMatchObject({ ok: false });
  });

  it.each([planner, ledelse, viewer])("is refused by the database for $role", async (claims: Claims) => {
    await createStation(admin, montage);
    expectForbidden(await createStation(claims, { ...montage, stationNo: 2 }));
    expectForbidden(await updateStation(claims, { ...montage, name: "Hacket" }));
    expectForbidden(await setStationActive(claims, { stationNo: 1, active: false }));
    expect(await listStations(admin)).toEqual([expect.objectContaining({ stationNo: 1, name: "Montage 1", active: true })]);
    expect((await auditRows()).map((r) => r.action)).toEqual(["station.create"]);
  });
});

describe("parallel split", () => {
  it("is calculated by default, and a planner can change it, audited, with changed only on a change", async () => {
    expect((await getParallelSplit(viewer)).value).toBe("calculated");
    expect(await setParallelSplit(planner, "equal")).toEqual({ result: { ok: true }, changed: true });
    expect(await setParallelSplit(planner, "equal")).toEqual({ result: { ok: true }, changed: false });
    expect(await getParallelSplit(viewer)).toMatchObject({ value: "equal", updatedBy: planner.optiUserId });
    expect((await setParallelSplit(admin, "weighted")).result).toMatchObject({ ok: false });
    expectForbidden((await setParallelSplit(viewer, "calculated")).result);
    expect((await auditRows()).map((r) => r.action)).toEqual(["setting.update"]);
  });
});

describe("the hint to raise Max i gang", () => {
  const el = (piece: number) => ({ barcode: `0585560501${String(piece).padStart(2, "0")}`, piece });

  /** Derives one order from these scans and stores its rows, as the read model would. */
  async function store(scans: Scan[], now: number) {
    const derived = deriveOrder(scans, null, { now, calendar: DEFAULT_CALENDAR }) as DerivedOrder;
    await testDb.withService(async (db) => {
      for (const [table, list] of [
        ["orders", [derived.order]],
        ["elements", derived.elements],
        ["stationIntervals", derived.intervals],
      ] as const) {
        for (const row of list) {
          const { sql, values } = insertSql(table, row);
          await db.query(sql, values);
        }
      }
    });
  }

  it("names a station at 1 where elements were taken over by another three times, not by a re-scan", async () => {
    await createStation(admin, montage);
    const now = at("12:00");
    // Four elements scanned in one after the other, never out: three taken over by another.
    // A fifth scanned in twice: taken over by itself, which does not count.
    await store(
      [
        ...[1, 2, 3, 4].map((piece, i) => scan("In", at("07:00") + i * 600_000, el(piece))),
        scan("In", at("06:00"), el(5)),
        ...pass(at("06:10"), at("06:20"), el(5)),
      ],
      now
    );
    expect(await listParallelHints(viewer, now)).toEqual({ 1: 3 });
    // Gone after seven days, and never shown for a station above 1.
    expect(await listParallelHints(viewer, now + 8 * 86_400_000)).toEqual({});
    expect(await updateStation(admin, { ...montage, maxOpen: 6 })).toEqual({ ok: true });
    expect(await listParallelHints(viewer, now)).toEqual({});
  });
});

describe("element types", () => {
  it("creates the defaults in an empty table and restores them later", async () => {
    expect(await listElementTypes(admin)).toEqual([]);
    expect(await restoreDefaultElementTypes(admin)).toEqual({ ok: true });

    const types = await listElementTypes(admin);
    expect(types.map((t) => t.id)).toEqual(["terrassedoer", "doer", "vindue-1-fag", "vindue-2-fag", "vindue-3-fag", "andet"]);
    expect(types.find((t) => t.id === "andet")?.rule).toBeNull();
    expect(activeElementTypeRules(types)).toEqual(DEFAULT_ELEMENT_TYPE_RULES);
    for (const type of types) {
      expect(type.name).toBe(ELEMENT_TYPES.find((t) => t.id === type.id)?.name);
    }

    // Change a default, add an own type, restore: the default is back, the own type stays.
    await updateElementType(admin, { ...door, name: "Port", anyOpeningContains: "port", active: false });
    await createElementType(admin, { ...door, id: "skydedoer", name: "Skydedør", sortOrder: 5, anyOpeningContains: ["skydedør"] });
    expect(await restoreDefaultElementTypes(admin)).toEqual({ ok: true });
    const restored = await listElementTypes(admin);
    expect(restored.find((t) => t.id === "doer")).toMatchObject({
      name: "Dør",
      active: true,
      rule: { type: "doer", anyOpeningContains: ["dør"] },
    });
    expect(restored.find((t) => t.id === "skydedoer")).toMatchObject({ name: "Skydedør" });

    const actions = (await auditRows()).map((r) => r.action);
    expect(actions).toEqual([
      "element_type.restore_defaults",
      "element_type.update",
      "element_type.create",
      "element_type.restore_defaults",
    ]);
  });

  it("stores the rule as one object per type and reads it back", async () => {
    expect(
      await createElementType(admin, {
        id: "vindue-2-fag",
        name: "Vindue 2 fag",
        sortOrder: "30",
        active: true,
        anyOpeningContains: "",
        noOpeningContains: "dør, port",
        minFields: "2",
        maxFields: 2,
      })
    ).toEqual({ ok: true });
    const stored = await testDb.withService((db) =>
      db.query<{ recognition: unknown }>("select recognition from config.element_types where id = 'vindue-2-fag'")
    );
    expect(stored[0].recognition).toEqual({ type: "vindue-2-fag", noOpeningContains: ["dør", "port"], minFields: 2, maxFields: 2 });

    // No condition at all: no rule.
    await createElementType(admin, { ...door, id: "andet", name: "Andet", anyOpeningContains: "" });
    expect((await listElementTypes(admin)).find((t) => t.id === "andet")?.rule).toBeNull();
  });

  it("refuses a bad rule and a bad id", async () => {
    const result = await createElementType(admin, {
      ...door,
      id: "Dør 1",
      anyOpeningContains: "dør",
      noOpeningContains: "DØR",
      minFields: "3",
      maxFields: "2",
    });
    expect(Object.keys(fieldErrors(result)).sort()).toEqual(["id", "maxFields", "noOpeningContains"]);

    expect(fieldErrors(await createElementType(admin, { ...door, minFields: "0" }))).toHaveProperty("minFields");
    expect(fieldErrors(await createElementType(admin, { ...door, maxFields: "to" }))).toHaveProperty("maxFields");
    expect(fieldErrors(await createElementType(admin, { ...door, anyOpeningContains: 7 }))).toHaveProperty("anyOpeningContains");
    expect(await listElementTypes(admin)).toEqual([]);

    await createElementType(admin, door);
    expect(fieldErrors(await createElementType(admin, door))).toHaveProperty("id");
    expect(await updateElementType(admin, { ...door, id: "findes-ikke" })).toMatchObject({ ok: false });
  });

  it("reads whatever is stored without throwing", () => {
    expect(parseStoredRule("x", null)).toBeNull();
    expect(parseStoredRule("x", "tekst")).toBeNull();
    expect(parseStoredRule("x", [1, 2])).toBeNull();
    expect(parseStoredRule("x", { type: "y", minFields: "2", anyOpeningContains: [" dør ", 3, ""] })).toEqual({
      type: "x",
      anyOpeningContains: ["dør"],
    });
  });

  it.each([planner, ledelse, viewer])("is refused by the database for $role", async (claims: Claims) => {
    await createElementType(admin, door);
    expectForbidden(await createElementType(claims, { ...door, id: "ny" }));
    expectForbidden(await updateElementType(claims, { ...door, name: "Hacket" }));
    expectForbidden(await restoreDefaultElementTypes(claims));
    expect((await listElementTypes(admin)).map((t) => [t.id, t.name])).toEqual([["doer", "Dør"]]);
    expect((await auditRows()).map((r) => r.action)).toEqual(["element_type.create"]);
  });
});

describe("times", () => {
  beforeEach(seedMasterData);

  const cell = (minutes: string, stationNo: number | string = 1, elementTypeId = "doer") => ({ stationNo, elementTypeId, minutes });

  it.each([
    ["normal", admin],
    ["normal", planner],
    ["calculated", admin],
    ["calculated", planner],
  ] as const)("lets %s times be set, changed and cleared (%o)", async (kind, claims) => {
    expect(await saveTimes(claims, kind, [cell("12,5"), cell("3", 2)])).toEqual({ ok: true });
    let times = await listTimes(claims, kind);
    expect(times).toEqual([
      expect.objectContaining({ stationNo: 1, elementTypeId: "doer", seconds: 750, source: "manual", updatedBy: claims.optiUserId }),
      expect.objectContaining({ stationNo: 2, elementTypeId: "doer", seconds: 180, source: "manual", updatedBy: claims.optiUserId }),
    ]);
    expect(times[0].updatedAt).toBeInstanceOf(Date);

    // Unchanged cell: untouched. Changed cell: written. Empty cell: deleted.
    expect(await saveTimes(claims, kind, [cell("12.50"), cell("", 2)])).toEqual({ ok: true });
    expect(await saveTimes(claims, kind, [cell("10")])).toEqual({ ok: true });
    times = await listTimes(claims, kind);
    expect(times.map((t) => [t.stationNo, t.seconds])).toEqual([[1, 600]]);

    const prefix = kind === "normal" ? "normal_time" : "calculated_time";
    const log = (await auditRows()).filter((r) => r.action.startsWith(prefix));
    expect(log.map((r) => [r.action, r.subject])).toEqual([
      [`${prefix}.set`, "1/doer"],
      [`${prefix}.set`, "2/doer"],
      [`${prefix}.clear`, "2/doer"],
      [`${prefix}.set`, "1/doer"],
    ]);
    expect(log[3].detail).toEqual({
      before: { seconds: 750, source: "manual" },
      after: { seconds: 600, source: "manual" },
    });
    expect(log[3]).toMatchObject({ opti_user_id: claims.optiUserId, role: claims.role });
  });

  it("takes over a baseline value as manual even when the seconds are the same", async () => {
    await testDb.withService((db) =>
      db.query("insert into config.normal_times (station_no, element_type_id, seconds, source) values (1, 'doer', 600, 'baseline')")
    );
    expect(await saveTimes(planner, "normal", [cell("10")])).toEqual({ ok: true });
    expect((await listTimes(planner, "normal"))[0]).toMatchObject({ seconds: 600, source: "manual", updatedBy: "test-planner" });
  });

  it("refuses negative and malformed times and saves nothing", async () => {
    const result = await saveTimes(admin, "normal", [cell("5"), cell("-3", 2)]);
    expect(fieldErrors(result)).toEqual({ "2:doer": expect.stringContaining("minutter") });
    expect(fieldErrors(await saveTimes(admin, "normal", [cell("1:30")]))).toHaveProperty("1:doer");
    expect(fieldErrors(await saveTimes(admin, "normal", [cell("2000")]))).toHaveProperty("1:doer");
    expect(await listTimes(admin, "normal")).toEqual([]);
  });

  it("refuses an unknown station, an unknown element type and an unknown kind, and rolls back", async () => {
    const unknownStation = await saveTimes(admin, "normal", [cell("5"), cell("5", 99)]);
    expect(unknownStation).toMatchObject({ ok: false, fieldErrors: { "99:doer": "Ukendt station." } });
    const unknownType = await saveTimes(admin, "calculated", [cell("5", 1, "findes-ikke")]);
    expect(unknownType).toMatchObject({ ok: false, fieldErrors: { "1:findes-ikke": "Ukendt elementtype." } });
    expect(await saveTimes(admin, "andet", [cell("5")])).toMatchObject({ ok: false });
    expect(await saveTimes(admin, "normal", "ikke en liste")).toMatchObject({ ok: false });

    // The first cell of the first call was valid, but the transaction was rolled back.
    expect(await listTimes(admin, "normal")).toEqual([]);
    expect(await listTimes(admin, "calculated")).toEqual([]);
    expect((await auditRows()).filter((r) => r.action.includes("_time."))).toEqual([]);
  });

  it.each([ledelse, viewer])("is refused by the database for $role", async (claims: Claims) => {
    await saveTimes(admin, "normal", [cell("10")]);
    await saveTimes(admin, "calculated", [cell("8")]);

    expectForbidden(await saveTimes(claims, "normal", [cell("1")]));
    expectForbidden(await saveTimes(claims, "normal", [cell("")]));
    expectForbidden(await saveTimes(claims, "normal", [cell("7", 2)]));
    expectForbidden(await saveTimes(claims, "calculated", [cell("1")]));
    expectForbidden(await saveTimes(claims, "calculated", [cell("7", 2)]));
    // Clearing a calculated time: ledelse can see the row and is refused. A
    // viewer cannot even see it, so there is nothing to clear and nothing happens.
    const cleared = await saveTimes(claims, "calculated", [cell("")]);
    if (claims.role === "viewer") expect(cleared).toEqual({ ok: true });
    else expectForbidden(cleared);

    expect((await listTimes(admin, "normal")).map((t) => t.seconds)).toEqual([600]);
    expect((await listTimes(admin, "calculated")).map((t) => t.seconds)).toEqual([480]);
    const log = await auditRows();
    expect(log.filter((r) => r.opti_user_id === claims.optiUserId)).toEqual([]);
  });

  it("never shows a viewer the calculated times", async () => {
    await saveTimes(admin, "calculated", [cell("8")]);
    expect(await listTimes(viewer, "calculated")).toEqual([]);
    expect(await listTimes(ledelse, "calculated")).toHaveLength(1);
  });
});

describe("calendar", () => {
  it("starts with the seeded day shift and the switch on", async () => {
    const calendar = await getCalendar(viewer);
    expect(calendar.shifts).toHaveLength(5);
    expect(calendar.shifts[0]).toEqual({ weekday: 1, start: "06:00", end: "14:00" });
    expect(calendar.closedDays).toEqual([]);
    expect(calendar.deductOffShift).toBe(true);
  });

  it.each([admin, planner])("lets $role add, move and remove shifts", async (claims: Claims) => {
    // A second shift the same day, meeting the first end to start.
    expect(await saveShift(claims, { weekday: 1, start: "14:00", end: "22.00" })).toEqual({ ok: true });
    expect(await saveShift(claims, { weekday: "6", start: "7:00", end: "1200" })).toEqual({ ok: true });
    expect(await saveShift(claims, { weekday: 1, originalStart: "14:00", start: "14:30", end: "22:30" })).toEqual({ ok: true });
    // A shift may be changed in place even though it "overlaps" its old self.
    expect(await saveShift(claims, { weekday: 1, originalStart: "06:00", start: "06:00", end: "14:30" })).toEqual({ ok: true });
    expect(await removeShift(claims, { weekday: 6, start: "07:00" })).toEqual({ ok: true });

    const monday = (await getCalendar(claims)).shifts.filter((s) => s.weekday === 1);
    expect(monday).toEqual([
      { weekday: 1, start: "06:00", end: "14:30" },
      { weekday: 1, start: "14:30", end: "22:30" },
    ]);
    expect((await getCalendar(claims)).shifts.filter((s) => s.weekday === 6)).toEqual([]);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      "calendar_shift.create",
      "calendar_shift.create",
      "calendar_shift.update",
      "calendar_shift.update",
      "calendar_shift.delete",
    ]);
  });

  it("refuses overlapping shifts, shifts that end before they start and bad times", async () => {
    for (const [start, end] of [["05:00", "06:01"], ["13:59", "15:00"], ["07:00", "08:00"], ["05:00", "15:00"], ["06:00", "14:00"]]) {
      const result = await saveShift(admin, { weekday: 1, start, end });
      expect(fieldErrors(result), `${start} to ${end}`).toHaveProperty("start");
    }
    expect(fieldErrors(await saveShift(admin, { weekday: 6, start: "14:00", end: "06:00" }))).toHaveProperty("end");
    expect(fieldErrors(await saveShift(admin, { weekday: 6, start: "08:00", end: "08:00" }))).toHaveProperty("end");
    expect(fieldErrors(await saveShift(admin, { weekday: 6, start: "25:00", end: "26:00" }))).toHaveProperty("start");
    expect(fieldErrors(await saveShift(admin, { weekday: 8, start: "08:00", end: "09:00" }))).toHaveProperty("weekday");
    // Moving a shift onto its neighbour.
    await saveShift(admin, { weekday: 1, start: "14:00", end: "22:00" });
    expect(fieldErrors(await saveShift(admin, { weekday: 1, originalStart: "14:00", start: "13:00", end: "22:00" }))).toHaveProperty("start");
    expect(await saveShift(admin, { weekday: 1, originalStart: "09:00", start: "09:00", end: "10:00" })).toMatchObject({ ok: false });

    expect((await getCalendar(admin)).shifts).toHaveLength(6);
  });

  it("finds overlaps but not shifts that only meet", () => {
    const day = [{ start: "06:00", end: "14:00" }];
    expect(overlappingShift({ start: "14:00", end: "22:00" }, day)).toBeUndefined();
    expect(overlappingShift({ start: "00:00", end: "06:00" }, day)).toBeUndefined();
    expect(overlappingShift({ start: "13:59", end: "22:00" }, day)).toEqual(day[0]);
  });

  it.each([admin, planner])("lets $role add, rename, move and remove closed days", async (claims: Claims) => {
    expect(await saveClosedDay(claims, { day: "2026-12-24", name: " Juleaften " })).toEqual({ ok: true });
    expect(await saveClosedDay(claims, { day: "2027-01-01", name: "" })).toEqual({ ok: true });
    expect(await saveClosedDay(claims, { originalDay: "2026-12-24", day: "2026-12-25", name: "Juledag" })).toEqual({ ok: true });
    expect(await removeClosedDay(claims, { day: "2027-01-01" })).toEqual({ ok: true });
    expect((await getCalendar(claims)).closedDays).toEqual([{ day: "2026-12-25", name: "Juledag" }]);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      "closed_day.create",
      "closed_day.create",
      "closed_day.update",
      "closed_day.delete",
    ]);
  });

  it("refuses bad and duplicate closed days", async () => {
    expect(fieldErrors(await saveClosedDay(admin, { day: "2026-02-30", name: "x" }))).toHaveProperty("day");
    expect(fieldErrors(await saveClosedDay(admin, { day: "24-12-2026", name: "x" }))).toHaveProperty("day");
    expect(fieldErrors(await saveClosedDay(admin, { day: "2026-12-24", name: "x".repeat(81) }))).toHaveProperty("name");
    await saveClosedDay(admin, { day: "2026-12-24", name: "Juleaften" });
    expect(fieldErrors(await saveClosedDay(admin, { day: "2026-12-24", name: "Igen" }))).toHaveProperty("day");
    expect((await getCalendar(admin)).closedDays).toHaveLength(1);
  });

  it.each([admin, planner])("lets $role turn the off-shift switch", async (claims: Claims) => {
    expect(await setDeductOffShift(claims, false)).toEqual({ ok: true });
    expect((await getCalendar(viewer)).deductOffShift).toBe(false);
    // The same value again writes nothing.
    expect(await setDeductOffShift(claims, false)).toEqual({ ok: true });
    expect(await setDeductOffShift(claims, "ja")).toMatchObject({ ok: false });
    const log = await auditRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "setting.update", subject: "deduct_off_shift", detail: { before: true, after: false } });
  });

  it.each([ledelse, viewer])("is refused by the database for $role", async (claims: Claims) => {
    await saveClosedDay(admin, { day: "2026-12-24", name: "Juleaften" });
    expectForbidden(await saveShift(claims, { weekday: 6, start: "08:00", end: "12:00" }));
    expectForbidden(await saveShift(claims, { weekday: 1, originalStart: "06:00", start: "07:00", end: "15:00" }));
    expectForbidden(await removeShift(claims, { weekday: 1, start: "06:00" }));
    expectForbidden(await saveClosedDay(claims, { day: "2026-12-31", name: "Nytår" }));
    expectForbidden(await saveClosedDay(claims, { originalDay: "2026-12-24", day: "2026-12-24", name: "Hacket" }));
    expectForbidden(await removeClosedDay(claims, { day: "2026-12-24" }));
    expectForbidden(await setDeductOffShift(claims, false));

    const calendar = await getCalendar(admin);
    expect(calendar.shifts).toHaveLength(5);
    expect(calendar.closedDays).toEqual([{ day: "2026-12-24", name: "Juleaften" }]);
    expect(calendar.deductOffShift).toBe(true);
    expect((await auditRows()).filter((r) => r.opti_user_id === claims.optiUserId)).toEqual([]);
  });
});

describe("thresholds", () => {
  it("has a definition for every seeded threshold key, and the seeded values are inside the bounds", async () => {
    const seeded = await testDb.withService((db) =>
      db.query<{ key: string }>("select key from config.settings where key not in ('deduct_off_shift', 'parallel_split') order by key")
    );
    expect(THRESHOLDS.map((t) => t.key).sort()).toEqual(seeded.map((r) => r.key));
    for (const threshold of await getThresholds(viewer)) {
      expect(threshold.value, threshold.key).not.toBeNull();
      expect(threshold.value!, threshold.key).toBeGreaterThanOrEqual(threshold.min);
      expect(threshold.value!, threshold.key).toBeLessThanOrEqual(threshold.max);
      expect(threshold.updatedBy).toBeNull();
    }
  });

  it.each([admin, planner])("lets $role change values and audits only what changed", async (claims: Claims) => {
    const values = Object.fromEntries((await getThresholds(claims)).map((t) => [t.key, String(t.value)]));
    expect(await saveThresholds(claims, { ...values, late_threshold: "2", buffer_capacity: 45 })).toEqual({ ok: true });

    const after = await getThresholds(claims);
    expect(after.find((t) => t.key === "late_threshold")).toMatchObject({ value: 2, updatedBy: claims.optiUserId });
    expect(after.find((t) => t.key === "buffer_capacity")).toMatchObject({ value: 45 });
    expect(after.find((t) => t.key === "slow_threshold_percent")).toMatchObject({ value: 20, updatedBy: null });

    const log = await auditRows();
    expect(log.map((r) => [r.action, r.subject, r.detail])).toEqual([
      ["setting.update", "late_threshold", { before: 0, after: 2 }],
      ["setting.update", "buffer_capacity", { before: 40, after: 45 }],
    ]);
  });

  it("refuses values outside the bounds, decimals, text and unknown keys, and saves nothing", async () => {
    const result = await saveThresholds(admin, {
      late_threshold: "-1",
      slow_threshold_percent: "0",
      long_dwell_threshold_minutes: "12,5",
      standstill_threshold_minutes: "",
      calculation_deviation_threshold_percent: "abc",
      schirmer_assumed_minutes_per_batch: "5000",
      buffer_capacity: "50",
    });
    expect(Object.keys(fieldErrors(result)).sort()).toEqual([
      "calculation_deviation_threshold_percent",
      "late_threshold",
      "long_dwell_threshold_minutes",
      "schirmer_assumed_minutes_per_batch",
      "slow_threshold_percent",
      "standstill_threshold_minutes",
    ]);
    expect(await saveThresholds(admin, { deduct_off_shift: "1" })).toMatchObject({ ok: false });
    expect(await saveThresholds(admin, ["2"])).toMatchObject({ ok: false });
    expect((await getThresholds(admin)).find((t) => t.key === "buffer_capacity")?.value).toBe(40);
    expect(await auditRows()).toEqual([]);
  });

  it.each([ledelse, viewer])("is refused by the database for $role", async (claims: Claims) => {
    expectForbidden(await saveThresholds(claims, { late_threshold: "5" }));
    expect((await getThresholds(admin)).find((t) => t.key === "late_threshold")?.value).toBe(0);
    expect(await auditRows()).toEqual([]);
  });
});

describe("audit log page", () => {
  it("pages newest first and filters by user and action", async () => {
    await testDb.withService((db) =>
      db.query("insert into app.portal_users (opti_user_id, email, name, role) values ('test-planner', 'bente@ventisol.dk', 'Bente', 'planner')")
    );
    await createStation(admin, montage);
    await saveThresholds(planner, { late_threshold: "1" });
    await saveThresholds(planner, { late_threshold: "2" });
    await saveThresholds(admin, { late_threshold: "3" });

    const all = await getAuditLogPage(admin);
    expect(all.total).toBe(4);
    expect(all.pageCount).toBe(1);
    expect(all.entries.map((e) => [e.action, e.optiUserId])).toEqual([
      ["setting.update", "test-admin"],
      ["setting.update", "test-planner"],
      ["setting.update", "test-planner"],
      ["station.create", "test-admin"],
    ]);
    expect(all.entries[1].userName).toBe("Bente");
    expect(all.entries[0].userName).toBeNull();
    expect(all.actions).toEqual(["setting.update", "station.create"]);
    expect(all.users).toEqual([
      { id: "test-planner", name: "Bente" },
      { id: "test-admin", name: "test-admin" },
    ]);

    expect((await getAuditLogPage(admin, { user: "test-planner" })).total).toBe(2);
    expect((await getAuditLogPage(admin, { action: "station.create" })).entries).toHaveLength(1);
    expect((await getAuditLogPage(admin, { user: "test-planner", action: "station.create" })).total).toBe(0);

    const second = await getAuditLogPage(admin, { page: 2, pageSize: 3 });
    expect(second).toMatchObject({ page: 2, pageCount: 2, total: 4 });
    expect(second.entries.map((e) => e.action)).toEqual(["station.create"]);
    // A page past the end lands on the last one.
    expect((await getAuditLogPage(admin, { page: 99, pageSize: 3 })).page).toBe(2);
  });

  it("shows nothing to anyone but an admin", async () => {
    await createStation(admin, montage);
    for (const claims of [planner, ledelse, viewer]) {
      const page = await getAuditLogPage(claims);
      expect(page, claims.role).toMatchObject({ entries: [], total: 0, actions: [], users: [] });
    }
  });
});
