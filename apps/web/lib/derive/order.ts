// Order route and facts, element facts and interval rows, from an order's
// whole scan history. Pure: scans, the 3E info and a context in; rows out.
//
// The definitions (lead time, steps, overlap, packed, on time) are written
// out in docs/read-model.md. Change a rule there and here together.

import { dedupeScans } from "@/lib/report";
import type { Scan } from "@/lib/scans";
import { addDays, dayKey, dayStart } from "@/lib/time";
import { isoWeekMonday, workingMsBetween } from "./calendar";
import { forecastOrder, type ForecastInput } from "./forecast";
import { endOrNow, pairHistory, type PairedInterval } from "./pairing";
import {
  DEFAULT_PARAMS,
  STEP_KEYS,
  STEP_KIND,
  type DeriveContext,
  type DeriveParams,
  type DerivedOrder,
  type ElementRow,
  type ExpectedElement,
  type MissingElement,
  type OrderInfo,
  type OrderRow,
  type OrderStepRow,
  type StationIntervalRow,
  type StepKey,
  type WorkCalendar,
} from "./types";

const iso = (ms: number) => new Date(ms).toISOString();
const sum = (values: number[]) => values.reduce((t, v) => t + v, 0);

export function resolveParams(params?: Partial<DeriveParams>): DeriveParams {
  return { ...DEFAULT_PARAMS, ...params };
}

/**
 * Milliseconds to whole seconds so the parts still add up to `totalSeconds`
 * (largest remainder): each part is rounded down, and the seconds left over go
 * to the parts that were cut the most.
 */
