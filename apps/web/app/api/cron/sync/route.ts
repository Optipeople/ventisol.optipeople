// Vercel Cron, every minute (vercel.json): scans, then documents, then a
// chunk of an unfinished reconcile pass.
//
// maxDuration 60: the next run starts a minute later, so a longer one would
// only meet its own lease. The run gives itself 45 seconds (SYNC_BUDGET_MS)
// and saves where it stopped, which leaves room for a slow last request.

import { refuseUnlessCron } from "@/lib/sync/cron-auth";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const refused = refuseUnlessCron(request);
  if (refused) return refused;
  const result = await runSync({ now: Date.now() });
  return Response.json(result, { status: result.status === "error" ? 500 : 200 });
}
