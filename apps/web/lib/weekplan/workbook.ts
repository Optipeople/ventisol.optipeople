// The week plan as one Excel file: the office's three sheets (Kontor, BKS,
// Kim_Produktion) filled from the 3E database, plus the portal's production
// status and an "Om udtrækket" sheet. Docs: docs/ugeplan.md.
//
// Totals are Excel formulas, so a number corrected by hand in the sheet
// still adds up. Columns 3E does not hold (budget, capacity, HTM week,
// carrier, special elements) are left empty to be filled in as before.

import writeXlsxFile from "write-excel-file/node";
import type { Cell, CellObject, Row, SheetData } from "write-excel-file/node";
import { foilText, OFFICE_GROUPS, productionGroup, WELDS_PER_TYPE, type ProductionGroup } from "./classify";
import { ELEMENT_TYPES, type ElementType, type WeekPlan, type WeekPlanOrder } from "./types";

/** What the portal knows of an order's production. */
export interface ProductionStatus {
  status: "in_progress" | "packed";
  elementsExpected: number | null;
  elementsPacked: number | null;
  /** Copenhagen day the order was packed, "2026-11-20". */
  packedDay: string | null;
}

export interface WorkbookInput {
  plan: WeekPlan;
  status: Map<number, ProductionStatus>;
  /** "Dannet 18-11-2026 11:05". */
  generated: string;
}

const INPUT_FILL = "#FFF2CC";
const HEADER_FILL = "#D9E1F2";

const text = (value: string | null | undefined, extra: Partial<CellObject> = {}): Cell =>
  value ? { value, type: String, ...extra } : null;
const int = (value: number | null | undefined): Cell => (value ? { value, type: Number, format: "#,##0" } : null);
const dec = (value: number | null | undefined): Cell => (value ? { value, type: Number, format: "0.0" } : null);
const formula = (value: string, format = "#,##0", extra: Partial<CellObject> = {}): Cell => ({
  value,
  type: "Formula",
  format,
  ...extra,
});
const bold = (value: string): Cell => ({ value, type: String, fontWeight: "bold" });
const header = (value: string): Cell => ({
  value,
  type: String,
  fontWeight: "bold",
  backgroundColor: HEADER_FILL,
  wrap: true,
  alignVertical: "top",
});
const input = (): Cell => ({ value: "", type: String, backgroundColor: INPUT_FILL });

/** 0 to "A", 26 to "AA". */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function countOf(order: WeekPlanOrder, types: readonly ElementType[]): number {
  return order.types.filter((t) => types.includes(t.type)).reduce((n, t) => n + t.count, 0);
}

function countByGroup(order: WeekPlanOrder, group: ProductionGroup): number {
  return order.types.filter((t) => productionGroup(t) === group).reduce((n, t) => n + t.count, 0);
}

/** "20-11-2026". */
function displayDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

/** BKS "Prod.": what the portal saw of the order. */
export function productionText(status: ProductionStatus | undefined): string {
  if (!status) return "Ikke startet";
  if (status.status === "packed") return status.packedDay ? `Pakket ${displayDay(status.packedDay)}` : "Pakket";
  const packed = status.elementsPacked ?? 0;
  return status.elementsExpected ? `I gang, ${packed} af ${status.elementsExpected} pakket` : "I gang";
}

interface Column {
  header: string;
  width: number;
  value: (order: WeekPlanOrder) => Cell;
  /** Sum the column under the rows. */
  sum?: boolean;
}

function weekTitle(plan: WeekPlan): string {
  return plan.week ? `uge ${plan.week}${plan.year ? ` ${plan.year}` : ""}` : "ukendt uge";
}