export function roundParts(partsMs: number[], totalSeconds: number): number[] {
  const out = partsMs.map((v) => Math.floor(v / 1000));
  let left = totalSeconds - sum(out);
  const byRemainder = partsMs
    .map((v, i) => ({ i, r: v / 1000 - Math.floor(v / 1000) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && byRemainder.length > 0; k++, left--) out[byRemainder[k % byRemainder.length].i] += 1;
  return out;
}

/**
 * The first instant that is too late: the end of the target week (Lev. uge
 * plus onTimeWeekOffset weeks), plus onTimeGraceDays. Without a year on the
 * document, the year whose week lies nearest `nearMs` is used.
 */
export function dueAtFor(
  info: Pick<OrderInfo, "deliveryWeek" | "deliveryYear"> | null,
  nearMs: number,
  params: Pick<DeriveParams, "onTimeWeekOffset" | "onTimeGraceDays">
): { dueAt: number; year: number } | null {
  if (!info || info.deliveryWeek == null || info.deliveryWeek < 1 || info.deliveryWeek > 53) return null;
  const week = info.deliveryWeek;
  let year = info.deliveryYear ?? null;
  if (year == null) {
    const near = dayStart(dayKey(nearMs));
    const nearYear = Number(dayKey(nearMs).slice(0, 4));
    let best = Infinity;
    for (const candidate of [nearYear - 1, nearYear, nearYear + 1]) {
      const distance = Math.abs(dayStart(isoWeekMonday(candidate, week)) - near);
      if (distance < best) {
        best = distance;
        year = candidate;
      }
    }
  }
  const monday = addDays(isoWeekMonday(year as number, week), 7 * params.onTimeWeekOffset);
  return { dueAt: dayStart(addDays(monday, 7 + params.onTimeGraceDays)), year: year as number };
}

const groupKey = (position: number | null, subPosition: number | null | undefined) =>
  `${position ?? -1}:${subPosition == null || subPosition < 1 ? 1 : subPosition}`;

interface ExpectedGroup {
  position: number;
  subPosition: number;
  quantity: number;
  first: ExpectedElement;
}

function expectedGroups(info: OrderInfo | null): Map<string, ExpectedGroup> {
  const groups = new Map<string, ExpectedGroup>();
  for (const e of info?.expectedElements ?? []) {
    if (!(e.quantity > 0)) continue;
    const key = groupKey(e.position, e.subPosition);
    const g = groups.get(key);
    if (g) g.quantity += e.quantity;
    else {
      groups.set(key, {
        position: e.position,
        subPosition: e.subPosition == null || e.subPosition < 1 ? 1 : e.subPosition,
        quantity: e.quantity,
        first: e,
      });
    }
  }
  return groups;
}

interface ElementState {
  barcode: string;
  scan: Scan;
  firstScan: number;
  lastScan: number;
  /** Done and open intervals, oldest first. */
  counted: PairedInterval[];
  missingOut: number;
  assembled: boolean;
  assembledAt: number | null;
  packedAt: number | null;
  group: ExpectedGroup | undefined;
}

type Bucket = "asmWork" | "asmWait" | "waitPack" | "packWork";
const BUCKETS: Bucket[] = ["asmWork", "asmWait", "waitPack", "packWork"];

interface BucketTotals {
  ms: number;
  workingMs: number;
  first: number | null;
  last: number | null;
}

/**
 * Splits [start, end) between the steps. Every instant goes to exactly one
 * bucket:
 *   1. an element of the order is at an assembly station: Montage, work
 *   2. else one is at the packing station: Pakning, work
 *   3. else nothing is being worked on: Montage (wait) while assembly work
 *      still lies ahead, otherwise Venter før pakning.
 * So assembly wins an overlap with packing.
 */
function partition(
  counted: PairedInterval[],
  start: number,
  end: number,
  now: number,
  assemblyAheadAtEnd: boolean,
  calendar: WorkCalendar
): Record<Bucket, BucketTotals> {
  const totals = Object.fromEntries(
    BUCKETS.map((b) => [b, { ms: 0, workingMs: 0, first: null, last: null }])
  ) as Record<Bucket, BucketTotals>;
  if (!(end > start)) return totals;

  const clipped = counted
    .map((iv) => ({ kind: iv.stationKind, s: Math.max(iv.start, start), e: Math.min(endOrNow(iv, now), end) }))
    .filter((c) => c.e > c.s);
  const lastAssemblyEnd = Math.max(start, ...clipped.filter((c) => c.kind === "assembly").map((c) => c.e));
  const points = [...new Set([start, end, ...clipped.flatMap((c) => [c.s, c.e])])].sort((a, b) => a - b);

  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i];
    const q = points[i + 1];
    let assembly = false;
    let packing = false;
    for (const c of clipped) {
      if (c.s <= p && c.e >= q) {
        if (c.kind === "assembly") assembly = true;
        else packing = true;
      }
    }
    const bucket: Bucket = assembly
      ? "asmWork"
      : packing
        ? "packWork"
        : p < lastAssemblyEnd || assemblyAheadAtEnd
          ? "asmWait"
          : "waitPack";
    const t = totals[bucket];
    t.ms += q - p;
    t.workingMs += workingMsBetween(p, q, calendar);
    t.first ??= p;
    t.last = q;
  }
  return totals;
}

