// The Ordrer tab's state as it lives in the URL, and the links that change it.
// Pure: search params in, a typed view out, and hrefs back. The page hands the
// view to listFinishedOrders / listInProgressOrders in lib/reports.
//
// The names match Overblik and Stationer (lib/overview/filters.ts,
// lib/stations-view/params.ts), whose links carry `from`, `to`, `clock` and
// `status` here:
//
//   view     in-progress | finished. Left out: finished when the link carries
//            a period (from or to) and no in-progress-only status, else in-progress
//   q        free text: start of an order number, or part of customer or case
//   status   on_time | late | at_risk (in progress only) | unknown
//   from, to packed day range, yyyy-MM-dd (finished only)
//   clock    working | wall. Left out: the setting deduct_off_shift decides
//   active   all: every order not packed. Left out: scanned the last 14 days (in progress only)
//   sort     a sort key of the wrapper (order, customer, ...)
//   dir      asc | desc
//   page     from 1

import type { Clock, DeliveryStatusKey } from "@/lib/reports/types";
import { isIsoDay } from "@/lib/time";

export const ORDERS_PATH = "/ordrer";
export const PAGE_SIZE = 50;
/** In progress, by default: scanned within this many days. */
export const ACTIVE_DAYS = 14;

export type OrdersTab = "in-progress" | "finished";

export const FINISHED_SORTS = ["order", "customer", "elements", "start", "packed", "lead", "wait", "status"] as const;
export const IN_PROGRESS_SORTS = ["order", "customer", "elements", "start", "elapsed", "forecast", "due", "last_scan"] as const;
export type FinishedSort = (typeof FINISHED_SORTS)[number];
export type InProgressSort = (typeof IN_PROGRESS_SORTS)[number];

export type SortDir = "asc" | "desc";

export const FINISHED_STATUSES = ["on_time", "late", "unknown"] as const;
export const IN_PROGRESS_STATUSES = ["late", "at_risk", "on_time", "unknown"] as const;
export type FinishedStatus = (typeof FINISHED_STATUSES)[number];
export type InProgressStatus = (typeof IN_PROGRESS_STATUSES)[number];

/** The filter's labels. The same words as the wrappers' status labels. */
export const STATUS_LABELS: Record<OrdersTab, Partial<Record<DeliveryStatusKey, string>>> = {
  finished: { on_time: "Til tiden", late: "Forsinket", unknown: "Ingen leveringsuge" },
  "in-progress": { late: "Forsinket", at_risk: "Risiko for forsinkelse", on_time: "Til tiden", unknown: "Ukendt" },
};

/** As Overblik and Stationer word them. */
export const CLOCK_LABELS: Record<Clock, string> = { working: "Arbejdstid", wall: "Hele døgnet" };

interface Common {
  search: string;
  /** Undefined: the setting decides. */
  clock: Clock | undefined;
  dir: SortDir;
  page: number;
}

export interface FinishedView extends Common {
  tab: "finished";
  status: FinishedStatus | undefined;
  from: string | undefined;
  to: string | undefined;
  sort: FinishedSort;
}

export interface InProgressView extends Common {
  tab: "in-progress";
  status: InProgressStatus | undefined;
  /** False: every order not packed. True: scanned the last ACTIVE_DAYS days. */
  activeOnly: boolean;
  sort: InProgressSort;
}

export type OrdersView = FinishedView | InProgressView;

export type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "";

/** The default sort of each tab: what the wrapper sorts by when asked nothing. */
export const DEFAULT_SORT = { finished: "packed", "in-progress": "start" } as const;

function pickTab(params: SearchParams): OrdersTab {
  const view = one(params.view);
  if (view === "finished" || view === "in-progress") return view;
  if (one(params.status) === "at_risk") return "in-progress";
  return one(params.from) || one(params.to) ? "finished" : "in-progress";
}

