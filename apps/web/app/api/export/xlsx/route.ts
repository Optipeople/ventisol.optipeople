// GET /api/export/xlsx?report=<query name>&<query parameters>
// Excel download of one report query. The work is in lib/export/handler.ts.

import { getPortalAccess } from "@/lib/auth";
import { handleExport } from "@/lib/export/handler";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleExport(request, "xlsx", { getAccess: getPortalAccess });
}
