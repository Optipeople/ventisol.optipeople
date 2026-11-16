import { describe, expect, it } from "vitest";
import { ganttLayout, ganttTicks, type GanttStepInput } from "./gantt";

const step = (s: Partial<GanttStepInput> & Pick<GanttStepInput, "step">): GanttStepInput => ({
  label: s.step,
  kind: "work",
  source: "scans",
  startAt: null,
  endAt: null,
  isOpen: false,
  deviation: false,
  ...s,
});

const H = 3_600_000;
const t0 = Date.parse("2026-10-20T06:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("ganttLayout", () => {
  it("lays a packed order from start to packed, with no Nu marker", () => {
    const g = ganttLayout(
      { status: "packed", startAt: iso(t0), packedAt: iso(t0 + 10 * H), forecastReadyAt: null },
      [
        step({ step: "assembly", startAt: iso(t0), endAt: iso(t0 + 6 * H) }),
        step({ step: "wait_packing", kind: "wait", startAt: iso(t0 + 6 * H), endAt: iso(t0 + 8 * H) }),
        step({ step: "packing", startAt: iso(t0 + 8 * H), endAt: iso(t0 + 10 * H), deviation: true }),
        step({ step: "schirmer", source: "none" }),
      ],
      t0 + 100 * H
    );
    expect(g.axisStart).toBe(t0);
    expect(g.nowAt).toBeNull();
    expect(g.forecastAt).toBeNull();
    const [assembly, wait, packing, schirmer] = g.lanes;
    expect(assembly.bar).toMatchObject({ left: 0, tone: "work", open: false });
    expect(assembly.bar!.width).toBeCloseTo((6 / 10.2) * 100, 5);
    expect(wait.bar!.tone).toBe("wait");
    expect(packing.bar!.tone).toBe("deviation");
    expect(packing.bar!.left + packing.bar!.width).toBeLessThanOrEqual(100);
    expect(schirmer.bar).toBeNull();
  });

  it("runs an open step to now and puts the forecast and Nu on the axis", () => {
    const now = t0 + 5 * H;
    const g = ganttLayout(
      { status: "in_progress", startAt: iso(t0), packedAt: null, forecastReadyAt: iso(t0 + 9 * H) },
      [step({ step: "assembly", startAt: iso(t0 + H), endAt: iso(t0 + 2 * H), isOpen: true })],
      now
    );
    expect(g.lanes[0].bar).toMatchObject({ open: true, end: now });
    expect(g.nowAt).toBeCloseTo((5 / (9 * 1.02)) * 100, 5);
    expect(g.forecastAt).toBeCloseTo((9 / (9 * 1.02)) * 100, 5);
  });

  it("gives a tiny pass a visible bar and never a zero axis", () => {
    const g = ganttLayout(
      { status: "packed", startAt: iso(t0), packedAt: iso(t0 + 60_000), forecastReadyAt: null },
      [step({ step: "packing", startAt: iso(t0), endAt: iso(t0 + 60_000) })],
      t0
    );
    expect(g.axisEnd - g.axisStart).toBeGreaterThanOrEqual(H);
    expect(g.lanes[0].bar!.width).toBeGreaterThanOrEqual(0.6);
  });
});

describe("ganttTicks", () => {
  it("uses hours for a short span, Copenhagen clock", () => {
    const ticks = ganttTicks(t0, t0 + 5 * H);
    expect(ticks.map((t) => t.label)).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"]);
  });

  it("uses Copenhagen midnights for a span of days", () => {
    const ticks = ganttTicks(t0, t0 + 4 * 24 * H);
    expect(ticks).toHaveLength(4);
    // 21 October 2026 starts 22:00 UTC the day before (summer time).
    expect(ticks[0].at).toBe(Date.parse("2026-10-20T22:00:00Z"));
  });

  it("thins out the days of a long order", () => {
    expect(ganttTicks(t0, t0 + 60 * 24 * H).length).toBeLessThanOrEqual(10);
  });
});