function deriveOne(
  orderNo: number,
  scans: Scan[],
  intervals: PairedInterval[],
  info: OrderInfo | null,
  ctx: DeriveContext
): DerivedOrder {
  const { now, calendar } = ctx;
  const params = resolveParams(ctx.params);
  const groups = expectedGroups(info);
  const hasDocument = groups.size > 0;
  const counted = intervals.filter((iv) => iv.status !== "missing_out");
  const open = intervals.filter((iv) => iv.status === "open");

  // Elements: every barcode seen in a scan.
  const elements = new Map<string, ElementState>();
  for (const scan of [...scans].sort((a, b) => a.time - b.time)) {
    const el = elements.get(scan.barcode);
    if (el) el.lastScan = scan.time;
    else {
      elements.set(scan.barcode, {
        barcode: scan.barcode,
        scan,
        firstScan: scan.time,
        lastScan: scan.time,
        counted: [],
        missingOut: 0,
        assembled: false,
        assembledAt: null,
        packedAt: null,
        group: groups.get(groupKey(scan.position, scan.subPosition)),
      });
    }
  }
  for (const iv of intervals) {
    const el = elements.get(iv.barcode);
    if (!el) continue;
    if (iv.status === "missing_out") el.missingOut += 1;
    else el.counted.push(iv);
  }
  for (const el of elements.values()) {
    const assemblyDone = el.counted.filter((iv) => iv.stationKind === "assembly" && iv.status === "done");
    const packing = el.counted.filter((iv) => iv.stationKind === "packing");
    const packingDone = packing.filter((iv) => iv.status === "done");
    const openAssembly = el.counted.some((iv) => iv.stationKind === "assembly" && iv.status === "open");
    el.assembledAt = assemblyDone.length > 0 ? Math.max(...assemblyDone.map((iv) => iv.end as number)) : null;
    // Reaching packing means assembly is behind it, also when an assembly scan was missed.
    el.assembled = !openAssembly && (assemblyDone.length > 0 || packing.length > 0);
    el.packedAt =
      packingDone.length > 0 && !el.counted.some((iv) => iv.status === "open")
        ? Math.max(...packingDone.map((iv) => iv.end as number))
        : null;
  }
  const all = [...elements.values()];
  const packedElements = all.filter((el) => el.packedAt != null);

  // Packed.
  const inGroup = (g: ExpectedGroup, list: ElementState[]) => list.filter((el) => el.group === g).length;
  const firstScan = Math.min(...scans.map((s) => s.time));
  const lastScan = Math.max(...scans.map((s) => s.time));
  let packed: boolean;
  let assemblyComplete: boolean;
  if (hasDocument) {
    const list = [...groups.values()];
    packed = open.length === 0 && list.every((g) => inGroup(g, packedElements) >= g.quantity);
    assemblyComplete = list.every((g) => inGroup(g, all.filter((el) => el.assembled)) >= g.quantity);
  } else {
    packed =
      open.length === 0 &&
      all.length > 0 &&
      packedElements.length === all.length &&
      now - lastScan >= params.packedQuietSeconds * 1000;
    assemblyComplete = all.length > 0 && all.every((el) => el.assembled);
  }
  const packedAt = packed ? Math.max(...packedElements.map((el) => el.packedAt as number)) : null;

  // The span and its split into steps.
  const start = Math.min(firstScan, ...counted.map((iv) => iv.start));
  const end = Math.max(start, packedAt ?? now);
  const totals = partition(counted, start, end, now, !packed && !assemblyComplete, calendar);
  const totalSeconds = Math.round((end - start) / 1000);
  const totalWorkingSeconds = Math.round(workingMsBetween(start, end, calendar) / 1000);
  const wall = roundParts(BUCKETS.map((b) => totals[b].ms), totalSeconds);
  const working = roundParts(BUCKETS.map((b) => totals[b].workingMs), totalWorkingSeconds);
  const seconds = Object.fromEntries(BUCKETS.map((b, i) => [b, { wall: wall[i], working: working[i] }])) as Record<
    Bucket,
    { wall: number; working: number }
  >;

  const openAssembly = open.some((iv) => iv.stationKind === "assembly");
  const currentStep: StepKey | null = packed
    ? null
    : openAssembly
      ? "assembly"
      : open.length > 0
        ? "packing"
        : assemblyComplete
          ? "wait_packing"
          : "assembly";

  const touch = (kind: "assembly" | "packing") =>
    Math.round(
      sum(counted.filter((iv) => iv.stationKind === kind).map((iv) => endOrNow(iv, now) - iv.start)) / 1000
    );

  const span = (buckets: Bucket[]) => {
    const firsts = buckets.map((b) => totals[b].first).filter((v): v is number => v != null);
    const lasts = buckets.map((b) => totals[b].last).filter((v): v is number => v != null);
    return {
      startAt: firsts.length > 0 ? iso(Math.min(...firsts)) : null,
      endAt: lasts.length > 0 ? iso(Math.max(...lasts)) : null,
    };
  };

  const measured: Record<"assembly" | "wait_packing" | "packing", { work: Bucket[]; wait: Bucket[] }> = {
    assembly: { work: ["asmWork"], wait: ["asmWait"] },
    wait_packing: { work: [], wait: ["waitPack"] },
    packing: { work: ["packWork"], wait: [] },
  };

  const steps: OrderStepRow[] = STEP_KEYS.map((step, index) => {
    const base: OrderStepRow = {
      orderNo,
      step,
      seq: index + 1,
      kind: STEP_KIND[step],
      source: "none",
      startAt: null,
      endAt: null,
      durationSeconds: null,
      durationWorkingSeconds: null,
      workSeconds: null,
      workWorkingSeconds: null,
      waitSeconds: null,
      waitWorkingSeconds: null,
      touchSeconds: null,
      isOpen: false,
      countsInLead: false,
    };
    if (step === "schirmer") {
      // No machine data yet (plan §7): an assumed figure at most, never measured.
      if (params.schirmerAssumedSeconds == null) return base;
      return { ...base, source: "assumed", durationSeconds: params.schirmerAssumedSeconds };
    }
    if (step !== "assembly" && step !== "wait_packing" && step !== "packing") return base;

    const { work, wait } = measured[step];
    const reached = packed || currentStep === step || [...work, ...wait].some((b) => totals[b].first != null);
    if (!reached) return { ...base, source: "scans", countsInLead: true };
    const w = (list: Bucket[], which: "wall" | "working") => sum(list.map((b) => seconds[b][which]));
    return {
      ...base,
      source: "scans",
      countsInLead: true,
      ...span([...work, ...wait]),
      durationSeconds: w(work, "wall") + w(wait, "wall"),
      durationWorkingSeconds: w(work, "working") + w(wait, "working"),
      workSeconds: w(work, "wall"),
      workWorkingSeconds: w(work, "working"),
      waitSeconds: w(wait, "wall"),
      waitWorkingSeconds: w(wait, "working"),
      touchSeconds: step === "wait_packing" ? 0 : touch(step),
      isOpen: currentStep === step,
    };
  });

  // On time, forecast.
  const due = dueAtFor(info, start, params);
  let forecastReadyAt: number | null = null;
  let forecastRemainingSeconds: number | null = null;
  let forecastBasis: OrderRow["forecastBasis"] = null;
  if (!packed && ctx.typical) {
    const input: ForecastInput = {
      now,
      elements: all.map((el) => {
        const openIv = el.counted.find((iv) => iv.status === "open");
        return {
          elementTypeId: el.group?.first.elementTypeId ?? null,
          packed: el.packedAt != null,
          doneStationNos: el.counted.filter((iv) => iv.status === "done").map((iv) => iv.stationNo),
          openAt: openIv ? { stationNo: openIv.stationNo, since: openIv.start } : null,
        };
      }),
      unseen: [...groups.values()].map((g) => ({
        elementTypeId: g.first.elementTypeId,
        count: Math.max(0, g.quantity - inGroup(g, all)),
      })),
      packingStarted: counted.some((iv) => iv.stationKind === "packing"),
    };
    const forecast = forecastOrder(input, ctx.typical, calendar);
    if (forecast) {
      forecastReadyAt = forecast.readyAt;
      forecastRemainingSeconds = forecast.remainingSeconds;
      forecastBasis = hasDocument ? "document" : "seen_elements";
    }
  }
  let atRisk: boolean | null = null;
  if (!packed && due) {
    if (now >= due.dueAt) atRisk = true;
    else if (forecastReadyAt != null) atRisk = forecastReadyAt >= due.dueAt;
  }

  const missingElements: MissingElement[] | null = hasDocument
    ? [...groups.values()]
        .map((g) => ({
          position: g.position,
          subPosition: g.subPosition,
          expected: g.quantity,
          seen: inGroup(g, all),
          packed: inGroup(g, packedElements),
        }))
        .filter((m) => m.packed < m.expected)
    : null;

  const workSeconds = seconds.asmWork.wall + seconds.packWork.wall;
  const workWorkingSeconds = seconds.asmWork.working + seconds.packWork.working;

  const order: OrderRow = {
    orderNo,
    customer: info?.customer ?? null,
    caseName: info?.caseName ?? null,
    deliveryAddress: info?.deliveryAddress ?? null,
    deliveryYear: due?.year ?? info?.deliveryYear ?? null,
    deliveryWeek: info?.deliveryWeek ?? null,
    dueAt: due ? iso(due.dueAt) : null,
    status: packed ? "packed" : "in_progress",
    packedSource: packed ? (hasDocument ? "document" : "scans") : null,
    expectedSource: hasDocument ? "document" : "scans",
    elementsExpected: hasDocument ? sum([...groups.values()].map((g) => g.quantity)) : null,
    elementsSeen: all.length,
    elementsAssembled: all.filter((el) => el.assembled).length,
    elementsPacked: packedElements.length,
    missingElements,
    firstScanAt: iso(firstScan),
    lastScanAt: iso(lastScan),
    startAt: iso(start),
    startSource: "first_scan",
    packedAt: packedAt != null ? iso(packedAt) : null,
    startLocalDay: dayKey(start),
    packedLocalDay: packedAt != null ? dayKey(packedAt) : null,
    leadSeconds: packed ? totalSeconds : null,
    leadWorkingSeconds: packed ? totalWorkingSeconds : null,
    elapsedSeconds: totalSeconds,
    elapsedWorkingSeconds: totalWorkingSeconds,
    workSeconds,
    workWorkingSeconds,
    waitSeconds: totalSeconds - workSeconds,
    waitWorkingSeconds: totalWorkingSeconds - workWorkingSeconds,
    touchSeconds: touch("assembly") + touch("packing"),
    reworkCount: counted.filter((iv) => (iv.visit ?? 1) > 1).length,
    missingScanOutCount: intervals.length - counted.length,
    openCount: open.length,
    onTime: packedAt != null && due ? packedAt < due.dueAt : null,
    currentStep,
    currentStationNos: [...new Set(open.map((iv) => iv.stationNo))].sort((a, b) => a - b),
    forecastReadyAt: forecastReadyAt != null ? iso(forecastReadyAt) : null,
    forecastRemainingSeconds,
    forecastBasis,
    atRisk,
    computedAt: iso(now),
  };

  const elementRows: ElementRow[] = all
    .map((el): ElementRow => {
      const first = el.counted.length > 0 ? Math.min(...el.counted.map((iv) => iv.start)) : null;
      const last = el.counted.length > 0 ? Math.max(...el.counted.map((iv) => endOrNow(iv, now))) : null;
      const openIv = el.counted.find((iv) => iv.status === "open");
      const expected = el.group?.first;
      return {
        barcode: el.barcode,
        orderNo,
        position: el.scan.position,
        subPosition: el.scan.subPosition,
        piece: el.scan.piece,
        elementTypeId: expected?.elementTypeId ?? null,
        inDocument: hasDocument ? el.group != null : null,
        system: expected?.system ?? null,
        widthMm: expected?.widthMm ?? null,
        heightMm: expected?.heightMm ?? null,
        firstScanAt: iso(el.firstScan),
        lastScanAt: iso(el.lastScan),
        stationPath: el.counted.map((iv) => iv.stationNo),
        totalSeconds: first != null && last != null ? Math.round((last - first) / 1000) : null,
        totalWorkingSeconds:
          first != null && last != null ? Math.round(workingMsBetween(first, last, calendar) / 1000) : null,
        touchSeconds: Math.round(sum(el.counted.map((iv) => endOrNow(iv, now) - iv.start)) / 1000),
        reworkCount: el.counted.filter((iv) => (iv.visit ?? 1) > 1).length,
        missingScanOutCount: el.missingOut,
        inProgress: openIv != null,
        currentStationNo: openIv?.stationNo ?? null,
        assembledAt: el.assembledAt != null ? iso(el.assembledAt) : null,
        packedAt: el.packedAt != null ? iso(el.packedAt) : null,
      };
    })
    .sort((a, b) => a.barcode.localeCompare(b.barcode));

  // Interval rows, with the wait since the element's previous Out.
  const previousEnd = new Map<string, number>();
  const intervalRows: StationIntervalRow[] = intervals.map((iv) => {
    const isCounted = iv.status !== "missing_out";
    const prev = previousEnd.get(iv.barcode);
    const waitMs = isCounted && prev != null ? Math.max(0, iv.start - prev) : null;
    const waitWorkingMs = isCounted && prev != null ? workingMsBetween(prev, iv.start, calendar) : null;
    if (iv.status === "done") previousEnd.set(iv.barcode, Math.max(prev ?? -Infinity, iv.end as number));
    return {
      intervalId: iv.id,
      orderNo,
      barcode: iv.barcode,
      stationNo: iv.stationNo,
      station: iv.station,
      stationKind: iv.stationKind,
      visit: iv.visit,
      isRework: (iv.visit ?? 1) > 1,
      status: iv.status,
      missingReason: iv.missingReason,
      startAt: iso(iv.start),
      endAt: iv.end != null ? iso(iv.end) : null,
      startEstimated: iv.startEstimated,
      durationSeconds: iv.end != null ? Math.round((iv.end - iv.start) / 1000) : null,
      durationWorkingSeconds:
        iv.end != null ? Math.round(workingMsBetween(iv.start, iv.end, calendar) / 1000) : null,
      allocatedSeconds: null,
      allocatedWorkingSeconds: null,
      waitBeforeSeconds: waitMs != null ? Math.round(waitMs / 1000) : null,
      waitBeforeWorkingSeconds: waitWorkingMs != null ? Math.round(waitWorkingMs / 1000) : null,
      elementTypeId: elements.get(iv.barcode)?.group?.first.elementTypeId ?? null,
      localDay: dayKey(iv.end ?? iv.start),
      inScanId: iv.inScanId,
      outScanId: iv.outScanId,
    };
  });

  return { order, elements: elementRows, intervals: intervalRows, steps };
}

