// GET /api/ugeplan?uge=2026-48: the week's workbook from the production lists.
// POST, the same with the plan read from the 3E file (.MDB) as JSON on top. The work is in lib/weekplan/handler.ts.

import { getPortalAccess } from "@/lib/auth";
import { handleWeekPlan } from "@/lib/weekplan/handler";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleWeekPlan(request, { getAccess: getPortalAccess });
}

export async function POST(request: Request): Promise<Response> {
  return handleWeekPlan(request, { getAccess: getPortalAccess });
}
