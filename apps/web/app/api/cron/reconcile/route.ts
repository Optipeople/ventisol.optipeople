// Vercel Cron, nightly at 02:30 UTC (vercel.json): the wide read that catches
// edits, late uploads and rows deleted in OptiCloud (lib/sync/reconcile.ts).
//
// Query, for a run by hand with the same secret:
//   ?days=90     how far back (default 45)
//   ?full=1      the whole list
//   ?restart=1   drop an unfinished pass and start anew
//
// maxDuration 300: 45 days are about 270 pages of 500 rows. The run gives
// itself 240 seconds (RECONCILE_BUDGET_MS) and 150 pages; what is left is
// continued by the minute sync, so nothing depends on one long invocation.

import { refuseUnlessCron } from "@/lib/sync/cron-auth";
import { runReconcile } from "@/lib/sync/run";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const refused = refuseUnlessCron(request);
  if (refused) return refused;
  const params = new URL(request.url).searchParams;
  const days = Number(params.get("days"));
  const result = await runReconcile({
    now: Date.now(),
    days: Number.isFinite(days) && days >= 1 ? days : undefined,
    full: params.get("full") === "1",
    restart: params.get("restart") === "1",
  });
  return Response.json(result, { status: result.status === "error" ? 500 : 200 });
}
