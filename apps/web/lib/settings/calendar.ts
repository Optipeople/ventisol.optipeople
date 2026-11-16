// The calendar: weekly shifts (config.calendar_shifts), closed days
// (config.calendar_closed_days) and the switch "træk tid uden for skift fra"
// (config.settings, key deduct_off_shift). Times are Europe/Copenhagen wall
// clock, as "HH:MM".

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
import { readSettings, writeSetting } from "./store";

export const DEDUCT_OFF_SHIFT_KEY = "deduct_off_shift";

export { WEEKDAY_LABELS, weekdayLabel } from "./format";

export type Shift = {
  /** ISO: 1 Monday, 7 Sunday. */
  weekday: number;
  /** "HH:MM" */
  start: string;
  end: string;
};

export type ClosedDay = {
  /** "YYYY-MM-DD" */
  day: string;
  name: string | null;
};

export type Calendar = {
  shifts: Shift[];
  closedDays: ClosedDay[];
  /** Null when the setting is missing or not a boolean. */
  deductOffShift: boolean | null;
};

const hhmm = (time: string) => time.slice(0, 5);

async function readShifts(db: Db, weekday?: number): Promise<Shift[]> {
  const rows = await db.query<{ weekday: number; start_time: string; end_time: string }>(
    `select weekday, start_time::text as start_time, end_time::text as end_time
       from config.calendar_shifts
      where $1::int is null or weekday = $1::int
      order by weekday, start_time`,
    [weekday ?? null]
  );
  return rows.map((row) => ({
    weekday: Number(row.weekday),
    start: hhmm(row.start_time),
    end: hhmm(row.end_time),
  }));
}

export function getCalendar(claims: Claims): Promise<Calendar> {
  return withUser(claims, async (db) => {
    const shifts = await readShifts(db);
    const closedDays = await db.query<ClosedDay>(
      "select day, name from config.calendar_closed_days order by day"
    );
    const setting = (await readSettings(db, [DEDUCT_OFF_SHIFT_KEY])).get(DEDUCT_OFF_SHIFT_KEY);
    return {
      shifts,
      closedDays: closedDays.map((d) => ({ day: String(d.day), name: d.name })),
      deductOffShift: typeof setting?.value === "boolean" ? setting.value : null,
    };
  });
}

const timeMessage = "Skriv et klokkeslæt som TT:MM, for eksempel 06:00.";

/** "6:00", "06.00" and "0600" are taken too, and come out as "06:00". */
const timeField = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const match = /^(\d{1,2})[:.]?(\d{2})$/.exec(value.trim());
    if (!match) return value;
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  },
  z.string({ error: timeMessage }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, timeMessage)
);

const weekdayField = intField(1, 7, "Vælg en ugedag.");

export const shiftSchema = z
  .object({
    weekday: weekdayField,
    start: timeField,
    end: timeField,
    /** The start the shift had when it was loaded. Missing: a new shift. */
    originalStart: timeField.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.end <= value.start) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "Skiftet skal slutte efter det starter. Et skift kan ikke gå over midnat.",
      });
    }
  });

/** The first shift in `others` that shares time with `shift`. Meeting end to start is not an overlap. */
export function overlappingShift(
  shift: Pick<Shift, "start" | "end">,
  others: ReadonlyArray<Pick<Shift, "start" | "end">>
): Pick<Shift, "start" | "end"> | undefined {
  return others.find((other) => shift.start < other.end && other.start < shift.end);
}

/**
 * Add a shift, or change one (`originalStart` given). Refused when it ends
 * before it starts or overlaps another shift on the same weekday.
 */
export async function saveShift(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { weekday, start, end, originalStart } = parsed.data;

  return runWrite(claims, async (db) => {
    const sameDay = await readShifts(db, weekday);
    const before = originalStart ? sameDay.find((s) => s.start === originalStart) : undefined;
    if (originalStart && !before) {
      throw new Refused(fail("Skiftet findes ikke længere. Genindlæs siden."));
    }
    const others = sameDay.filter((s) => s !== before);
    const clash = overlappingShift({ start, end }, others);
    if (clash) {
      const message = `Skiftet overlapper skiftet ${clash.start} til ${clash.end} samme dag.`;
      throw new Refused(fail(message, { start: message }));
    }

    const subject = `${weekday} ${start}`;
    if (before) {
      const updated = await db.query(
        `update config.calendar_shifts
            set start_time = $3::time, end_time = $4::time
          where weekday = $1 and start_time = $2::time
          returning weekday`,
        [weekday, before.start, start, end]
      );
      if (updated.length === 0) refuseForbidden();
      await audit(db, "calendar_shift.update", subject, {
        before: { weekday, start: before.start, end: before.end },
        after: { weekday, start, end },
      });
    } else {
      await db.query(
        "insert into config.calendar_shifts (weekday, start_time, end_time) values ($1, $2::time, $3::time)",
        [weekday, start, end]
      );
      await audit(db, "calendar_shift.create", subject, { after: { weekday, start, end } });
    }
    return OK;
  });
}