/** Reads the URL. Anything unknown falls back to the default, never throws. */
export function parseOrdersView(params: SearchParams): OrdersView {
  const tab = pickTab(params);
  const search = one(params.q).trim().slice(0, 200);
  const clockParam = one(params.clock);
  const clock: Clock | undefined = clockParam === "working" || clockParam === "wall" ? clockParam : undefined;
  const dir: SortDir = one(params.dir) === "asc" ? "asc" : "desc";
  const rawPage = Number.parseInt(one(params.page), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, 100_000) : 1;
  const sort = one(params.sort);
  const status = one(params.status);
  const common = { search, clock, dir, page };

  if (tab === "finished") {
    let from = isIsoDay(one(params.from)) ? one(params.from) : undefined;
    let to = isIsoDay(one(params.to)) ? one(params.to) : undefined;
    if (from && to && from > to) [from, to] = [to, from];
    return {
      tab,
      ...common,
      status: FINISHED_STATUSES.find((s) => s === status),
      from,
      to,
      sort: (FINISHED_SORTS as readonly string[]).includes(sort) ? (sort as FinishedSort) : DEFAULT_SORT.finished,
    };
  }
  return {
    tab,
    ...common,
    status: IN_PROGRESS_STATUSES.find((s) => s === status),
    activeOnly: one(params.active) !== "all",
    sort: (IN_PROGRESS_SORTS as readonly string[]).includes(sort) ? (sort as InProgressSort) : DEFAULT_SORT["in-progress"],
  };
}

/** The view as URL params. The tab is always written, so a link never depends on the guess. */
export function viewParams(view: OrdersView): Record<string, string> {
  const out: Record<string, string> = { view: view.tab };
  if (view.search) out.q = view.search;
  if (view.status) out.status = view.status;
  if (view.tab === "finished") {
    if (view.from) out.from = view.from;
    if (view.to) out.to = view.to;
  } else if (!view.activeOnly) {
    out.active = "all";
  }
  if (view.clock) out.clock = view.clock;
  if (view.sort !== DEFAULT_SORT[view.tab]) out.sort = view.sort;
  if (view.dir !== "desc") out.dir = view.dir;
  if (view.page > 1) out.page = String(view.page);
  return out;
}

export function ordersHref(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
  return qs.size ? `${ORDERS_PATH}?${qs}` : ORDERS_PATH;
}

/** The view's URL. */
export function viewHref(view: OrdersView): string {
  return ordersHref(viewParams(view));
}

/**
 * The other tab. Keeps the search and the clock; filters and sort keys
 * differ per tab, so they are left behind.
 */
export function tabHref(view: OrdersView, tab: OrdersTab): string {
  return ordersHref({ view: tab, q: view.search || undefined, clock: view.clock });
}

/**
 * A column header's link. The active column flips; a new column starts
 * descending (largest, latest first), except names, numbers and deadlines,
 * which read naturally upwards. Always back to page 1.
 */
export function sortHref(view: OrdersView, key: FinishedSort | InProgressSort): string {
  const ascFirst = key === "order" || key === "customer" || key === "due" || key === "forecast";
  const dir: SortDir = key === view.sort ? (view.dir === "asc" ? "desc" : "asc") : ascFirst ? "asc" : "desc";
  return viewHref({ ...view, sort: key, dir, page: 1 } as OrdersView);
}

/** The params the filters, search and pager must carry along, without the page and the ones they set. */
export function preserveFor(view: OrdersView, ...drop: string[]): Record<string, string> {
  const p = viewParams({ ...view, page: 1 } as OrdersView);
  for (const key of drop) delete p[key];
  return p;
}

/** The order page of one order, carrying the clock the list was read with. */
export function orderHref(orderNo: number, clock?: Clock): string {
  return clock ? `/ordre/${orderNo}?clock=${clock}` : `/ordre/${orderNo}`;
}

// ---------------------------------------------------------------------------
// /periode, retired: its links land on the finished list
// ---------------------------------------------------------------------------

/** The old period report's sort keys, mapped to the finished list's. */
const PERIODE_SORTS: Record<string, FinishedSort> = {
  order: "order",
  elements: "elements",
  total: "lead",
  first: "start",
  last: "packed",
  status: "status",
};

/** Where an old /periode?fra=&til=&sort=&retning= link goes: the finished orders, same period and, where it exists, same sort. */
export function periodeRedirect(params: SearchParams): string {
  const fra = one(params.fra);
  const til = one(params.til);
  const sort = PERIODE_SORTS[one(params.sort)];
  const retning = one(params.retning);
  return ordersHref({
    view: "finished",
    from: isIsoDay(fra) ? fra : undefined,
    to: isIsoDay(til) ? til : undefined,
    sort: sort && sort !== DEFAULT_SORT.finished ? sort : undefined,
    dir: sort && retning === "asc" ? "asc" : undefined,
  });
}
