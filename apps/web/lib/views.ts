// What each page shows: reads the scans for its period (lib/opticloud.ts) and
// runs the pure computation (lib/report.ts) over them.

import type { AuthContext } from "@/lib/auth";
import { CACHE_SECONDS, loadScansSince } from "@/lib/opticloud";
import {
  buildTimeline,
  computeKpis,
  intervalsStartingIn,
  pairScans,
  scansIn,
  summarizeElements,
  summarizeOrders,
  summarizeStations,
} from "@/lib/report";
import { addDays, dayEnd, dayKey, dayStart } from "@/lib/time";

/** How far back the order page looks for an order's scans. */
export const ORDER_LOOKBACK_DAYS = 30;

/** Longest period the period view reads in one go. */
export const MAX_PERIOD_DAYS = 62;

export async function loadDayReport(ctx: AuthContext, day: string, now: number) {
  const today = dayKey(now);
  const from = dayStart(day);
  const to = dayEnd(day);
  // Read from the day's start up to now: an Out the next morning still
  // closes an element started on the day.
  const read = await loadScansSince(
    ctx,
    from,
    day === today ? CACHE_SECONDS.today : CACHE_SECONDS.past,
    now
  );
  const intervals = intervalsStartingIn(pairScans(read.scans, now), from, to);
  const orders = summarizeOrders(intervals, scansIn(read.scans, from, to));
  return {
    day,
    isToday: day === today,
    intervals,
    orders,
    stations: summarizeStations(intervals, day === today ? now : undefined),
    kpis: computeKpis(intervals, orders),
    read,
  };
}

export async function loadOrderReport(ctx: AuthContext, orderNo: number, now: number) {
  // A day start, so the cache key holds all day.
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
  };
}

export async function loadPeriodReport(ctx: AuthContext, fromDay: string, toDay: string, now: number) {
  const today = dayKey(now);
  const from = dayStart(fromDay);
  const to = dayEnd(toDay);
  const read = await loadScansSince(
    ctx,
    from,
    toDay >= today ? CACHE_SECONDS.today : CACHE_SECONDS.past,
    now
  );
  const intervals = intervalsStartingIn(pairScans(read.scans, now), from, to);
  const orders = summarizeOrders(intervals, scansIn(read.scans, from, to));
  return { orders, kpis: computeKpis(intervals, orders), read };
}
