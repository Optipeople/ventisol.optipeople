// What every settings write returns, and the one way a write runs.
//
// The data layer in lib/settings has no capability checks of its own: every
// read and write goes through withUser, so row level security is what decides
// (docs/portal-architecture.md section 3). runWrite turns the database's "no"
// into a Danish message instead of an exception. The friendly first line (the
// capability check) lives in the page and in the server action.

import { z } from "zod";
import { withUser, type Claims, type Db } from "@/lib/db";

export type ActionOk = {
  ok: true;
  /** Danish, shown instead of the form's own "Gemt." when the action has more to say. */
  message?: string;
};
export type ActionFail = {
  ok: false;
  /** Danish, shown to the user as it is. */
  error: string;
  /** Danish message per field, keyed by the field's name in the form. */
  fieldErrors?: Record<string, string>;
};
export type ActionResult = ActionOk | ActionFail;

export const OK: ActionOk = { ok: true };

export const FORBIDDEN_MESSAGE = "Du har ikke rettigheder til at ændre dette.";
export const INVALID_MESSAGE = "Ret de markerede felter og prøv igen.";

export function fail(error: string, fieldErrors?: Record<string, string>): ActionFail {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}

/** A zod error as a result: the first message of each field, keyed by its path. */
export function invalid(error: z.ZodError): ActionFail {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "form";
    fieldErrors[key] ??= issue.message;
  }
  const onlyForm = Object.keys(fieldErrors).length === 1 && fieldErrors.form;
  return fail(onlyForm ? fieldErrors.form : INVALID_MESSAGE, fieldErrors);
}

/**
 * Thrown inside runWrite to stop the write: the transaction is rolled back
 * (nothing written, nothing audited) and `result` is returned to the caller.
 */
export class Refused extends Error {
  constructor(readonly result: ActionFail) {
    super(result.error);
    this.name = "Refused";
  }
}

/** Throws Refused with FORBIDDEN_MESSAGE. For a write that row level security filtered away. */
export function refuseForbidden(): never {
  throw new Refused(fail(FORBIDDEN_MESSAGE));
}

// insufficient_privilege: a missing grant, or an insert or update that fails
// the WITH CHECK of a policy.
const PG_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * One write transaction as the user in `claims`. Returns what `fn` returns;
 * a Refused thrown by `fn`, or a refusal by the database, comes back as a
 * failed result. Anything else (the database is down, a bug) is thrown.
 */
export async function runWrite(
  claims: Claims,
  fn: (db: Db) => Promise<ActionResult>
): Promise<ActionResult> {
  try {
    return await withUser(claims, fn);
  } catch (error) {
    if (error instanceof Refused) return error.result;
    if ((error as { code?: string } | null)?.code === PG_INSUFFICIENT_PRIVILEGE) {
      return fail(FORBIDDEN_MESSAGE);
    }
    throw error;
  }
}

// --- zod helpers for values that arrive from a form as text ---

function toInt(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

function intSchema(min: number, max: number, message: string) {
  return z.number({ error: message }).int(message).min(min, message).max(max, message);
}

/** A whole number between min and max, given as a number or as text. */
export function intField(min: number, max: number, message: string) {
  return z.preprocess(toInt, intSchema(min, max, message));
}

/** The same, where an empty field means "not set" and comes out as null. */
export function optionalIntField(min: number, max: number, message: string) {
  return z.preprocess(
    (value) => (isEmpty(value) ? null : toInt(value)),
    intSchema(min, max, message).nullable()
  );
}

/** Trimmed text of at most `max` characters, where empty comes out as null. */
export function optionalText(max: number, message: string) {
  return z.preprocess(
    (value) => (isEmpty(value) ? null : typeof value === "string" ? value.trim() : value),
    z.string({ error: message }).max(max, message).nullable()
  );
}