// The Kontor columns, A to N, the first 14 of BKS too.
function officeColumns(): Column[] {
  return [
    { header: "Kunde", width: 30, value: (o) => text(o.customer) },
    { header: "Ordre", width: 8, value: (o) => ({ value: o.orderNo, type: Number }) },
    { header: "Ansv.", width: 6, value: (o) => text(o.responsible) },
    { header: "Beløb", width: 11, value: (o) => int(o.amount), sum: true },
    { header: "Bemærkning", width: 28, value: (o) => text(o.remark, { wrap: true }) },
    { header: "Folie", width: 16, value: (o) => text(foilText(o)) },
    { header: "HTM", width: 11, value: (o) => text(o.htm) },
    { header: "Antal D.døre", width: 8, value: (o) => int(countOf(o, OFFICE_GROUPS.doubleDoors)), sum: true },
    { header: "Antal døre", width: 8, value: (o) => int(countOf(o, OFFICE_GROUPS.doors)), sum: true },
    { header: "Antal D/K", width: 8, value: (o) => int(countOf(o, OFFICE_GROUPS.turnTilt)), sum: true },
    { header: "Antal Danline", width: 8, value: (o) => int(countOf(o, OFFICE_GROUPS.danline)), sum: true },
    { header: "Antal sv", width: 8, value: (o) => int(countOf(o, OFFICE_GROUPS.sv)), sum: true },
    { header: "Spec. elementer, timer", width: 10, value: () => null, sum: true },
    { header: "Timer", width: 8, value: (o) => dec(o.hours), sum: true },
  ];
}

const FIRST_DATA_ROW = 9; // 1-based: title, info, summary block, blank, header on row 8.

/**
 * The summary block above Kontor and BKS (rows 3 to 6): budget, turnover,
 * hours, and capacity against what is planned for the five count columns.
 */
function summaryRows(lastRow: number): Row[] {
  const range = (col: string) => `${col}${FIRST_DATA_ROW}:${col}${Math.max(lastRow, FIRST_DATA_ROW)}`;
  const capacity = ["H", "I", "J", "K", "L"];
  const row = (label: string, d: Cell, g: string, h: (c: string) => Cell): Row => [
    bold(label),
    null,
    null,
    d,
    null,
    null,
    text(g, { fontWeight: "bold" }),
    ...capacity.map(h),
  ];
  return [
    row("Budget omsætning", input(), "", () => null),
    row("Omsætning i kr.", formula(`SUM(${range("D")})`), "Kapacitet", () => input()),
    row("Tidsforbrug i timer", formula(`SUM(${range("N")})+D6`, "0.0"), "Ledig", (c) => formula(`${c}4-${c}6`)),
    row("Spec. elementer, timer", formula(`SUM(${range("M")})`, "0.0"), "Planlagt", (c) => formula(`SUM(${range(c)})`)),
  ];
}

function totalsRow(columns: Column[], firstRow: number, lastRow: number, label = "I alt"): Row {
  return columns.map((c, i) => {
    if (i === 0) return bold(label);
    if (!c.sum || lastRow < firstRow) return null;
    const col = columnLetter(i);
    return formula(`SUM(${col}${firstRow}:${col}${lastRow})`, c.header === "Timer" ? "0.0" : "#,##0", { fontWeight: "bold" });
  });
}

function officeSheet(plan: WeekPlan): { data: SheetData; widths: number[] } {
  const columns = officeColumns();
  const lastRow = FIRST_DATA_ROW + plan.orders.length - 1;
  const data: SheetData = [
    [bold(`Kontor, ${weekTitle(plan)}`)],
    [],
    ...summaryRows(lastRow),
    [],
    columns.map((c) => header(c.header)),
    ...plan.orders.map((o) => columns.map((c) => c.value(o))),
    totalsRow(columns, FIRST_DATA_ROW, lastRow),
  ];
  return { data, widths: columns.map((c) => c.width) };
}

