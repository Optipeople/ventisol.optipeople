// Pure constants and text helpers of the settings area: labels, the minutes
// format of the time grids, keys. No database import, so client components
// may import from here (from the other files in lib/settings they may only
// `import type`).

export const STATION_KINDS = ["assembly", "packing", "machine", "buffer"] as const;
export type StationKind = (typeof STATION_KINDS)[number];

export const STATION_KIND_LABELS: Readonly<Record<StationKind, string>> = {
  assembly: "Montage",
  packing: "Pakning",
  machine: "Maskine",
  buffer: "Buffer",
};

/** ISO weekdays: index 0 is Monday (weekday 1). */
export const WEEKDAY_LABELS: ReadonlyArray<string> = [
  "Mandag",
  "Tirsdag",
  "Onsdag",
  "Torsdag",
  "Fredag",
  "Lørdag",
  "Søndag",
];

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? `Dag ${weekday}`;
}

// The time grids show and take times in MINUTES WITH DECIMALS ("12,5" is
// twelve and a half minutes), Danish decimal comma, a point is accepted too.
// They are stored as whole seconds.

/** The longest time one piece can be given at one station: 24 hours. */
export const MAX_TIME_MINUTES = 1440;

export const TIME_FORMAT_HELP = "Minutter med decimaler, for eksempel 12,5.";

/**
 * Minutes as typed, to whole seconds. Null for an empty field (no time),
 * "invalid" for anything that is not a number from 0 to MAX_TIME_MINUTES with
 * at most two decimals.
 */
export function parseMinutes(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,4}([.,]\d{1,2})?$/.test(trimmed)) return "invalid";
  const minutes = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(minutes) || minutes > MAX_TIME_MINUTES) return "invalid";
  return Math.round(minutes * 60);
}

/** Whole seconds as the minutes text parseMinutes reads back to the same seconds. */
export function formatMinutes(seconds: number): string {
  const minutes = Math.round((seconds / 60) * 100) / 100;
  return String(minutes).replace(".", ",");
}

/** The key of one cell of a time grid, in forms and in fieldErrors. */
export function timeCellKey(stationNo: number, elementTypeId: string): string {
  return `${stationNo}:${elementTypeId}`;
}
