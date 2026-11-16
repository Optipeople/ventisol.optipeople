// Fixture mode's production history: fixtures/history.json (written by
// scripts/make-fixtures.mjs) laid on the real calendar. About 13 weeks of
// synthetic scans ending today, and the 3E production lists of those orders
// as the parser would have read them. Every name in it is made up.
//
// The file holds no dates: a scan is (working day index, seconds after local
// midnight). Here the working days become the last 65 weekdays up to and
// including today (or the last weekday before a weekend), Copenhagen time,
// so the shifts of the default calendar (Monday to Friday, 06:00 to 14:00)
// fit on any day the dev server runs, on both sides of a clock change.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrderDocument, OrderPosition } from "@/lib/orderdoc/types";
import { PARSER_VERSION } from "@/lib/orderdoc/version";
import type { MasterDataRow } from "@/lib/scans";
import { addDays, dayKey, dayStart, isoWeek } from "@/lib/time";

interface HistoryFile {
  version: number;
  days: number;
  stations: { no: number; name: string; kind: string; seconds: number }[];
  typeFactors: Record<string, number>;
  orders: {
    no: number;
    document: boolean;
    customer: string[];
    address: string[];
    handler: string;
    printBack: number;
    dueDay: number;
    positions: { n: number; q: number; system: string; w: number; h: number; kg: number; fields: string[] }[];
  }[];
  elements: string[];
  /** [element index, station number, 1 In or 0 Out, working day index, seconds after local midnight, DurationSec or -1] */
  scans: [number, number, number, number, number, number][];
}

export interface FixtureStation {
  stationNo: number;
  name: string;
  /** "Assembly" or "Packing", as the scans carry it. */
  kind: string;
  /** The middle of the pass times the generator draws from, for a 1-fag window. */
  typicalSeconds: number;
}

export interface FixtureDocument {
  fileName: string;
  orderNo: number;
  /** yyyy-MM-dd. */
  printDate: string;
  parsed: OrderDocument;
}

export interface FixtureHistory {
  /** The day the history ends on: today, or the last weekday before it. */
  lastDay: string;
  /** The working days, oldest first. */
  days: string[];
  stations: FixtureStation[];
  /** How much longer a pass of each element type takes than a 1-fag window. */
  typeFactors: Record<string, number>;
  /** Every scan up to `now`, newest first, in the shape GetRowsPaged returns. */
  rows: MasterDataRow[];
  /** The production lists printed up to `now`. */
  documents: FixtureDocument[];
}

const isWeekday = (day: string) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};

/** `count` weekdays ending at `today` (or the last weekday before it), oldest first. */
export function fixtureWorkingDays(today: string, count: number): string[] {
  const days: string[] = [];
  for (let day = today; days.length < count; day = addDays(day, -1)) {
    if (isWeekday(day)) days.unshift(day);
  }
  return days;
}

/** The weekday `index` places from the first day of `days`, also before it and after its end. */
function workingDayAt(days: string[], index: number): string {
  if (index >= 0 && index < days.length) return days[index];
  let day = index < 0 ? days[0] : days[days.length - 1];
  let left = index < 0 ? -index : index - (days.length - 1);
  const step = index < 0 ? -1 : 1;
  while (left > 0) {
    day = addDays(day, step);
    if (isWeekday(day)) left--;
  }
  return day;
}

function position(p: HistoryFile["orders"][number]["positions"][number], pageIndex: number): OrderPosition {
  const size = `${p.w},0 * ${p.h},0`;
  return {
    label: String(p.n),
    number: p.n,
    subNumber: null,
    system: p.system,
    frameColour: "Hvid",
    sashColour: "Hvid",
    sealColour: "Sort",
    quantity: p.q,
    frameHoles: null,
    notes: [],
    fields: p.fields.map((opening, i) => ({
      number: String(i + 1),
      opening,
      frameSize: null,
      frameSizeMm: null,
      glassType: [],
      panes: [],
      seals: [],
    })),
    scale: "1:20",
    weightKg: p.kg,
    sizeWithoutCoupling: { width: p.w, height: p.h, text: size },
    cutting: [],
    fieldBars: [],
    hardware: [],
    accessories: [],
    pageIndex,
    pageCount: 1,
    drawing: null,
  };
}

