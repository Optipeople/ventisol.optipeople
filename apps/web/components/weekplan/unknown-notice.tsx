// The warning under a week plan: orders with positions the classifier could
// not place in an element type. Used by the page's preview of the portal's
// plan and by the 3E file's preview (weekplan-upload.tsx). No hooks, so both a
// server and a client component can render it.

import { Notice } from "@optipeople/ui/blocks";
import type { WeekPlanOrder } from "@/lib/weekplan/types";

/** How many orders with unplaced positions the warning lists by name. */
const MAX_WARNINGS = 20;

const countFormat = new Intl.NumberFormat("da-DK");

export function UnknownPositionsNotice({ orders }: { orders: readonly WeekPlanOrder[] }) {
  const withUnknown = orders.filter((o) => o.unknown.length > 0);
  if (withUnknown.length === 0) return null;

  return (
    <Notice tone="warning" icon>
      <p>
        {withUnknown.length === 1
          ? "1 ordre har positioner, der ikke kunne placeres i en elementtype:"
          : `${countFormat.format(withUnknown.length)} ordrer har positioner, der ikke kunne placeres i en elementtype:`}
      </p>
      <ul className="mt-2 list-disc pl-5">
        {withUnknown.slice(0, MAX_WARNINGS).map((o) => (
          <li key={o.orderNo}>
            Ordre {o.orderNo}
            {o.customer ? ` (${o.customer})` : ""}: {o.unknown.join("; ")}
          </li>
        ))}
      </ul>
      {withUnknown.length > MAX_WARNINGS && (
        <p className="mt-2">Og {countFormat.format(withUnknown.length - MAX_WARNINGS)} ordrer mere.</p>
      )}
    </Notice>
  );
}
