// /api/ugeplan?uge=2026-48: the week's workbook. GET builds it from the 3E
// production lists the portal has; POST takes the plan the browser read from
// the 3E file (.MDB) and puts it on top. Kept out of app/ so it is tested (vitest collects
// lib/** only). Docs: docs/ugeplan.md.
//
// Order: 401 without a portal user, 403 without reports.view, 429 over the
// export rate limit, 413 for a body over MAX_BODY_BYTES, 400 for a body that
// is no week plan or no week, then the file and one audit row (export.weekplan).

import { withUser, type Claims, type Db } from "@/lib/db";
import { attachment, exportLimits } from "@/lib/export/handler";
import { formatInstant } from "@/lib/export/cells";
import { audit } from "@/lib/portal/audit";
import { can, type PortalRole } from "@/lib/portal/roles";
import { allowAttempt, clientIp, TOO_MANY_ATTEMPTS } from "@/lib/rate-limit";
import { weekPlanSchema, type WeekPlan } from "./types";
import { mergeWeekPlans, portalWeekPlan } from "./portal";
import { parseWeekParam } from "./week";
import { weekPlanFileName, weekPlanWorkbook, type ProductionStatus } from "./workbook";

/** A week is a few hundred orders at most; the plan of one is some 50 KB. */
export const MAX_BODY_BYTES = 2_000_000;

export interface WeekPlanDeps {
  getAccess: () => Promise<{ claims: Claims } | null>;
  now?: () => number;
  allow?: (ip: string, userId: string) => Promise<boolean>;
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** What the portal knows of each order, by order number. Orders it has not seen are left out. */
export async function productionStatus(db: Db, orderNos: number[]): Promise<Map<number, ProductionStatus>> {
  const map = new Map<number, ProductionStatus>();
  if (orderNos.length === 0) return map;
  const rows = await db.query<{
    order_no: number;
    status: "in_progress" | "packed";
    elements_expected: number | null;
    elements_packed: number | null;
    packed_local_day: string | null;
  }>(
    `select order_no, status, elements_expected, elements_packed, packed_local_day
       from core.orders where order_no = any($1::integer[])`,
    [orderNos]
  );
  for (const r of rows) {
    map.set(Number(r.order_no), {
      status: r.status,
      elementsExpected: r.elements_expected,
      elementsPacked: r.elements_packed,
      packedDay: r.packed_local_day,
    });
  }
  return map;
}

/**
 * The body as text, or null once it passes `max` bytes. Counts the bytes as
 * they arrive, so a request without content-length cannot fill the memory.
 */
async function readLimited(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleWeekPlan(request: Request, deps: WeekPlanDeps): Promise<Response> {
  const access = await deps.getAccess();
  if (!access) return text(401, "Du er ikke logget ind.");
  const { claims } = access;
  if (!can(claims.role as PortalRole, "reports.view")) return text(403, "Din rolle giver ikke adgang til ugeplanen.");

  const allow = deps.allow ?? ((ip, user) => allowAttempt(exportLimits, ip, user));
  if (!(await allow(clientIp(request.headers), claims.optiUserId))) {
    return text(429, TOO_MANY_ATTEMPTS, { "retry-after": "60" });
  }

  // GET: the production lists only. POST: the plan read from the 3E file goes on top.
  let mdb: WeekPlan | null = null;
  if (request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return text(413, "Ugeplanen er for stor.");
    const body = await readLimited(request, MAX_BODY_BYTES);
    if (body === null) return text(413, "Ugeplanen er for stor.");
    try {
      mdb = weekPlanSchema.parse(JSON.parse(body));
    } catch {
      return text(400, "3E-filen kunne ikke læses. Prøv at vælge den igen.");
    }
  }

  const param = new URL(request.url).searchParams.get("uge");
  const fromMdb = mdb?.year && mdb.week ? { year: mdb.year, week: mdb.week } : null;
  const week = param ? parseWeekParam(param) : fromMdb;
  if (!week) return text(400, "Vælg en uge, fx ?uge=2026-48.");
  // A file of another week would put that week's orders into this one.
  if (fromMdb && (fromMdb.year !== week.year || fromMdb.week !== week.week)) {
    return text(400, `3E-filen er for uge ${fromMdb.week} ${fromMdb.year}, ikke uge ${week.week} ${week.year}. Skift uge, eller vælg den rigtige fil.`);
  }

  const now = deps.now?.() ?? Date.now();
  const generated = `Dannet ${formatInstant(new Date(now).toISOString())}`;
  const result = await withUser(claims, async (db) => {
    const plan = mergeWeekPlans(await portalWeekPlan(db, week.year, week.week), mdb);
    const fileName = weekPlanFileName(plan);
    const status = await productionStatus(db, plan.orders.map((o) => o.orderNo));
    const buffer = await weekPlanWorkbook({ plan, status, generated });
    await audit(db, "export.weekplan", fileName, {
      week: week.week,
      year: week.year,
      mdb: mdb?.fileName ?? (mdb ? "3E-fil" : null),
      orders: plan.orders.length,
    });
    return { buffer, fileName };
  });

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": attachment(result.fileName),
      "content-length": String(result.buffer.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
