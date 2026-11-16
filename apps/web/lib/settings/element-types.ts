// config.element_types: the element types and how lib/orderdoc recognises
// each in a 3E production list.
//
// `recognition` holds one ElementTypeRule object per type (the rule's `type`
// is the row's id), or null for a type that is never chosen by a rule, such
// as the fallback "Andet". The rules are read in sort order, first match
// wins, so the sort order of the types is also the order of the rules.
//
// A type is never deleted here, only made inactive: deleting it would take
// its normal and calculated times with it (on delete cascade).

import { z } from "zod";
import { withUser, type Claims, type Db } from "@/lib/db";
import {
  DEFAULT_ELEMENT_TYPE_RULES,
  ELEMENT_TYPES,
  type ElementTypeRule,
} from "@/lib/orderdoc/element-types";
import { audit } from "@/lib/portal/audit";
import {
  fail,
  intField,
  invalid,
  OK,
  optionalIntField,
  Refused,
  refuseForbidden,
  runWrite,
  type ActionResult,
} from "./result";

export type ElementType = {
  id: string;
  name: string;
  /** Null: no rule, the type is never chosen automatically. */
  rule: ElementTypeRule | null;
  sortOrder: number;
  active: boolean;
};

type ElementTypeRow = {
  id: string;
  name: string;
  recognition: unknown;
  sort_order: number;
  active: boolean;
};

const COLUMNS = "id, name, recognition, sort_order, active";

const MAX_FIELDS = 20;

function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts : undefined;
}

function fieldCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** What is stored, read defensively: the column is jsonb and could hold anything. */
export function parseStoredRule(id: string, value: unknown): ElementTypeRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const rule: ElementTypeRule = { type: id };
  const any = textList(stored.anyOpeningContains);
  const none = textList(stored.noOpeningContains);
  const min = fieldCount(stored.minFields);
  const max = fieldCount(stored.maxFields);
  if (any) rule.anyOpeningContains = any;
  if (none) rule.noOpeningContains = none;
  if (min !== undefined) rule.minFields = min;
  if (max !== undefined) rule.maxFields = max;
  return Object.keys(rule).length > 1 ? rule : null;
}

const toElementType = (row: ElementTypeRow): ElementType => ({
  id: row.id,
  name: row.name,
  rule: parseStoredRule(row.id, row.recognition),
  sortOrder: row.sort_order,
  active: row.active,
});

// A list of texts, given as an array or as one text split on comma, semicolon
// or line break.
const textsField = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return [];
    const parts = typeof value === "string" ? value.split(/[,;\n]/) : value;
    if (!Array.isArray(parts)) return parts;
    return parts.map((p) => (typeof p === "string" ? p.trim() : p)).filter((p) => p !== "");
  },
  z
    .array(
      z.string({ error: "Skriv tekster adskilt af komma." }).max(60, "En tekst må højst være 60 tegn."),
      { error: "Skriv tekster adskilt af komma." }
    )
    .max(20, "Højst 20 tekster.")
);

const fieldsMessage = `Antal fag skal være et helt tal mellem 1 og ${MAX_FIELDS}.`;

export const elementTypeSchema = z
  .object({
    id: z
      .string({ error: "Skriv et id." })
      .trim()
      .min(1, "Skriv et id.")
      .max(40, "Id må højst være 40 tegn.")
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Id må kun indeholde små bogstaver (a til z), tal og bindestreg."),
    name: z
      .string({ error: "Skriv et navn." })
      .trim()
      .min(1, "Skriv et navn.")
      .max(80, "Navnet må højst være 80 tegn."),
    sortOrder: intField(0, 9999, "Rækkefølgen skal være et helt tal mellem 0 og 9999."),
    active: z.boolean({ error: "Vælg om typen er aktiv." }),
    anyOpeningContains: textsField,
    noOpeningContains: textsField,
    minFields: optionalIntField(1, MAX_FIELDS, fieldsMessage),
    maxFields: optionalIntField(1, MAX_FIELDS, fieldsMessage),
  })
  .superRefine((value, ctx) => {
    if (value.minFields !== null && value.maxFields !== null && value.minFields > value.maxFields) {
      ctx.addIssue({
        code: "custom",
        path: ["maxFields"],
        message: "Højeste antal fag skal være mindst det laveste antal.",
      });
    }
    const none = new Set(value.noOpeningContains.map((t) => t.toLowerCase()));
    if (value.anyOpeningContains.some((t) => none.has(t.toLowerCase()))) {
      ctx.addIssue({
        code: "custom",
        path: ["noOpeningContains"],
        message: "Den samme tekst kan ikke både kræves og udelukkes.",
      });
    }
  });

export type ElementTypeInput = z.infer<typeof elementTypeSchema>;

/** The rule a validated form describes, or null when it sets no condition. */
export function ruleFromInput(input: ElementTypeInput): ElementTypeRule | null {
  const rule: ElementTypeRule = { type: input.id };
  if (input.anyOpeningContains.length > 0) rule.anyOpeningContains = input.anyOpeningContains;
  if (input.noOpeningContains.length > 0) rule.noOpeningContains = input.noOpeningContains;
  if (input.minFields !== null) rule.minFields = input.minFields;
  if (input.maxFields !== null) rule.maxFields = input.maxFields;
  return Object.keys(rule).length > 1 ? rule : null;
}

