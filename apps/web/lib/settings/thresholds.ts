// The threshold values in config.settings: what counts as late, slow, a long
// dwell and a standstill, plus the two assumptions (Schirmer minutes per
// batch, buffer capacity). The keys and their meaning are those seeded in
// supabase/migrations/20261116100000_foundation.sql.

import { withUser, type Claims } from "@/lib/db";
import { fail, INVALID_MESSAGE, OK, runWrite, type ActionResult } from "./result";
import { readSettings, writeSetting } from "./store";

export type ThresholdDef = {
  key: string;
  label: string;
  unit: string;
  help: string;
  min: number;
  max: number;
};

export const THRESHOLDS: ReadonlyArray<ThresholdDef> = [
  {
    key: "late_threshold",
    label: "Forsinket ordre",
    unit: "dage",
    help: "Dage efter leveringsugens udløb, før en ordre tæller som forsinket. 0: pakket efter søndag i leveringsugen er forsinket.",
    min: 0,
    max: 60,
  },
  {
    key: "slow_threshold_percent",
    label: "Langsom station",
    unit: "%",
    help: "En station er langsom, når tiden pr. element er mere end så mange procent over normaltiden.",
    min: 1,
    max: 500,
  },
  {
    key: "long_dwell_threshold_minutes",
    label: "Lang liggetid",
    unit: "minutter",
    help: "Et element har lang liggetid, når det venter mere end så mange skiftminutter mellem to trin. 480 er et helt skift.",
    min: 1,
    max: 10080,
  },
  {
    key: "standstill_threshold_minutes",
    label: "Stilstand",
    unit: "minutter",
    help: "En station står stille, når den ikke har haft en scanning i så mange minutter inden for et skift.",
    min: 1,
    max: 480,
  },
  {
    key: "calculation_deviation_threshold_percent",
    label: "Afvigelse fra kalkule",
    unit: "%",
    help: "En elementtype markeres, når den målte tid afviger mere end så mange procent fra den kalkulerede tid.",
    min: 1,
    max: 500,
  },
  {
    key: "schirmer_assumed_minutes_per_batch",
    label: "Schirmer, antaget tid pr. batch",
    unit: "minutter",
    help: "Den tid et batch antages at bruge i Schirmer-maskinen, indtil maskinen selv leverer tider.",
    min: 1,
    max: 1440,
  },
  {
    key: "buffer_capacity",
    label: "Bufferens kapacitet",
    unit: "elementer",
    help: "Hvor mange elementer bufferen før montage kan rumme.",
    min: 1,
    max: 1000,
  },
];

export type ThresholdKey = string;

export type Threshold = ThresholdDef & {
  /** Null when the setting is missing or not a number. */
  value: number | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export function getThresholds(claims: Claims): Promise<Threshold[]> {
  return withUser(claims, async (db) => {
    const stored = await readSettings(
      db,
      THRESHOLDS.map((t) => t.key)
    );
    return THRESHOLDS.map((def) => {
      const row = stored.get(def.key);
      return {
        ...def,
        value: typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  });
}

/** A whole number inside the bounds of `def`, from text or a number. Null when it is not. */
export function parseThreshold(def: ThresholdDef, raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,6}$/.test(text)) return null;
  const value = Number(text);
  return value >= def.min && value <= def.max ? value : null;
}

/**
 * Save threshold values, given as { key: value }. Keys that are left out are
 * not touched, an unknown key is refused. Only values that change are
 * written, each audited as "setting.update" with before and after.
 */
export async function saveThresholds(claims: Claims, input: unknown): Promise<ActionResult> {
  return (await saveThresholdsChanged(claims, input)).result;
}

/**
 * saveThresholds, which also tells which keys were written. The server
 * action hands them to the read model once the write has committed.
 */
export async function saveThresholdsChanged(
  claims: Claims,
  input: unknown
): Promise<{ result: ActionResult; changed: string[] }> {
  const changed: string[] = [];
  const result = await saveChanged(claims, input, changed);
  return { result, changed: result.ok ? changed : [] };
}

async function saveChanged(claims: Claims, input: unknown, changed: string[]): Promise<ActionResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("Værdierne kunne ikke læses. Genindlæs siden og prøv igen.");
  }
  const given = input as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const wanted = new Map<string, number>();

  for (const key of Object.keys(given)) {
    const def = THRESHOLDS.find((t) => t.key === key);
    if (!def) return fail(`Ukendt indstilling: ${key}.`);
    const value = parseThreshold(def, given[key]);
    if (value === null) {
      fieldErrors[key] = `Skriv et helt tal fra ${def.min} til ${def.max}.`;
    } else {
      wanted.set(key, value);
    }
  }
  if (Object.keys(fieldErrors).length > 0) return fail(INVALID_MESSAGE, fieldErrors);

  return runWrite(claims, async (db) => {
    const stored = await readSettings(db, [...wanted.keys()]);
    for (const [key, value] of wanted) {
      const before = stored.get(key)?.value;
      if (before === value) continue;
      await writeSetting(db, key, value, before);
      changed.push(key);
    }
    return OK;
  });
}
