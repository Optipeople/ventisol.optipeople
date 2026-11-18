// The week plan from what the portal already has: the 3E production lists of
// the delivery week (rpt.week_plan_documents), typed by their opening
// functions, with hours from the calculated times. The 3E database (.MDB) is
// optional on top: it adds what the lists do not print and replaces the
// counts with its exact ones (mergeWeekPlans). Docs: docs/ugeplan.md.

import { withUser, type Claims, type Db } from "@/lib/db";
import { classifyElementType, type ElementTypeRule } from "@/lib/orderdoc/element-types";
import type { OrderPosition } from "@/lib/orderdoc/types";
import { rulesFromConfig } from "@/lib/readmodel/orderinfo";
import { documentFrameType } from "./classify";
import type { TypeCount, WeekPlan, WeekPlanOrder } from "./types";

/** One production list as rpt.week_plan_documents returns it. */
export interface WeekPlanDocument {
  order_no: number;
  header: unknown;
  positions: unknown;
}

interface DocField {
  opening?: string | null;
  frameSize?: string | null;
}

interface DocPosition {
  number?: number;
  quantity?: number | null;
  system?: string | null;
  notes?: string[];
  fields?: DocField[];
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

/**
 * The office's initials from the case handler's name on the list: one letter
 * for the first name, one for each later name and each part of a hyphenated
 * one. "Flemming B. Vilhelmsen" is "fbv", "Mai-Britt Undall-Behrend" "mub".
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").split(/[\s.]+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length < 2) return (name ?? "").trim();
  const [first, ...rest] = words;
  const later = rest.flatMap((w) => w.split("-").filter((part) => /^\p{L}/u.test(part)));
  return [first, ...later].map((w) => w[0]).join("").toLowerCase();
}

/**
 * One order from its production list. `secondsByType` is the calculated time
 * of one element per element type (all stations), or null when the role may
 * not see calculated times: then the hours are left empty.
 */
export function orderFromDocument(
  doc: WeekPlanDocument,
  secondsByType: Map<string, number> | null,
  rules: readonly ElementTypeRule[],
  week: number | null
): WeekPlanOrder {
  const header = (doc.header && typeof doc.header === "object" ? doc.header : {}) as {
    customer?: unknown;
    caseHandler?: unknown;
  };
  const positions = (Array.isArray(doc.positions) ? doc.positions : []) as DocPosition[];

  const counts = new Map<string, TypeCount>();
  const unknown: string[] = [];
  const notes = new Set<string>();
  let elements = 0;
  let welds = 0;
  let seconds = 0;

  for (const p of positions) {
    if (!p || typeof p !== "object") continue;
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const quantity = Math.max(0, Math.round(Number(p.quantity) || 0));
    const system = typeof p.system === "string" ? p.system.trim() || null : null;
    for (const n of Array.isArray(p.notes) ? p.notes : []) if (typeof n === "string" && n.trim()) notes.add(n.trim());
    if (quantity === 0 || fields.length === 0) continue;

    elements += quantity;
    welds += quantity * (1 + fields.filter((f) => typeof f?.frameSize === "string" && f.frameSize.trim()).length);
    if (secondsByType) {
      const typeId = classifyElementType(
        { fields: fields.map((f) => ({ opening: f?.opening ?? null })) as unknown as OrderPosition["fields"] },
        rules
      );
      seconds += quantity * (secondsByType.get(typeId) ?? 0);
    }

    const ft = documentFrameType(fields, system);
    if (!ft) {
      unknown.push(cut(`Pos. ${p.number ?? "?"}: ${fields.map((f) => f?.opening ?? "").join(" / ") || "uden åbningsfunktion"}`, 200));
      continue;
    }
    const key = `${ft.type}|${ft.base}`;
    const entry = counts.get(key) ?? { type: ft.type, base: ft.base, count: 0 };
    entry.count += quantity;
    counts.set(key, entry);
  }

  const customerLines = Array.isArray(header.customer) ? header.customer : [];
  const handler = typeof header.caseHandler === "string" ? header.caseHandler : null;
  const remark = [...notes].join(". ");
  return {
    orderNo: doc.order_no,
    customer: cut(typeof customerLines[0] === "string" ? customerLines[0].trim() : "", 200),
    responsible: cut(initialsOf(handler), 100),
    amount: null,
    remark: remark ? cut(remark, 2000) : null,
    foilApproved: false,
    htm: null,
    hours: secondsByType ? Math.round((seconds / 3600) * 10) / 10 : null,
    batches: [],
    freight: null,
    types: [...counts.values()],
    elements,
    welds,
    week,
    unknown: [...new Set(unknown)].slice(0, 500),
    looseParts: 0,
    source: "portal",
  };
}

/** The production lists of week `week` of `year`, as a plan. */
export async function portalWeekPlan(db: Db, year: number, week: number): Promise<WeekPlan> {
  const docs = await db.query<WeekPlanDocument>(
    "select order_no, header, positions from rpt.week_plan_documents($1::integer, $2::integer)",
    [year, week]
  );
  const typeRows = await db.query<{ id: string; recognition: unknown; active: boolean }>(
    "select id, recognition, active from config.element_types order by sort_order, id"
  );
  // RLS shows the calculated times to admin, ledelse and planner only; for a viewer this is empty.
  const times = await db.query<{ element_type_id: string; seconds: number }>(
    "select element_type_id, sum(seconds) as seconds from config.calculated_times group by element_type_id"
  );
  const secondsByType = times.length > 0 ? new Map(times.map((t) => [t.element_type_id, Number(t.seconds)])) : null;
  const rules = rulesFromConfig(typeRows);
  const yyww = (year - 2000) * 100 + week;
  const orders = docs.map((d) => orderFromDocument(d, secondsByType, rules, yyww)).sort((a, b) => a.orderNo - b.orderNo);
  return { year, week, fileName: null, orders };
}

/** portalWeekPlan as the signed-in user, for the page's preview. */
export function loadPortalWeekPlan(claims: Claims, year: number, week: number): Promise<WeekPlan> {
  return withUser(claims, (db) => portalWeekPlan(db, year, week));
}

/**
 * The portal's plan with the 3E database's on top. An order in both takes
 * everything 3E has (its counts are exact: frames of coupled elements, Scan
 * types, 3E's own hours) and keeps the portal's notes when 3E has no remark.
 * Orders only one of them has are kept as they are.
 */
export function mergeWeekPlans(portal: WeekPlan, mdb: WeekPlan | null): WeekPlan {
  if (!mdb) return portal;
  const fromMdb = new Map(mdb.orders.map((o) => [o.orderNo, o]));
  const orders: WeekPlanOrder[] = [];
  for (const p of portal.orders) {
    const m = fromMdb.get(p.orderNo);
    if (!m) {
      orders.push(p);
      continue;
    }
    fromMdb.delete(p.orderNo);
    orders.push({ ...m, remark: m.remark ?? p.remark, customer: m.customer || p.customer, source: "begge" });
  }
  for (const m of fromMdb.values()) orders.push({ ...m, source: "3e" });
  orders.sort((a, b) => a.orderNo - b.orderNo);
  return { year: portal.year, week: portal.week, fileName: mdb.fileName, orders };
}
