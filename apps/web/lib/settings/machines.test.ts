import { afterEach, describe, expect, it, vi } from "vitest";
import { listOptiCloudMachines, parseMachines } from "./machines";

describe("parseMachines", () => {
  it("reads id and name, sorted by name with numbers in order", () => {
    expect(
      parseMachines([
        { id: "b", name: "Station 20" },
        { id: "a", name: "Station 100" },
        { id: "c", name: "Station 3", factoryId: "f" },
      ])
    ).toEqual([
      { id: "c", name: "Station 3" },
      { id: "b", name: "Station 20" },
      { id: "a", name: "Station 100" },
    ]);
  });

  it("skips rows without an id, drops doubles and names a nameless machine by its id", () => {
    expect(parseMachines([{ name: "x" }, null, { id: "A", name: " " }, { id: "a", name: "again" }])).toEqual([
      { id: "A", name: "A" },
    ]);
  });

  it("finds the list inside an object, and gives nothing for anything else", () => {
    expect(parseMachines({ items: [{ id: "a", name: "M" }] })).toEqual([{ id: "a", name: "M" }]);
    expect(parseMachines(null)).toEqual([]);
    expect(parseMachines("no")).toEqual([]);
  });
});

describe("listOptiCloudMachines", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the account's machines with the user's token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: "m1", name: "Presse" }], errors: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listOptiCloudMachines("tok", "acc-1")).toEqual({
      status: "ok",
      machines: [{ id: "m1", name: "Presse" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/Machine\/GetByAccountId\/acc-1$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("is unavailable, never an error, when OptiCloud refuses, fails or is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    expect(await listOptiCloudMachines("tok", "acc-1")).toEqual({ status: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: null, errors: ["no"] })));
    expect(await listOptiCloudMachines("tok", "acc-1")).toEqual({ status: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await listOptiCloudMachines("tok", "acc-1")).toEqual({ status: "unavailable" });
    expect(await listOptiCloudMachines("", "acc-1")).toEqual({ status: "unavailable" });
  });
});
