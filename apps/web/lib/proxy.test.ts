// The optimistic auth pre-filter in proxy.ts (lives here because vitest
// only collects lib/**).

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fixtures-flag", () => ({ fixturesEnabled: () => false }));

const { proxy } = await import("@/proxy");

const request = (path: string) => new NextRequest(new URL(path, "https://ventisol.example"));

describe("proxy without a session cookie", () => {
  it("sends a page to /login with the way back", () => {
    const res = proxy(request("/ordrer?fane=i-gang"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/ordrer?fane=i-gang");
  });

  it("answers an API call with 401, not a login page", async () => {
    const res = proxy(request("/api/export/xlsx?report=finished_orders"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets the cron routes through, they check CRON_SECRET themselves", () => {
    const res = proxy(request("/api/cron/sync"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });
});
