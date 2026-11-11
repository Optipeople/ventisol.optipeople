// What each page shows: reads the scans for its period (lib/opticloud.ts) and
// runs the pure computation (lib/report.ts) over them. Also what a page may be
// asked for: the days in the address bar are read and limited here.

import type { AuthContext } from "@/lib/auth";
import { CACHE_SECONDS, loadScansSince } from "@/lib/opticloud";
import {
  buildTimeline,
  computeKpis,
  intervalsEndingIn,
  ORDER_SORT_KEYS,
  type OrderSortKey,
  pairScans,
  scansIn,
  STALE_OPEN_MS,
  summarizeElements,
  summarizeOrders,
  summarizeStations,
} from "@/lib/report";
import { addDays, dayEnd, dayKey, dayStart, isIsoDay, startOfWeek } from "@/lib/time";

/**
 * How many days back the site reads, today included. One limit for the day
 * view (`dato`) and the period view (`fra`, `til`): GetRowsPaged has no date
 * filter, so every day further back is more pages to read before the day
 * asked for is even reached.
 */
export const MAX_LOOKBACK_DAYS = 62;

/** Longest period the period view reads in one go. */
export const MAX_PERIOD_DAYS = MAX_LOOKBACK_DAYS;

/** How far back the order page looks for an order's scans. */
export const ORDER_LOOKBACK_DAYS = 30;

/** The earliest day that can be shown. */
export function earliestDay(today: string): string {
  return addDays(today, -(MAX_LOOKBACK_DAYS - 1));
}

/** A day from the address bar, kept between the earliest day and today. */
function clampDay(value: string | undefined | null, today: string): { day: string; clamped: boolean } | null {
  if (!isIsoDay(value)) return null;
  const earliest = earliestDay(today);
  if (value > today) return { day: today, clamped: true };
  if (value < earliest) return { day: earliest, clamped: true };
  return { day: value, clamped: false };
}

export interface DayParams {
  day: string;
  /** `dato` was outside what can be shown and was moved. */
  clamped: boolean;
}

/** `?dato=` of the day view: today when missing or not a day. */
export function parseDayParam(dato: string | undefined | null, today: string): DayParams {
  return clampDay(dato, today) ?? { day: today, clamped: false };
}

export interface PeriodParams {
  from: string;
  to: string;
  sort: OrderSortKey;
  dir: "asc" | "desc";
  /** `fra` or `til` was outside what can be shown and was moved. */
  clamped: boolean;
}

/**
 * The period view's `?fra=&til=&sort=&retning=`. Default: this week so far,
 * most time first. Both days are kept between the earliest day and today, and
 * are swapped when they come in the wrong order.
 */
export function parsePeriodParams(
  params: { fra?: string | null; til?: string | null; sort?: string | null; retning?: string | null },
  today: string
): PeriodParams {
  const fra = clampDay(params.fra, today);
  const til = clampDay(params.til, today);
  let from = fra?.day ?? startOfWeek(today);
  let to = til?.day ?? today;
  if (from > to) [from, to] = [to, from];
  return {
    from,
    to,
    sort: ORDER_SORT_KEYS.includes(params.sort as OrderSortKey) ? (params.sort as OrderSortKey) : "total",
    dir: params.retning === "asc" ? "asc" : "desc",
    clamped: Boolean(fra?.clamped || til?.clamped),
  };
}

export async function loadDayReport(ctx: AuthContext, day: string, now: number) {
  const today = dayKey(now);
  const from = dayStart(day);
  const to = dayEnd(day);
  // Read from 36 hours before the day up to now, so an element started the day
  // before and finished on this day has its In.
  const read = await loadScansSince(
    ctx,
    from - STALE_OPEN_MS,
    day === today ? CACHE_SECONDS.today : CACHE_SECONDS.past,
    now
  );
  const intervals = intervalsEndingIn(pairScans(read.scans, now), from, to);
  const orders = summarizeOrders(intervals, scansIn(read.scans, from, to));
  return {
    day,
    isToday: day === today,
    intervals,
    orders,
    // The day starts at its first scan on the day itself: a pass left
    // overnight counts here, but only its hours after that are time in work.
    stations: summarizeStations(intervals, { from, until: day === today ? now : undefined }),
    kpis: computeKpis(intervals, orders),
    read,
    // The read gave up before it got back to this day: nothing above can be
    // trusted, and the page must say so instead of showing it.
    incomplete: read.truncated,
  };
}

export async function loadOrderReport(ctx: AuthContext, orderNo: number, now: number) {
  // GetRowsPaged takes a `keyword`, but what it searches on is not documented
  // and it may match loosely (docs/opticloud-scans.md, "Open with the backend
  // owner"), so it cannot be trusted to return every scan of an order. The
  // order's scans are picked out of the shared rows instead, which the other
  // views keep warm. A day start, so the read begins at the same place all day.
  const since = dayStart(addDays(dayKey(now), -ORDER_LOOKBACK_DAYS));
  const read = await loadScansSince(ctx, since, CACHE_SECONDS.today, now);
  const scans = read.scans.filter((s) => s.orderNo === orderNo);
  const intervals = pairScans(scans, now);
  const [summary] = summarizeOrders(intervals, scans);
  return {
    orderNo,
    summary: summary ?? null,
    elements: summarizeElements(intervals),
    timeline: buildTimeline(intervals),
    stations: summarizeStations(intervals),
    lookbackDays: ORDER_LOOKBACK_DAYS,
    read,
    incomplete: read.truncated,
  };
}

export async function loadPeriodReport(ctx: AuthContext, fromDay: string, toDay: string, now: number) {
  const today = dayKey(now);
  const from = dayStart(fromDay);
  const to = dayEnd(toDay);
  const read = await loadScansSince(
    ctx,
    from - STALE_OPEN_MS,
    toDay >= today ? CACHE_SECONDS.today : CACHE_SECONDS.past,
    now
  );
  // A pass counts in the period when it ended in it, as in the day view.
  const intervals = intervalsEndingIn(pairScans(read.scans, now), from, to);
  const orders = summarizeOrders(intervals, scansIn(read.scans, from, to));
  return { orders, kpis: computeKpis(intervals, orders), read, incomplete: read.truncated };
}