function bksSheet(plan: WeekPlan, status: Map<number, ProductionStatus>): { data: SheetData; widths: number[] } {
  const typeColumns: Column[] = ELEMENT_TYPES.map((type) => ({
    header: type,
    width: 6,
    value: (o) => int(countOf(o, [type])),
    sum: true,
  }));
  const manual = (header: string): Column => ({ header, width: 7, value: () => null, sum: true });
  const columns: Column[] = [
    ...officeColumns(),
    { header: "Batch nr.", width: 15, value: (o) => text(o.batches.join(", ")) },
    ...typeColumns,
    manual("Bue/Skrå/TAG"),
    manual("Poste"),
    manual("Sprosser"),
    manual("Kobling"),
    { header: "Elementer i alt", width: 8, value: (o) => int(o.elements), sum: true },
    { header: "Svejs i alt", width: 8, value: (o) => int(o.welds), sum: true },
    { header: "Prod.", width: 22, value: (o) => text(productionText(status.get(o.orderNo))) },
    { header: "Afsendt", width: 10, value: () => null },
  ];
  const lastRow = FIRST_DATA_ROW + plan.orders.length - 1;
  const at = (h: string) => columnLetter(columns.findIndex((c) => c.header === h));
  const top = summaryRows(lastRow);
  // Bente's corner: welds and elements of the week, top right.
  const corner = columns.findIndex((c) => c.header === "T41");
  const put = (row: Row, label: string, value: Cell) => {
    while (row.length < corner + 3) row.push(null);
    row[corner] = bold(label);
    row[corner + 2] = value;
  };
  put(top[0], "Svejsninger", formula(`SUM(${at("Svejs i alt")}${FIRST_DATA_ROW}:${at("Svejs i alt")}${Math.max(lastRow, FIRST_DATA_ROW)})`));
  put(top[1], "Elementer", formula(`SUM(${at("Elementer i alt")}${FIRST_DATA_ROW}:${at("Elementer i alt")}${Math.max(lastRow, FIRST_DATA_ROW)})`));

  const totals = totalsRow(columns, FIRST_DATA_ROW, lastRow, "Elementer i alt");
  const totalsRowNo = lastRow + 1;
  const weldsPer: Row = columns.map((c, i) =>
    i === 0 ? bold("Antal svejsninger pr. element") : c.header in WELDS_PER_TYPE ? int(WELDS_PER_TYPE[c.header as ElementType]) : null
  );
  const weldsPerRowNo = totalsRowNo + 2;
  const welds: Row = columns.map((c, i) => {
    if (i === 0) return bold("Svejsninger pr. type (ca.)");
    if (!(c.header in WELDS_PER_TYPE)) return null;
    const col = columnLetter(i);
    return formula(`${col}${totalsRowNo}*${col}${weldsPerRowNo}`, "#,##0", { fontWeight: "bold" });
  });

  const data: SheetData = [
    [bold(`BKS, ${weekTitle(plan)}`)],
    [],
    ...top,
    [],
    columns.map((c) => header(c.header)),
    ...plan.orders.map((o) => columns.map((c) => c.value(o))),
    totals,
    welds,
    weldsPer,
  ];
  return { data, widths: columns.map((c) => c.width) };
}

