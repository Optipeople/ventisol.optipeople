// Handing a queue to the read model writer without letting one bad order
// block the rest.
//
// The whole queue goes to the writer in one call. When that fails, every
// order is tried on its own. An order that fails again is set aside in the
// dead letters (app.sync_private, "deadletter:orders") and the others go on.
// When every order fails, the writer itself may be down (the database, a
// broken migration): an empty call tells. If that fails too, nothing is set
// aside and the error is thrown, so the caller keeps its queue for the next
// run.
//
// A dead letter is not retried by itself. A rebuild derives everything again
// and clears the list; an order that is handed over without error later is
// taken off it.

import { withService } from "@/lib/db";
import type { ApplyResult } from "@/lib/readmodel";
import { addDeadLetters, clearDeadLetters, errorText, type DeadLetter } from "./state";

export interface HandOverOptions<T> {
  source: DeadLetter["source"];
  items: T[];
  orderOf: (item: T) => number;
  /** The writer. Called with all items, then with one order's items, and with none as a probe. */
  apply: (items: T[]) => Promise<ApplyResult>;
  now: number;
}

const add = (a: ApplyResult, b: ApplyResult): ApplyResult => ({
  orders: a.orders + b.orders,
  stationDays: a.stationDays + b.stationDays,
});

/** Hands `items` to the writer. Throws only when the writer fails as a whole. */
export async function handOver<T>(options: HandOverOptions<T>): Promise<ApplyResult> {
  const { items, orderOf, apply, now, source } = options;
  const orderNos = [...new Set(items.map(orderOf))];
  try {
    const result = await apply(items);
    await withService((db) => clearDeadLetters(db, orderNos));
    return result;
  } catch (batchError) {
    const groups = new Map<number, T[]>();
    for (const item of items) {
      const orderNo = orderOf(item);
      groups.set(orderNo, [...(groups.get(orderNo) ?? []), item]);
    }

    let total: ApplyResult = { orders: 0, stationDays: 0 };
    const done: number[] = [];
    const failed: { orderNo: number; source: DeadLetter["source"]; error: string }[] = [];
    for (const [orderNo, list] of groups) {
      try {
        total = add(total, await apply(list));
        done.push(orderNo);
      } catch (error) {
        failed.push({ orderNo, source, error: errorText(error) });
      }
    }

    if (done.length === 0) {
      // Is it the orders, or the writer? The probe also refreshes what moves
      // with the clock, which is what an empty run is for anyway.
      try {
        total = add(total, await apply([]));
      } catch {
        throw batchError;
      }
    }

    await withService(async (db) => {
      await addDeadLetters(db, failed, now);
      await clearDeadLetters(db, done);
    });
    if (failed.length > 0) {
      console.error(
        `Read model: ${failed.length} order(s) set aside after failing on their own:`,
        failed.map((f) => `${f.orderNo} (${f.error})`).join(", ")
      );
    }
    return total;
  }
}
