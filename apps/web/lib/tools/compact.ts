// Report results as compact JSON for the model. The report types carry every
// duration on both clocks and a few large fields the model never needs; the
// model gets the headline figure, explicit units and capped lists, so a tool
// result stays a few kilobytes.

/** Longest list the model sees. The rest is counted, not sent. */
export const MAX_LIST = 40;

/** Fields the model never needs: storage references and per-gap detail. */
const DROP_KEYS = new Set(["blobReference", "blobName", "gaps", "intervalId", "parserVersion", "sha256"]);

function isDuration(value: unknown): value is { seconds: number | null } {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && "seconds" in value && "wallSeconds" in value && "workingSeconds" in value;
}

/**
 * A report value as compact JSON:
 * - a Duration `{ seconds, wallSeconds, workingSeconds }` under key `lead`
 *   becomes `leadSeconds: <headline seconds>` (null stays null: "no data yet"),
 * - lists longer than `maxList` are cut, with `<key>Omitted: n` beside them,
 * - floats are rounded to one decimal,
 * - storage references and gap lists are left out.
 */
export function compact(value: unknown, maxList = MAX_LIST): unknown {
  if (value == null) return null;
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  if (Array.isArray(value)) return value.slice(0, maxList).map((v) => compact(v, maxList));
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key)) continue;
    if (isDuration(v)) {
      out[`${key}Seconds`] = v.seconds == null ? null : Math.round(v.seconds);
      continue;
    }
    if (Array.isArray(v) && v.length > maxList) {
      out[key] = compact(v, maxList);
      out[`${key}Omitted`] = v.length - maxList;
      continue;
    }
    out[key] = compact(v, maxList);
  }
  return out;
}