function productionSheet(plan: WeekPlan, status: Map<number, ProductionStatus>): { data: SheetData; widths: number[] } {
  const group = (header: string, g: ProductionGroup): Column => ({
    header,
    width: 8,
    value: (o) => int(countByGroup(o, g)),
    sum: true,
  });
  const columns: Column[] = [
    { header: "Kunde", width: 30, value: (o) => text(o.customer) },
    { header: "Ordre nr.", width: 9, value: (o) => ({ value: o.orderNo, type: Number }) },
    { header: "Ans.", width: 6, value: (o) => text(o.responsible) },
    { header: "Afsendelse", width: 11, value: () => null },
    {
      header: "Klar til afsendt",
      width: 12,
      value: (o) => {
        const s = status.get(o.orderNo);
        if (s?.status !== "packed" || !s.packedDay) return null;
        const [y, m, d] = s.packedDay.split("-").map(Number);
        return { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: "dd-mm-yyyy" };
      },
    },
    { header: "Fragt", width: 20, value: (o) => text(o.freight) },
    { header: "Batch nr.", width: 15, value: (o) => text(o.batches.join("/")) },
    { header: "Folie", width: 8, value: (o) => text(o.foilApproved || o.foil === "folie" ? "x" : o.foil === "delvis" ? "delvis" : null) },
    group("SV - SJV", "sv"),
    group("St. døre", "stableDoors"),
    group("FD-døre", "facadeDoors"),
    group("Dr/ki - Fast", "turnTiltFixed"),
    group("Danline", "danline"),
    { header: "Spec.", width: 7, value: () => null, sum: true },
    { header: "Påklæ", width: 7, value: () => null },
    group("Scanvogn", "scan"),
    { header: "Total antal", width: 8, value: (o) => int(o.elements), sum: true },
    {
      header: "Info",
      width: 34,
      value: (o) => text([o.remark, o.looseParts ? `${o.looseParts} løse fyldninger` : null].filter(Boolean).join(". "), { wrap: true }),
    },
  ];
  const first = 3;
  const lastRow = first + plan.orders.length - 1;
  const data: SheetData = [
    [bold(`Ordreoversigt ${weekTitle(plan)}`)],
    columns.map((c) => header(c.header)),
    ...plan.orders.map((o) => columns.map((c) => c.value(o))),
    totalsRow(columns, first, lastRow),
  ];
  return { data, widths: columns.map((c) => c.width) };
}

/** What the file was made from, how, and what to check by hand. */
export function infoLines(plan: WeekPlan, status: Map<number, ProductionStatus>, generated: string): string[] {
  const bySource = (source: string) => plan.orders.filter((o) => (o.source ?? "3e") === source).map((o) => o.orderNo);
  const portalOnly = bySource("portal");
  const mdbOnly = bySource("3e");
  const lines = [
    `Ugeplan ${weekTitle(plan)}`,
    plan.fileName ? `Fra produktionslisterne i portalen og 3E-filen ${plan.fileName}` : "Fra produktionslisterne i portalen",
    generated,
    `${plan.orders.length} ordrer`,
    "",
    "Fra produktionslisterne: kunde, ordre, ansvarlig (initialer af sagsbehandlerens navn), elementtyper, elementer og",
    "svejsninger (en pr. karm og en pr. ramme), timer (portalens kalkulerede tid pr. elementtype), bemærkningerne på positionerne",
    "og folie: en todelt farve, ude/inde (\"Lightgrau/hvid\"), er folie. Folie når alle elementer er folierede, Delvis folie når nogle er.",
    "Fra 3E-filen, når den er trukket ind: beløb (ordresum ekskl. moms), batch nr. (serienumre), fragtlinjen, folie godkendt",
    "(frit felt 2 eller 3 = ja), HTM (artikler fra leverandøren HTM, og frit felt 4, Partas), bemærkning (frit felt 6), alle frie",
    "felter på arket Frie felter, 3E's egne timer og 3E's eksakte optælling (hver karm i koblede elementer for sig, Scan-typer).",
    "Står en ordre begge steder, gælder 3E-filen.",
    "Fra scanningerne: Prod. og Klar til afsendt.",
    "Udfyldes som før: budget, kapacitet (gule felter), spec. elementer, bue/skrå/tag, poste, sprosser, kobling,",
    "afsendelse, afsendt, påklædning og fragtmand.",
  ];
  if (!plan.fileName) lines.push("", "Uden 3E-filen er beløb, batch nr., folie godkendt, HTM og de frie felter tomme.");
  if (plan.orders.some((o) => o.hours === null)) {
    lines.push("", "Timer er tomme: der er ingen kalkulerede tider, eller din rolle må ikke se dem (kun planlægger, ledelse og admin).");
  }
  if (plan.fileName && portalOnly.length > 0) lines.push("", `Kun i produktionslisterne, ikke i 3E-filen: ${portalOnly.join(", ")}`);
  if (plan.fileName && mdbOnly.length > 0) lines.push("", `Kun i 3E-filen, ingen produktionsliste i portalen endnu: ${mdbOnly.join(", ")}`);
  const planned = plan.year && plan.week ? (plan.year - 2000) * 100 + plan.week : null;
  const otherWeek = plan.orders.filter((o) => o.week && planned && o.week !== planned);
  if (otherWeek.length > 0) {
    lines.push("", "Planlagt i en anden uge i 3E:");
    for (const o of otherWeek) lines.push(`  ${o.orderNo} ${o.customer}: uge ${o.week! % 100} ${2000 + Math.floor(o.week! / 100)}`);
  }
  const unknown = plan.orders.filter((o) => o.unknown.length > 0);
  if (unknown.length > 0) {
    lines.push("", "Positioner uden kendt elementtype (talt med i elementer i alt, ikke i typekolonnerne):");
    for (const o of unknown) for (const u of o.unknown) lines.push(`  ${o.orderNo}: ${u}`);
  }
  const unseen = plan.orders.filter((o) => !status.has(o.orderNo)).map((o) => o.orderNo);
  if (unseen.length > 0) lines.push("", `Ikke set i produktionen endnu: ${unseen.join(", ")}`);
  return lines;
}

