// POST /api/ugeplan: the week plan read from the 3E file, as JSON, in; the
// Excel file out. The work is in lib/weekplan/handler.ts.

import { getPortalAccess } from "@/lib/auth";
import { handleWeekPlan } from "@/lib/weekplan/handler";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleWeekPlan(request, { getAccess: getPortalAccess });
}