let file: Promise<HistoryFile> | null = null;
let cached: { day: string; days: string[]; rows: MasterDataRow[]; times: number[]; documents: FixtureDocument[] } | null =
  null;

function readHistoryFile(): Promise<HistoryFile> {
  file ??= readFile(join(process.cwd(), "fixtures", "history.json"), "utf8").then(
    (text) => JSON.parse(text) as HistoryFile
  );
  file.catch(() => (file = null));
  return file;
}

/**
 * The fixture history as it stands at `now`: scans later than now are left
 * out, so today's last elements show as in progress.
 */
export async function loadFixtureHistory(now: number): Promise<FixtureHistory> {
  const history = await readHistoryFile();
  const today = dayKey(now);
  if (!cached || cached.day !== today) {
    const days = fixtureWorkingDays(today, history.days);
    const starts = days.map(dayStart);
    const stationByNo = new Map(history.stations.map((s) => [s.no, s]));

    const rows: MasterDataRow[] = [];
    const times: number[] = [];
    history.scans.forEach(([element, stationNo, isIn, day, second, duration], index) => {
      const barcode = history.elements[element];
      const station = stationByNo.get(stationNo);
      const time = starts[day] + second * 1000;
      const id = String(index + 1).padStart(6, "0");
      times.push(time);
      rows.push({
        id: `fx-row-${id}`,
        createdDate: new Date(time + 1500).toISOString(),
        values: {
          scanId: `fx-${id}`,
          barcode,
          orderNo: Number(barcode.slice(1, 6)),
          position: Number(barcode.slice(6, 8)),
          subPosition: Number(barcode.slice(8, 10)),
          piece: Number(barcode.slice(10, 12)),
          station: station?.name ?? `Station nr. ${stationNo}`,
          stationNo,
          stationKind: station?.kind ?? "Assembly",
          machineId: "",
          direction: isIn === 1 ? "In" : "Out",
          scanTime: new Date(time).toISOString(),
          durationSec: duration >= 0 ? duration : null,
          device: "VENTISOL-PC01",
        },
      });
    });

    // The first scan of each order: its list was printed some days before.
    const firstDay = new Map<number, number>();
    for (const [element, , , day] of history.scans) {
      const orderNo = Number(history.elements[element].slice(1, 6));
      if (!firstDay.has(orderNo)) firstDay.set(orderNo, day);
    }
    const documents: FixtureDocument[] = [];
    for (const order of history.orders) {
      if (!order.document) continue;
      const printDate = addDays(workingDayAt(days, firstDay.get(order.no) ?? 0), -order.printBack);
      const fileName = `${order.no}_${printDate.replaceAll("-", "")}.pdf`;
      documents.push({
        fileName,
        orderNo: order.no,
        printDate,
        parsed: {
          parserVersion: PARSER_VERSION,
          fileName,
          pageCount: order.positions.length,
          header: {
            orderNumber: order.no,
            customer: order.customer,
            deliveryAddress: order.address,
            deliveryWeek: isoWeek(workingDayAt(days, order.dueDay)),
            date: printDate,
            caseHandler: order.handler,
            packageInfo: null,
            glassDelivery: null,
            glassPallet: null,
          },
          positions: order.positions.map(position),
          problems: [],
        },
      });
    }
    cached = { day: today, days, rows, times, documents };
  }

  const { days, rows, times, documents } = cached;
  const upToNow = rows.filter((_, i) => times[i] <= now).reverse();
  return {
    lastDay: days[days.length - 1],
    days,
    stations: history.stations.map((s) => ({ stationNo: s.no, name: s.name, kind: s.kind, typicalSeconds: s.seconds })),
    typeFactors: history.typeFactors,
    rows: upToNow,
    documents: documents.filter((d) => dayStart(d.printDate) <= now),
  };
}