export async function weekPlanWorkbook({ plan, status, generated }: WorkbookInput): Promise<Buffer> {
  const office = officeSheet(plan);
  const bks = bksSheet(plan, status);
  const production = productionSheet(plan, status);
  const info = infoLines(plan, status, generated).map((line, i): Row => [i === 0 ? bold(line) : text(line)]);
  const free = freeFieldsSheet(plan);

  return writeXlsxFile([
    { sheet: "Kontor", data: office.data, columns: office.widths.map((width) => ({ width })), stickyRowsCount: 8, stickyColumnsCount: 2 },
    { sheet: "BKS", data: bks.data, columns: bks.widths.map((width) => ({ width })), stickyRowsCount: 8, stickyColumnsCount: 2 },
    {
      sheet: "Kim_Produktion",
      data: production.data,
      columns: production.widths.map((width) => ({ width })),
      stickyRowsCount: 2,
      stickyColumnsCount: 2,
    },
    { sheet: "Frie felter", data: free.data, columns: free.widths.map((width) => ({ width })), stickyRowsCount: 2, stickyColumnsCount: 2 },
    { sheet: "Om udtrækket", data: info, columns: [{ width: 120 }] },
  ]).toBuffer();
}

/**
 * Every free field ("Frie felter") of the orders in the 3E file, one column
 * per field that holds something in the week. The file holds the values, not
 * the fields' names, so a column is named by its number.
 */
function freeFieldsSheet(plan: WeekPlan): { data: SheetData; widths: number[] } {
  const used = [...new Set(plan.orders.flatMap((o) => Object.keys(o.freeFields ?? {})))]
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  const columns: Column[] = [
    { header: "Kunde", width: 30, value: (o) => text(o.customer) },
    { header: "Ordre", width: 8, value: (o) => ({ value: o.orderNo, type: Number }) },
    ...used.map(
      (n): Column => ({ header: `Frit felt ${n}`, width: 18, value: (o) => text(o.freeFields?.[String(n)] ?? null, { wrap: true }) })
    ),
  ];
  const withFields = plan.orders.filter((o) => Object.keys(o.freeFields ?? {}).length > 0);
  const title = plan.fileName
    ? `Frie felter i 3E, ${weekTitle(plan)}`
    : `Frie felter i 3E, ${weekTitle(plan)}: træk 3E-filen ind på Ugeplan-siden for at få dem med`;
  return {
    data: [[bold(title)], columns.map((c) => header(c.header)), ...withFields.map((o) => columns.map((c) => c.value(o)))],
    widths: columns.map((c) => c.width),
  };
}

/** "ugeplan-uge-48-2026.xlsx". */
export function weekPlanFileName(plan: WeekPlan): string {
  return plan.week ? `ugeplan-uge-${plan.week}${plan.year ? `-${plan.year}` : ""}.xlsx` : "ugeplan.xlsx";
}