/**
 * Derives every order present in `scans`. Hand in the WHOLE scan history of
 * each order (pairing, visits and lead time need all of it); scans of several
 * orders may come together. Orders come back by order number.
 */
export function deriveOrders(scans: Scan[], infos: OrderInfo[], ctx: DeriveContext): DerivedOrder[] {
  const params = resolveParams(ctx.params);
  const unique = dedupeScans(scans);
  const intervals = pairHistory(unique, {
    now: ctx.now,
    staleOpenSeconds: params.staleOpenSeconds,
    maxOpen: ctx.maxOpen,
    otherOpenInsByStation: ctx.otherOpenInsByStation,
    calendar: ctx.calendar,
  });
  const infoByOrder = new Map(infos.map((i) => [i.orderNo, i]));
  const scansByOrder = new Map<number, Scan[]>();
  for (const s of unique) {
    const list = scansByOrder.get(s.orderNo);
    if (list) list.push(s);
    else scansByOrder.set(s.orderNo, [s]);
  }
  const intervalsByOrder = new Map<number, PairedInterval[]>();
  for (const iv of intervals) {
    const list = intervalsByOrder.get(iv.orderNo);
    if (list) list.push(iv);
    else intervalsByOrder.set(iv.orderNo, [iv]);
  }
  return [...scansByOrder.keys()]
    .sort((a, b) => a - b)
    .map((orderNo) =>
      deriveOne(
        orderNo,
        scansByOrder.get(orderNo) as Scan[],
        intervalsByOrder.get(orderNo) ?? [],
        infoByOrder.get(orderNo) ?? null,
        ctx
      )
    );
}

/** One order. `scans` must be that order's whole history. */
export function deriveOrder(scans: Scan[], info: OrderInfo | null, ctx: DeriveContext): DerivedOrder | null {
  return deriveOrders(scans, info ? [info] : [], ctx)[0] ?? null;
}
