import { describe, expect, it } from "vitest";
import { navItemsFor } from "@/lib/portal/nav";

const labels = (role: Parameters<typeof navItemsFor>[0]) =>
  navItemsFor(role).map((item) => item.label);

describe("navItemsFor", () => {
  it("admin sees every tab, in the agreed order", () => {
    expect(labels("admin")).toEqual([
      "Overblik",
      "Stationer",
      "Ordrer",
      "Ledelse",
      "Chat",
      "Indstillinger",
    ]);
  });

  it("ledelse sees Ledelse but not Indstillinger", () => {
    expect(labels("ledelse")).toEqual(["Overblik", "Stationer", "Ordrer", "Ledelse", "Chat"]);
  });

  it("planner sees Indstillinger but not Ledelse", () => {
    expect(labels("planner")).toEqual(["Overblik", "Stationer", "Ordrer", "Chat", "Indstillinger"]);
  });

  it("viewer sees neither", () => {
    expect(labels("viewer")).toEqual(["Overblik", "Stationer", "Ordrer", "Chat"]);
  });

  it("Ordrer is active on the period report and on an order page", () => {
    const ordrer = navItemsFor("viewer").find((item) => item.href === "/ordrer");
    expect(ordrer?.match).toEqual(["/ordrer", "/periode", "/ordre"]);
  });

  it("links to the six routes", () => {
    expect(navItemsFor("admin").map((item) => item.href)).toEqual([
      "/",
      "/stationer",
      "/ordrer",
      "/ledelse",
      "/chat",
      "/indstillinger",
    ]);
  });
});