const removeShiftSchema = z.object({ weekday: weekdayField, start: timeField });

export async function removeShift(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = removeShiftSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { weekday, start } = parsed.data;

  return runWrite(claims, async (db) => {
    const before = (await readShifts(db, weekday)).find((s) => s.start === start);
    if (!before) return OK;
    const deleted = await db.query(
      "delete from config.calendar_shifts where weekday = $1 and start_time = $2::time returning weekday",
      [weekday, start]
    );
    if (deleted.length === 0) refuseForbidden();
    await audit(db, "calendar_shift.delete", `${weekday} ${start}`, { before, after: null });
    return OK;
  });
}

const dayMessage = "Vælg en gyldig dato.";

const dayField = z
  .string({ error: dayMessage })
  .regex(/^\d{4}-\d{2}-\d{2}$/, dayMessage)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, dayMessage)
  .refine((value) => value >= "2020-01-01" && value <= "2100-12-31", "Datoen skal ligge mellem 2020 og 2100.");

export const closedDaySchema = z.object({
  day: dayField,
  name: optionalText(80, "Navnet må højst være 80 tegn."),
  /** The date the closed day had when it was loaded. Missing: a new one. */
  originalDay: dayField.optional(),
});

async function findClosedDay(db: Db, day: string): Promise<ClosedDay | null> {
  const rows = await db.query<ClosedDay>(
    "select day, name from config.calendar_closed_days where day = $1::date",
    [day]
  );
  return rows[0] ? { day: String(rows[0].day), name: rows[0].name } : null;
}

/** Add a closed day, or change one (`originalDay` given). */
export async function saveClosedDay(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = closedDaySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { day, name, originalDay } = parsed.data;

  return runWrite(claims, async (db) => {
    const before = originalDay ? await findClosedDay(db, originalDay) : null;
    if (originalDay && !before) {
      throw new Refused(fail("Lukkedagen findes ikke længere. Genindlæs siden."));
    }
    if (day !== originalDay && (await findClosedDay(db, day))) {
      const message = "Den dag er allerede en lukkedag.";
      throw new Refused(fail(message, { day: message }));
    }
    if (before) {
      const updated = await db.query(
        "update config.calendar_closed_days set day = $2::date, name = $3 where day = $1::date returning day",
        [before.day, day, name]
      );
      if (updated.length === 0) refuseForbidden();
      await audit(db, "closed_day.update", day, { before, after: { day, name } });
    } else {
      await db.query("insert into config.calendar_closed_days (day, name) values ($1::date, $2)", [
        day,
        name,
      ]);
      await audit(db, "closed_day.create", day, { after: { day, name } });
    }
    return OK;
  });
}

const removeClosedDaySchema = z.object({ day: dayField });

export async function removeClosedDay(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = removeClosedDaySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { day } = parsed.data;

  return runWrite(claims, async (db) => {
    const before = await findClosedDay(db, day);
    if (!before) return OK;
    const deleted = await db.query(
      "delete from config.calendar_closed_days where day = $1::date returning day",
      [day]
    );
    if (deleted.length === 0) refuseForbidden();
    await audit(db, "closed_day.delete", day, { before, after: null });
    return OK;
  });
}

/** Whether lead time counts only the time inside the shifts. */
export async function setDeductOffShift(claims: Claims, value: unknown): Promise<ActionResult> {
  const parsed = z.boolean({ error: "Vælg til eller fra." }).safeParse(value);
  if (!parsed.success) return invalid(parsed.error);

  return runWrite(claims, async (db) => {
    const before = (await readSettings(db, [DEDUCT_OFF_SHIFT_KEY])).get(DEDUCT_OFF_SHIFT_KEY)?.value;
    if (before === parsed.data) return OK;
    await writeSetting(db, DEDUCT_OFF_SHIFT_KEY, parsed.data, before);
    return OK;
  });
}
