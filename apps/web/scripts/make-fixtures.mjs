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

// ---------------------------------------------------------------------------
// fixtures/history.json: about 13 weeks of synthetic production for the
// portal's read model (lib/readmodel/fixture-history.ts reads it).
//
// Nothing here is dated. A scan is stored as (working day index, seconds
// after local midnight); the loader lays the working days on the real
// calendar so the last one is today (or the last weekday before it), Monday
// to Friday, 06:00 to 14:00 Copenhagen time. Order information is stored as
// the few facts a 3E production list holds (customer, delivery week as a
// working day index, positions with quantity and opening functions); the
// loader shapes it like the parser's output. Every name and address is made
// up. It has its own random sequence, so scans.json above never changes.
//
// What it holds on purpose: finished and unfinished orders, late and on-time
// ones, rework, missing scan-outs, an Out with no In, station standstills,
// elements left lying before a station, orders with no document, orders
// with a forgotten element, an element the document does not list.
// ---------------------------------------------------------------------------

{
  const H_DAYS = 65; // 13 weeks of five working days
  const DAY = 86_400_000;
  const SHIFT_START = 6 * 3_600_000;
  const SHIFT_END = 14 * 3_600_000;
  const MIN = 60_000;
  // Minutes between two elements entering the line. Sets the volume:
  // 480 / 11.5 is about 42 elements, or 500 scans, a working day.
  const PACE_MIN = 11.5;

  const H_STATIONS = [
    { no: 1, name: "Station 10", kind: "Assembly", min: 5, max: 9 },
    { no: 2, name: "Station 20", kind: "Assembly", min: 7, max: 11 },
    { no: 3, name: "Station 30", kind: "Assembly", min: 5, max: 9 },
    { no: 4, name: "Station 40", kind: "Assembly", min: 4, max: 8 },
    { no: 5, name: "Montagebord 1", kind: "Assembly", min: 14, max: 22 },
    { no: 6, name: "Montagebord 2", kind: "Assembly", min: 14, max: 22 },
    { no: 7, name: "Pakning", kind: "Packing", min: 2, max: 4 },
  ];
  const byNo = new Map(H_STATIONS.map((s) => [s.no, s]));

  // Element types as lib/orderdoc classifies them from the opening functions.
  const TYPES = [
    { id: "vindue-1-fag", weight: 40, factor: 1.0, openings: [["Dreje/kip venstre"], ["Dreje/kip højre"], ["Fast karm"], ["Topstyret"]] },
    { id: "vindue-2-fag", weight: 22, factor: 1.1, openings: [["Dreje/kip venstre", "Fast karm"], ["Dreje venstre", "Dreje/kip højre"]] },
    { id: "vindue-3-fag", weight: 10, factor: 1.25, openings: [["Fast karm", "Dreje/kip højre", "Fast karm"], ["Dreje venstre", "Fast karm", "Fast karm", "Dreje højre"]] },
    { id: "doer", weight: 12, factor: 1.4, openings: [["Facadedør"], ["Fast karm", "Facadedør"], ["Industri dør"]] },
    { id: "terrassedoer", weight: 12, factor: 1.3, openings: [["Terrassedør"], ["Terrassedør", "Fast karm"]] },
    { id: "andet", weight: 4, factor: 0.8, openings: [[]] },
  ];
  const SYSTEMS = ["Profil 76 MD", "Profil 82 AD", "Profil 70 Classic"];
  const COMPANIES = [
    "Nordlys Byg A/S", "Tømrerfirmaet Egholm ApS", "Fjordens Vinduer A/S", "Bakkegårdens Entreprise ApS",
    "Lindevang Boligselskab", "Havblik Ejendomme A/S", "Murermester Kildemose ApS", "Solsiden Byggeservice",
    "Engdal Renovering ApS", "Skovbrynets Andelsbolig", "Vesterhede Typehuse A/S", "Klitgården Byg ApS",
    "Møllebakkens Tømrer og Snedker", "Åparkens Ejerforening", "Stenhøj Entreprise A/S", "Birkelunden Byg ApS",
  ];
  const STREETS = ["Eksempelvej", "Prøvegade", "Testvænget", "Modelstræde", "Skitsevej", "Kladdevej", "Udkastvej"];
  const TOWNS = ["0001 Prøveby", "0002 Eksempelstrup", "0003 Testrup", "0004 Modelby", "0005 Skitseborg"];
  const HANDLERS = ["AB", "CD", "EF", "GH"];

  let hseed = 0x13572468;
  const hrand = () => {
    hseed |= 0;
    hseed = (hseed + 0x6d2b79f5) | 0;
    let t = Math.imul(hseed ^ (hseed >>> 15), 1 | hseed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hbetween = (a, b) => a + hrand() * (b - a);
  const hint = (a, b) => Math.floor(hbetween(a, b + 1));
  const pick = (list) => list[Math.floor(hrand() * list.length)];
  const pickType = () => {
    let r = hrand() * TYPES.reduce((t, x) => t + x.weight, 0);
    for (const t of TYPES) if ((r -= t.weight) < 0) return t;
    return TYPES[0];
  };

  // Sim time: working day index * DAY + milliseconds after local midnight.
  // Work starts inside the shift; a piece begun just before the end runs over.
  const slot = (t) => {
    const d = Math.floor(t / DAY);
    const ms = t - d * DAY;
    if (ms < SHIFT_START) return d * DAY + SHIFT_START;
    if (ms >= SHIFT_END - 3 * MIN) return (d + 1) * DAY + SHIFT_START;
    return t;
  };

  // Per station: the reserved spans, sorted by start, never overlapping. A
  // station holds one element at a time, so a pass takes the first free gap
  // at or after `from`.
  const busy = new Map(H_STATIONS.map((s) => [s.no, []]));
  const findGap = (stationNo, from, ms) => {
    const list = busy.get(stationNo);
    let t = slot(from);
    for (;;) {
      let i = list.length - 1;
      while (i >= 0 && list[i][0] >= t + ms) i--;
      if (i < 0 || list[i][1] <= t) return { t, at: i + 1 };
      t = slot(list[i][1] + 0.5 * MIN);
    }
  };
  const reserve = (stationNo, from, ms) => {
    const { t, at } = findGap(stationNo, from, ms);
    busy.get(stationNo).splice(at, 0, [t, t + ms]);
    return t;
  };

  // Standstills: on some days one station is out for a while (reserved, no scans).
  for (let d = 0; d < H_DAYS + 6; d++) {
    if (hrand() < 0.18) {
      const station = hint(1, 6);
      const at = d * DAY + hbetween(7, 12) * 3_600_000;
      busy.get(station).push([at, at + hbetween(25, 75) * MIN]);
    }
  }
  // The last working day always has one, so "Stod stille" shows today.
  busy.set(3, busy.get(3).filter((b) => Math.floor(b[0] / DAY) !== H_DAYS - 1));
  busy.get(3).push([(H_DAYS - 1) * DAY + 8.5 * 3_600_000, (H_DAYS - 1) * DAY + 9.4 * 3_600_000]);
  for (const list of busy.values()) list.sort((a, b) => a[0] - b[0]);

  const hOrders = [];
  const hElements = [];
  const hScans = [];

  let release = SHIFT_START;
  let orderNo = 61000;
  const makeOrder = () => {
    const index = hOrders.length;
    const company = pick(COMPANIES);
    const customer = [company, `${pick(STREETS)} ${hint(1, 120)}`, pick(TOWNS)];
    const order = {
      no: orderNo++,
      customer,
      address: hrand() < 0.5 ? customer.slice() : [company, `${pick(STREETS)} ${hint(1, 120)}`, pick(TOWNS)],
      handler: pick(HANDLERS),
      printBack: hint(1, 6),
      positions: [],
      noDocument: index % 27 === 13,
      forgotten: index === 60 || index === 300,
      extra: index === 120,
      packedAt: 0,
      startAt: Infinity,
    };

    const pieces = [];
    const positions = hint(1, 5);
    for (let n = 1; n <= positions; n++) {
      const type = pickType();
      const quantity = hrand() < 0.12 ? hint(4, 6) : hint(1, 3);
      const fields = pick(type.openings);
      const door = type.id.includes("doer");
      const width = door ? hint(88, 110) * 10 : hint(50, 90) * 10 * Math.max(1, fields.length);
      const height = door ? hint(205, 225) * 10 : hint(60, 150) * 10;
      order.positions.push({
        n,
        // A forgotten element: the list holds one more than was ever made.
        q: quantity + (order.forgotten && n === 1 ? 1 : 0),
        system: pick(SYSTEMS),
        w: width,
        h: height,
        kg: Math.round((width * height) / 28000),
        fields,
      });
      for (let piece = 1; piece <= quantity; piece++) pieces.push({ n, piece, type });
    }
    // One element the document does not list.
    if (order.extra) pieces.push({ n: 9, piece: 1, type: TYPES[0] });
    order.pieces = pieces;
    hOrders.push(order);
    return order;
  };

  // A few orders are on the line at a time, their elements mixed, so an order
  // takes from some hours to a couple of days.
  const active = Array.from({ length: 8 }, makeOrder);
  while (Math.floor(release / DAY) < H_DAYS) {
    const pickAt = Math.floor(hrand() * hrand() * active.length); // the oldest most often
    const order = active[pickAt];
    {
      const p = order.pieces.shift();
      if (order.pieces.length === 0) {
        active.splice(pickAt, 1);
        active.push(makeOrder());
      }
      const d0 = Math.floor(release / DAY);
      // The line gets a little faster over the 13 weeks, with slow and fast days.
      const dayFactor = 1.12 - 0.2 * (d0 / H_DAYS) + 0.08 * Math.sin(d0 * 2.4);
      const el = hElements.length;
      hElements.push(`0${order.no}${String(p.n).padStart(2, "0")}01${String(p.piece).padStart(2, "0")}`);

      const route = [1, 2, 3, 4];
      if (hrand() < 0.05) route.push(3); // back to Station 30 for rework
      route.push(0, 7); // 0: whichever assembly table is free first

      let ready = release;
      // Now and then an element is left lying before the assembly table.
      const heldDays = hrand() < 0.015 ? hint(1, 2) : 0;
      for (const step of route) {
        if (step === 0 && heldDays > 0) ready += heldDays * DAY;
        const base = byNo.get(step === 0 ? 5 : step);
        const ms = Math.round(hbetween(base.min, base.max) * p.type.factor * dayFactor * MIN);
        const from = ready + hbetween(0.3, 2) * MIN;
        const stationNo = step !== 0 ? step : findGap(5, from, ms).t <= findGap(6, from, ms).t ? 5 : 6;
        const start = Math.round(reserve(stationNo, from, ms));
        const end = start + ms;
        const roll = hrand();
        const packing = stationNo === 7;
        // A forgotten scan: no Out (the element moves on all the same), or no In.
        const dropOut = !packing && roll < 0.006;
        const dropIn = !dropOut && roll < 0.009;
        if (!dropIn) hScans.push({ el, stationNo, dir: 1, t: start, dur: -1 });
        if (!dropOut) hScans.push({ el, stationNo, dir: 0, t: end, dur: Math.round(ms / 1000) });
        if (step === 1) release = slot(start + PACE_MIN * dayFactor * hbetween(0.8, 1.2) * MIN);
        order.startAt = Math.min(order.startAt, start);
        if (packing) order.packedAt = Math.max(order.packedAt, end);
        ready = end;
      }
    }
  }

  // One fixed case on the last working day, so it is there whatever the dice
  // gave: a scan-out forgotten at Station 20 in the morning.
  const lastDayStart = (H_DAYS - 1) * DAY + SHIFT_START;
  const forgottenOut = hScans.find((s) => s.t >= lastDayStart + 20 * MIN && s.dir === 0 && s.stationNo === 2);
  if (forgottenOut) hScans.splice(hScans.indexOf(forgottenOut), 1);

  // The file ends with the last working day: later scans are dropped, which
  // leaves the newest orders in progress.
  const horizon = H_DAYS * DAY;
  const kept = hScans.filter((s) => s.t < horizon).sort((a, b) => a.t - b.t || b.dir - a.dir);
  for (const o of hOrders) {
    o.complete = o.pieces.length === 0 && o.packedAt > 0 && o.packedAt < horizon && !o.forgotten;
    const packDay = Math.floor(o.packedAt / DAY);
    if (o.complete) {
      // On time: the delivery week is the packing week or later. Late: the
      // delivery week ended at least a week before it was packed.
      const slow = packDay - Math.floor(o.startAt / DAY) >= 2;
      const late = hrand() < (slow ? 0.6 : 0.09);
      o.dueDay = late ? packDay - hint(5, 9) : packDay + hint(0, 8);
    } else {
      o.dueDay = H_DAYS - 1 + hint(-7, 10);
    }
  }

  const started = hOrders.filter((o) => o.startAt < horizon);
  const history = {
    version: 1,
    days: H_DAYS,
    stations: H_STATIONS.map((s) => ({ no: s.no, name: s.name, kind: s.kind, seconds: Math.round(((s.min + s.max) / 2) * 60) })),
    typeFactors: Object.fromEntries(TYPES.map((t) => [t.id, t.factor])),
    orders: started.map((o) => ({
      no: o.no,
      document: !o.noDocument,
      customer: o.customer,
      address: o.address,
      handler: o.handler,
      printBack: o.printBack,
      dueDay: o.dueDay,
      positions: o.positions,
    })),
    elements: hElements,
    // [element index, station number, 1 for In and 0 for Out, working day index,
    //  seconds after local midnight, DurationSec or -1]
    scans: kept.map((s) => [s.el, s.stationNo, s.dir, Math.floor(s.t / DAY), Math.round((s.t % DAY) / 1000), s.dur]),
  };

  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "history.json");
  const parts = [
    `"version":${history.version}`,
    `"days":${history.days}`,
    `"stations":${JSON.stringify(history.stations)}`,
    `"typeFactors":${JSON.stringify(history.typeFactors)}`,
    `"orders":[\n${history.orders.map((o) => JSON.stringify(o)).join(",\n")}\n]`,
    `"elements":${JSON.stringify(history.elements)}`,
    `"scans":[\n${history.scans.map((s) => JSON.stringify(s)).join(",")}\n]`,
  ];
  writeFileSync(file, `{${parts.join(",\n")}}\n`);
  const done = started.filter((o) => o.complete).length;
  console.log(
    `${history.scans.length} scans, ${history.orders.length} orders (${done} packed), ${history.days} working days -> ${file}`
  );
}
