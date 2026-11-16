// From a URL to a file: read the query parameters, run the report query
// (every page of a paged one, at most EXPORT_ROW_CAP rows), and build the
// Excel or PDF file with a Danish file name. No auth here: the route handler
// checks who asks (lib/export/handler.ts), and runReportQuery checks the
// capability again.

import { z } from "zod";
import type { Claims } from "@/lib/db";
import { REPORT_QUERIES, runReportQuery, type ReportQueryName } from "@/lib/reports";
import { monthTitle } from "@/lib/reports/format";
import { dayKey, formatDisplayDay, isIsoDay } from "@/lib/time";
import { formatInstant } from "./cells";
import { REPORT_EXPORTS } from "./columns";
import { toPdf } from "./pdf";
import { toXlsx } from "./xlsx";

/** Most rows in one file. A paged query stops here and the file says so. */
export const EXPORT_ROW_CAP = 10_000;

/** Page size while looping a paged query (the largest the schemas allow). */
const PAGE_SIZE = 200;

export type ExportKind = "xlsx" | "pdf";

export const EXPORT_CONTENT_TYPES: Record<ExportKind, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

type Shape = Record<string, z.ZodType>;

/** The object shape behind a query schema (a refined object stays a ZodObject in zod 4). */
function shapeOf(schema: z.ZodType): Shape {
  return schema instanceof z.ZodObject ? (schema.shape as Shape) : {};
}

/** The base type of a field, under optional, default and nullable. */
function baseType(schema: z.ZodType): string {
  let s = schema as unknown as { _zod?: { def?: { type?: string; innerType?: unknown } } };
  for (let i = 0; i < 10; i++) {
    const def = s._zod?.def;
    if (!def) return "unknown";
    if (["optional", "default", "prefault", "nullable", "readonly", "catch"].includes(def.type ?? "") && def.innerType) {
      s = def.innerType as typeof s;
      continue;
    }
    return def.type ?? "unknown";
  }
  return "unknown";
}

/**
 * The query input from URL parameters: only the keys the schema knows, number
 * fields as numbers (a value that is not a number is passed on as text, so the
 * schema refuses it), booleans from "true"/"1". A schema with `now` gets the
 * request time unless the URL sets it. Paging keys are left out: the export
 * runner pages itself.
 */
export function exportInput(report: ReportQueryName, params: URLSearchParams | Record<string, string | undefined>, now: number): Record<string, unknown> {
  const get = (key: string): string | undefined =>
    params instanceof URLSearchParams ? (params.get(key) ?? undefined) : params[key];
  const shape = shapeOf(REPORT_QUERIES[report].schema);
  const input: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    if (REPORT_EXPORTS[report].paged && (key === "page" || key === "pageSize")) continue;
    const raw = get(key)?.trim();
    if (raw === undefined || raw === "") continue;
    const type = baseType(field);
    if (type === "number") {
      const n = Number(raw);
      input[key] = Number.isFinite(n) ? n : raw;
    } else if (type === "boolean") {
      input[key] = raw === "true" || raw === "1" ? true : raw === "false" || raw === "0" ? false : raw;
    } else {
      input[key] = raw;
    }
  }
  if ("now" in shape && input.now === undefined) input.now = now;
  return input;
}

/** The rows of a query for the export, every page of a paged one, capped. */
export async function exportRows(
  claims: Claims,
  report: ReportQueryName,
  input: Record<string, unknown>
): Promise<{ rows: unknown[]; total: number; capped: boolean }> {
  const def = REPORT_EXPORTS[report];
  if (!def.paged) {
    const result = await runReportQuery(claims, report, input);
    const rows = result == null ? [] : def.rows(result);
    const capped = rows.length > EXPORT_ROW_CAP;
    return { rows: capped ? rows.slice(0, EXPORT_ROW_CAP) : rows, total: rows.length, capped };
  }
  const rows: unknown[] = [];
  let total = 0;
  for (let page = 1; rows.length < EXPORT_ROW_CAP; page++) {
    const result = (await runReportQuery(claims, report, { ...input, page, pageSize: PAGE_SIZE })) as { total: number };
    total = result.total;
    const batch = def.rows(result);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE || rows.length >= total) break;
  }
  const capped = total > EXPORT_ROW_CAP || rows.length > EXPORT_ROW_CAP;
  return { rows: rows.slice(0, EXPORT_ROW_CAP), total, capped };
}

/** "Periode: 01-10-2026 til 31-10-2026", "Dag: 21-10-2026", "Måned: oktober 2026", or null. */
export function periodText(input: Record<string, unknown>): string | null {
  const day = (v: unknown) => (typeof v === "string" && isIsoDay(v) ? formatDisplayDay(v) : null);
  const from = day(input.from);
  const to = day(input.to);
  if (from && to) return `Periode: ${from} til ${to}`;
  if (from) return `Periode: fra ${from}`;
  if (to) return `Periode: til ${to}`;
  const d = day(input.day);
  if (d) return `Dag: ${d}`;
  if (typeof input.month === "string" && /^\d{4}-\d{2}/.test(input.month)) return `Måned: ${monthTitle(input.month)}`;
  if (typeof input.orderNo === "number") return `Ordre ${input.orderNo}`;
  return null;
}

/** "afsluttede-ordrer-2026-11-16.xlsx": the Copenhagen day of `now`. */
export function exportFileName(report: ReportQueryName, kind: ExportKind, now: number): string {
  return `${REPORT_EXPORTS[report].file}-${dayKey(now)}.${kind}`;
}

export function cappedNote(total: number): string {
  return `Kun de første ${EXPORT_ROW_CAP.toLocaleString("da-DK")} af ${total.toLocaleString("da-DK")} rækker er med. Afgræns udtrækket for at få resten.`;
}

export interface ExportFile {
  body: Uint8Array;
  fileName: string;
  contentType: string;
  rows: number;
  capped: boolean;
}

/** Runs the query and builds the file. Throws ReportAccessError, ZodError or an unknown-query error. */
export async function buildExport(
  claims: Claims,
  report: ReportQueryName,
  kind: ExportKind,
  input: Record<string, unknown>,
  now: number
): Promise<ExportFile> {
  const def = REPORT_EXPORTS[report];
  const { rows, total, capped } = await exportRows(claims, report, input);
  const period = periodText(input);
  const generated = `Dannet ${formatInstant(new Date(now).toISOString())}`;
  const notes = capped ? [cappedNote(total)] : [];
  const body =
    kind === "xlsx"
      ? await toXlsx(def.sheet, def.columns, rows, { title: def.title, period, generated, notes })
      : await toPdf({ title: def.title, period, generated, notes, columns: def.columns, rows });
  return {
    body: body instanceof Uint8Array ? body : new Uint8Array(body),
    fileName: exportFileName(report, kind, now),
    contentType: EXPORT_CONTENT_TYPES[kind],
    rows: rows.length,
    capped,
  };
}
