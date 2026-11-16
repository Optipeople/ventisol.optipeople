// GET /api/export/pdf?report=<query name>&<query parameters>
// PDF download of one report page. The work is in lib/export/handler.ts.

import { getPortalAccess } from "@/lib/auth";
import { handleExport } from "@/lib/export/handler";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleExport(request, "pdf", { getAccess: getPortalAccess });
}
