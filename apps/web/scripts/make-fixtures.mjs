// Generates fixtures/scans.json: sample VentisolScans rows in the shape
// GetRowsPaged returns (docs/opticloud-scans.md), for the dev-only fixture
// mode (VENTISOL_FIXTURES=1). Deterministic, so re-running gives the same file.
//
//   node scripts/make-fixtures.mjs
//
// The rows are dated around REFERENCE_DAY. At runtime lib/fixtures.ts moves
// them so the reference day lands on today, and drops anything later than
// now, which leaves today's last elements in progress.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REFERENCE_DAY = "2026-10-21";
// Working days, oldest first, ending on the reference day.
const DAYS = ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"];
// October before the 25th is CEST, UTC+2. Shift 06:00 to 14:30 local.
const UTC_OFFSET_H = 2;
const SHIFT_START_H = 6;
const SHIFT_END_H = 14.5;

const STATIONS = [
  { no: 1, name: "Station 10", kind: "Assembly", min: 3, max: 6 },
  { no: 2, name: "Station 20", kind: "Assembly", min: 4, max: 7 },
  { no: 3, name: "Station 30", kind: "Assembly", min: 3, max: 6 },
  { no: 4, name: "Station 40", kind: "Assembly", min: 2, max: 5 },
  { no: 5, name: "Montagebord 1", kind: "Assembly", min: 7, max: 12 },
  { no: 6, name: "Montagebord 2", kind: "Assembly", min: 7, max: 12 },
  { no: 7, name: "Pakning", kind: "Packing", min: 1, max: 3 },
];

// mulberry32
let seed = 0x5eed1234;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + rand() * (b - a);
const int = (a, b) => Math.floor(between(a, b + 1));

const dayStartMs = (day, hours) => Date.parse(`${day}T00:00:00Z`) + (hours - UTC_OFFSET_H) * 3_600_000;

// Orders and their elements.
const elements = [];
for (let order = 58540; order < 58640; order++) {
  const positions = int(1, 5);
  for (let pos = 1; pos <= positions; pos++) {
    const subs = rand() < 0.25 ? int(2, 3) : 1;
    for (let sub = 1; sub <= subs; sub++) {
      const pieces = int(1, 3);
      for (let piece = 1; piece <= pieces; piece++) {
        const barcode = `0${order}${String(pos).padStart(2, "0")}${String(sub).padStart(2, "0")}${String(piece).padStart(2, "0")}`;
        elements.push({ order, pos, sub, piece, barcode });
      }
    }
  }
}

// Simulation: each station works one element at a time; an element moves
// along the line as soon as the next station is free. Work never crosses the
// end of a shift: it waits for the next working day instead.
const free = new Map(STATIONS.map((s) => [s.no, dayStartMs(DAYS[0], SHIFT_START_H)]));
const rows = [];
let seq = 0;

function nextWorkingStart(t) {
  for (const day of DAYS) {
    const start = dayStartMs(day, SHIFT_START_H);
    const end = dayStartMs(day, SHIFT_END_H);
    if (t < start) return { start, end };
    if (t < end) return { start: t, end };
  }
  return null;
}

function emit(el, station, direction, time, durationSec) {
  seq++;
  rows.push({
    id: `row-${String(seq).padStart(5, "0")}`,
    createdDate: new Date(time + 1500).toISOString(),
    values: {
      scanId: `fixture-${String(seq).padStart(5, "0")}`,
      barcode: el.barcode,
      orderNo: el.order,
      position: el.pos,
      subPosition: el.sub,
      piece: el.piece,
      station: station.name,
      stationNo: station.no,
      stationKind: station.kind,
      machineId: "",
      direction,
      scanTime: new Date(time).toISOString(),
      durationSec: durationSec ?? null,
      device: "VENTISOL-PC01",
    },
  });
}

let stopped = false;
for (const el of elements) {
  if (stopped) break;
  const route = [0, 1, 2, 3];
  // A few elements go back to Station 30 for rework after Station 40.
  if (rand() < 0.05) route.push(2);
  route.push(rand() < 0.5 ? 4 : 5, 6);

  let ready = 0;
  for (const idx of route) {
    const station = STATIONS[idx];
    const minutes = between(station.min, station.max);
    let t = Math.max(free.get(station.no), ready) + between(0.2, 2.5) * 60_000;
    let slot = nextWorkingStart(t);
    if (slot && slot.start + minutes * 60_000 > slot.end) slot = nextWorkingStart(slot.end);
    if (!slot) {
      stopped = true;
      break;
    }
    const start = slot.start;
    const end = start + minutes * 60_000;
    emit(el, station, "In", Math.round(start));
    emit(el, station, "Out", Math.round(end), Math.round((end - start) / 1000));
    free.set(station.no, end);
    ready = end;
  }
}

// One scan sent twice (same ScanId): the reports must count it once.
rows.push({ ...rows[10], id: "row-duplicate" });

// Newest first, as GetRowsPaged is asked for.
rows.sort((a, b) => Date.parse(b.values.scanTime) - Date.parse(a.values.scanTime));

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "scans.json");
mkdirSync(dirname(out), { recursive: true });
// One row per line: small, and still readable in a diff.
const body = rows.map((r) => JSON.stringify(r)).join(",\n");
writeFileSync(out, `{"referenceDay":"${REFERENCE_DAY}","rows":[\n${body}\n]}\n`);
console.log(`${rows.length} rows, ${new Set(rows.map((r) => r.values.orderNo)).size} orders -> ${out}`);
