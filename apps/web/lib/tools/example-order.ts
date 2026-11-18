// The order the chat's first suggestion asks about ("Hvor er ordrenummer
// ...?"): the in-progress order scanned most recently, so a click gets a real
// answer. The deck's example number does not exist here.

import type { Claims } from "@/lib/db";
import { listInProgressOrders } from "@/lib/reports";

/** The most recently scanned order in progress, or null when there is none or it cannot be read. */
export async function exampleOrderNo(claims: Claims, now: number = Date.now()): Promise<number | null> {
  try {
    const page = await listInProgressOrders(claims, { now, sort: "last_scan", dir: "desc", page: 1, pageSize: 1 });
    return page.rows[0]?.orderNo ?? null;
  } catch (error) {
    // A suggestion is not worth a broken chat.
    console.error("chat: example order", error);
    return null;
  }
}