/** For code that already has a transaction. */
export async function readElementTypes(db: Db): Promise<ElementType[]> {
  const rows = await db.query<ElementTypeRow>(
    `select ${COLUMNS} from config.element_types order by sort_order, id`
  );
  return rows.map(toElementType);
}

/** Every element type, inactive ones included, in rule order. */
export function listElementTypes(claims: Claims): Promise<ElementType[]> {
  return withUser(claims, readElementTypes);
}

/**
 * The rules lib/orderdoc classifies with: the rule of every active type, in
 * sort order. Empty when no type has a rule (callers then fall back to
 * DEFAULT_ELEMENT_TYPE_RULES themselves).
 */
export function activeElementTypeRules(types: ReadonlyArray<ElementType>): ElementTypeRule[] {
  return types.flatMap((t) => (t.active && t.rule ? [t.rule] : []));
}

async function findElementType(db: Db, id: string): Promise<ElementType | null> {
  const rows = await db.query<ElementTypeRow>(
    `select ${COLUMNS} from config.element_types where id = $1`,
    [id]
  );
  return rows[0] ? toElementType(rows[0]) : null;
}

const forAudit = (t: ElementType) => ({
  name: t.name,
  rule: t.rule,
  sortOrder: t.sortOrder,
  active: t.active,
});

function fromInput(input: ElementTypeInput): ElementType {
  return {
    id: input.id,
    name: input.name,
    rule: ruleFromInput(input),
    sortOrder: input.sortOrder,
    active: input.active,
  };
}

const ruleJson = (rule: ElementTypeRule | null) => (rule ? JSON.stringify(rule) : null);

/** Add an element type. The id cannot be changed later. */
export async function createElementType(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = elementTypeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const type = fromInput(parsed.data);

  return runWrite(claims, async (db) => {
    if (await findElementType(db, type.id)) {
      const message = `Elementtypen "${type.id}" findes allerede.`;
      throw new Refused(fail(message, { id: message }));
    }
    await db.query(
      `insert into config.element_types (${COLUMNS}) values ($1, $2, $3::jsonb, $4, $5)`,
      [type.id, type.name, ruleJson(type.rule), type.sortOrder, type.active]
    );
    await audit(db, "element_type.create", type.id, { after: forAudit(type) });
    return OK;
  });
}

/** Change an element type. `id` says which one. */
export async function updateElementType(claims: Claims, input: unknown): Promise<ActionResult> {
  const parsed = elementTypeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const type = fromInput(parsed.data);

  return runWrite(claims, async (db) => {
    const before = await findElementType(db, type.id);
    if (!before) throw new Refused(fail(`Elementtypen "${type.id}" findes ikke.`));
    const updated = await db.query(
      `update config.element_types
          set name = $2, recognition = $3::jsonb, sort_order = $4, active = $5
        where id = $1
        returning id`,
      [type.id, type.name, ruleJson(type.rule), type.sortOrder, type.active]
    );
    if (updated.length === 0) refuseForbidden();
    await audit(db, "element_type.update", type.id, {
      before: forAudit(before),
      after: forAudit(type),
    });
    return OK;
  });
}

/** The built-in types with their default rules, in rule order, "Andet" last. */
export function defaultElementTypes(): ElementType[] {
  const ruleOrder = DEFAULT_ELEMENT_TYPE_RULES.map((rule) => rule.type);
  const position = (id: string) => {
    const index = ruleOrder.indexOf(id);
    return index === -1 ? ruleOrder.length : index;
  };
  return [...ELEMENT_TYPES]
    .sort((a, b) => position(a.id) - position(b.id))
    .map((type, index) => {
      const rule = DEFAULT_ELEMENT_TYPE_RULES.find((r) => r.type === type.id);
      return {
        id: type.id,
        name: type.name,
        rule: rule ? { ...rule } : null,
        sortOrder: (index + 1) * 10,
        active: true,
      };
    });
}

/**
 * Put the built-in types back: name, rule, order and active as in
 * lib/orderdoc. Creates the ones that are missing (so it also fills an empty
 * table). Types the customer added themselves are left as they are.
 */
export async function restoreDefaultElementTypes(claims: Claims): Promise<ActionResult> {
  const defaults = defaultElementTypes();
  return runWrite(claims, async (db) => {
    const before = await readElementTypes(db);
    for (const type of defaults) {
      const written = await db.query(
        `insert into config.element_types (${COLUMNS}) values ($1, $2, $3::jsonb, $4, $5)
         on conflict (id) do update
           set name = excluded.name, recognition = excluded.recognition,
               sort_order = excluded.sort_order, active = excluded.active
         returning id`,
        [type.id, type.name, ruleJson(type.rule), type.sortOrder, type.active]
      );
      if (written.length === 0) refuseForbidden();
    }
    const defaultIds = new Set(defaults.map((t) => t.id));
    await audit(db, "element_type.restore_defaults", null, {
      before: before.filter((t) => defaultIds.has(t.id)).map((t) => ({ id: t.id, ...forAudit(t) })),
      after: defaults.map((t) => ({ id: t.id, ...forAudit(t) })),
      created: defaults.filter((t) => !before.some((b) => b.id === t.id)).map((t) => t.id),
    });
    return OK;
  });
}
