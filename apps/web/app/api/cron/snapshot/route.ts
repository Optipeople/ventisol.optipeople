// Vercel Cron, 02:15 UTC on the 1st (vercel.json): freezes the month that
// just ended into rpt.snapshots (docs/web-portal-plan.md 4.4).
//
// Idempotent: freezeMonth without force leaves a month that is frozen already
// alone, so a retry or a second call answers written: false and changes
// nothing. Copenhagen time decides which month ended, so a run on the 1st at
// any hour freezes the month before.

import { freezeMonth } from "@/lib/reports";
import { lastFullMonth } from "@/lib/management-view/month";
import { refuseUnlessCron } from "@/lib/sync/cron-auth";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const refused = refuseUnlessCron(request);
  if (refused) return refused;
  const now = Date.now();
  const month = lastFullMonth(now);
  try {
    const result = await freezeMonth(month, now);
    return Response.json(result);
  } catch (error) {
    console.error(`cron snapshot: freezing ${month} failed:`, error);
    return Response.json({ error: "freeze_failed", month }, { status: 500 });
  }
}
