import { describe, expect, it } from "vitest";
import {
  orderHref,
  parseOrdersView,
  periodeRedirect,
  preserveFor,
  sortHref,
  tabHref,
  viewHref,
  type FinishedView,
  type InProgressView,
} from "./params";

describe("parseOrdersView", () => {
  it("defaults to the orders in progress, active only, newest started first", () => {
    const v = parseOrdersView({}) as InProgressView;
    expect(v).toEqual({
      tab: "in-progress",
      search: "",
      clock: undefined,
      dir: "desc",
      page: 1,
      status: undefined,
      activeOnly: true,
      sort: "start",
    });
    expect(viewHref(v)).toBe("/ordrer?view=in-progress");
  });

  it("reads the finished tab with period, status, clock, sort and page", () => {
    const v = parseOrdersView({
      view: "finished",
      q: "  Jensen ",
      status: "late",
      from: "2026-10-01",
      to: "2026-10-31",
      clock: "wall",
      sort: "lead",
      dir: "asc",
      page: "3",
    }) as FinishedView;
    expect(v).toMatchObject({
      tab: "finished",
      search: "Jensen",
      status: "late",
      from: "2026-10-01",
      to: "2026-10-31",
      clock: "wall",
      sort: "lead",
      dir: "asc",
      page: 3,
    });
    expect(viewHref(v)).toBe(
      "/ordrer?view=finished&q=Jensen&status=late&from=2026-10-01&to=2026-10-31&clock=wall&sort=lead&dir=asc&page=3"
    );
  });

  it("takes a link from Overblik with a period to the finished orders of that period", () => {
    const v = parseOrdersView({ from: "2026-11-01", to: "2026-11-19", status: "late", clock: "working" });
    expect(v).toMatchObject({ tab: "finished", from: "2026-11-01", to: "2026-11-19", status: "late", clock: "working" });
  });

  it("takes an in-progress-only status, or an explicit view, to the orders in progress", () => {
    expect(parseOrdersView({ from: "2026-11-01", status: "at_risk" })).toMatchObject({ tab: "in-progress", status: "at_risk" });
    expect(parseOrdersView({ view: "in-progress", from: "2026-11-01", status: "late" })).toMatchObject({
      tab: "in-progress",
      status: "late",
    });
  });

  it("drops what it does not know instead of failing", () => {
    const v = parseOrdersView({ view: "x", sort: "drop table", status: "at_risk", page: "-2", active: "all", clock: "moon" }) as InProgressView;
    expect(v.sort).toBe("start");
    expect(v.status).toBe("at_risk");
    expect(v.page).toBe(1);
    expect(v.activeOnly).toBe(false);
    expect(v.clock).toBeUndefined();

    const f = parseOrdersView({ view: "finished", status: "at_risk", from: "2026-02-30", sort: "forecast" }) as FinishedView;
    expect(f.status).toBeUndefined();
    expect(f.from).toBeUndefined();
    expect(f.sort).toBe("packed");
  });

  it("swaps a reversed period", () => {
    const f = parseOrdersView({ view: "finished", from: "2026-11-10", to: "2026-11-01" }) as FinishedView;
    expect([f.from, f.to]).toEqual(["2026-11-01", "2026-11-10"]);
  });

  it("takes the first of a repeated param", () => {
    expect(parseOrdersView({ q: ["58721", "x"] }).search).toBe("58721");
  });
});

describe("links", () => {
  const finished = parseOrdersView({ view: "finished", q: "58", status: "on_time", page: "4", sort: "lead", clock: "wall" });

  it("flips the active column and starts a new one in its natural direction, on page 1", () => {
    expect(sortHref(finished, "lead")).toBe("/ordrer?view=finished&q=58&status=on_time&clock=wall&sort=lead&dir=asc");
    expect(sortHref(finished, "order")).toBe("/ordrer?view=finished&q=58&status=on_time&clock=wall&sort=order&dir=asc");
    expect(sortHref(finished, "packed")).toBe("/ordrer?view=finished&q=58&status=on_time&clock=wall");
  });

  it("keeps the search and the clock when switching tabs", () => {
    expect(tabHref(finished, "in-progress")).toBe("/ordrer?view=in-progress&q=58&clock=wall");
    expect(tabHref(parseOrdersView({}), "finished")).toBe("/ordrer?view=finished");
  });

  it("reads the delivery week on both tabs, and the other tab keeps it", () => {
    const v = parseOrdersView({ view: "finished", uge: "2026-47" });
    expect(v.week).toEqual({ year: 2026, week: 47 });
    expect(viewHref(v)).toBe("/ordrer?view=finished&uge=2026-47");
    expect(tabHref(v, "in-progress")).toBe("/ordrer?view=in-progress&uge=2026-47");
    expect(parseOrdersView({ uge: "2026-7" }).week).toEqual({ year: 2026, week: 7 });
    expect(parseOrdersView({ uge: "2026-54" }).week).toBeUndefined();
    expect(parseOrdersView({ uge: "uge 47" }).week).toBeUndefined();
  });

  it("preserves the rest without the page and the dropped params", () => {
    expect(preserveFor(finished, "status")).toEqual({ view: "finished", q: "58", clock: "wall", sort: "lead" });
  });

  it("carries the clock to the order page", () => {
    expect(orderHref(58721)).toBe("/ordre/58721");
    expect(orderHref(58721, "wall")).toBe("/ordre/58721?clock=wall");
  });
});

describe("periodeRedirect", () => {
  it("sends an old period link to the finished orders with the same period and sort", () => {
    expect(periodeRedirect({ fra: "2026-10-05", til: "2026-10-11", sort: "total", retning: "asc" })).toBe(
      "/ordrer?view=finished&from=2026-10-05&to=2026-10-11&sort=lead&dir=asc"
    );
  });

  it("drops sort keys the finished list does not have, and bad days", () => {
    expect(periodeRedirect({ sort: "perElement", retning: "asc", fra: "nope" })).toBe("/ordrer?view=finished");
    expect(periodeRedirect({})).toBe("/ordrer?view=finished");
  });
});
