// The /auth/refresh route handler, run without a server: next/headers and
// the two upstream calls are mocked. Lives in lib/ because vitest only
// collects lib/**/*.test.ts.

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResult, SessionUser } from "@/lib/auth";

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));

const optipeopleLogin = vi.fn<(body: Record<string, string>) => Promise<LoginResult>>();
const fetchCurrentUser = vi.fn();
const isAllowedUser = vi.fn<(user: SessionUser) => boolean>();

vi.mock("@/lib/auth", () => ({
  optipeopleLogin: (body: Record<string, string>) => optipeopleLogin(body),
  fetchCurrentUser: (token: string) => fetchCurrentUser(token),
  isAllowedUser: (user: SessionUser) => isAllowedUser(user),
  cookieOptions: (persistent: boolean) => ({
    httpOnly: true,
    secure: false,
    sameSite: "lax" as const,
    path: "/",
    ...(persistent ? { maxAge: 60 * 60 * 24 * 30 } : {}),
  }),
  loginPath: (currentPath: string, error?: string) => {
    const qs = new URLSearchParams();
    if (error) qs.set("error", error);
    if (currentPath && currentPath !== "/") qs.set("next", currentPath);
    return qs.size ? `/login?${qs}` : "/login";
  },
}));

import { GET } from "@/app/auth/refresh/route";

const ORIGIN = "https://ventisol.optipeople.dk";
const USER: SessionUser = {
  id: "u1",
  email: "anna@ventisol.dk",
  name: "Anna",
  roleName: null,
  permissionName: null,
  accountId: "acc",
  accountName: "Ventisol",
};

const fp = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

async function call(query: string) {
  const res = await GET(new NextRequest(`${ORIGIN}/auth/refresh${query}`));
  const location = res.headers.get("location") ?? "";
  return {
    status: res.status,
    /** Path and query of the redirect. */
    to: location.replace(ORIGIN, ""),
    /** Cookie name -> value set on the response ("" means deleted). */
    set: Object.fromEntries(res.cookies.getAll().map((c) => [c.name, c.value])),
  };
}

const CLEARED = {
  ventisol_token: "",
  ventisol_refresh: "",
  ventisol_email: "",
  ventisol_persist: "",
  ventisol_refreshed: "",
};

beforeEach(() => {
  jar.clear();
  jar.set("ventisol_token", "old-access");
  jar.set("ventisol_refresh", "old-refresh");
  jar.set("ventisol_email", "anna@ventisol.dk");
  jar.set("ventisol_persist", "1");
  optipeopleLogin.mockReset();
  fetchCurrentUser.mockReset();
  isAllowedUser.mockReset().mockReturnValue(true);
});

describe("GET /auth/refresh", () => {
  it("refreshes, sets the new tokens and goes back to the page", async () => {
    optipeopleLogin.mockResolvedValue({
      ok: true,
      data: { access_token: "new-access", refresh_token: "new-refresh" },
    });
    fetchCurrentUser.mockResolvedValue({ status: "ok", user: USER });

    const res = await call("?next=%2Fperiode%3Ffra%3D2026-11-01");

    expect(optipeopleLogin).toHaveBeenCalledWith({
      grant_type: "refresh_token",
      username: "anna@ventisol.dk",
      refresh_token: "old-refresh",
    });
    expect(res.to).toBe("/periode?fra=2026-11-01");
    expect(res.set).toEqual({
      ventisol_token: "new-access",
      ventisol_refresh: "new-refresh",
      ventisol_email: "anna@ventisol.dk",
      ventisol_refreshed: "1",
    });
  });

  it("never redirects off the site", async () => {
    optipeopleLogin.mockResolvedValue({ ok: true, data: { access_token: "new-access" } });
    fetchCurrentUser.mockResolvedValue({ status: "ok", user: USER });
    expect((await call("?next=%2F%2Fevil.com")).to).toBe("/");
  });

  it("sends a user without access to the login, with the forbidden message", async () => {
    optipeopleLogin.mockResolvedValue({ ok: true, data: { access_token: "new-access" } });
    fetchCurrentUser.mockResolvedValue({ status: "ok", user: USER });
    isAllowedUser.mockReturnValue(false);
    expect((await call("?next=%2F")).to).toBe("/login?error=forbidden");
  });

  it("ends the session when there is no refresh token", async () => {
    jar.delete("ventisol_refresh");
    const res = await call("?next=%2Fperiode");
    expect(res.to).toBe("/login?next=%2Fperiode");
    expect(res.set).toEqual(CLEARED);
    expect(optipeopleLogin).not.toHaveBeenCalled();
  });

  describe("retry=1", () => {
    it("ends the session right after a refresh", async () => {
      jar.set("ventisol_refreshed", "1");
      const res = await call("?next=%2F&retry=1");
      expect(res.to).toBe("/login?error=session");
      expect(res.set).toEqual(CLEARED);
      expect(optipeopleLogin).not.toHaveBeenCalled();
    });

    it("is ignored without the ventisol_refreshed cookie, so a link from another site logs nobody out", async () => {
      optipeopleLogin.mockResolvedValue({ ok: true, data: { access_token: "new-access" } });
      fetchCurrentUser.mockResolvedValue({ status: "ok", user: USER });
      const res = await call("?next=%2F&retry=1");
      expect(res.to).toBe("/");
      expect(res.set.ventisol_token).toBe("new-access");
    });
  });

  describe("OptiCloud unavailable", () => {
    it("keeps the cookies and shows the retry page", async () => {
      optipeopleLogin.mockResolvedValue({ ok: false, reason: "unavailable" });
      const res = await call("?next=%2Fperiode");
      expect(res.to).toBe("/auth/unavailable?next=%2Fperiode");
      expect(res.set).toEqual({});
    });

    it("keeps the new tokens when the refresh worked but the user check could not be reached", async () => {
      optipeopleLogin.mockResolvedValue({
        ok: true,
        data: { access_token: "new-access", refresh_token: "new-refresh" },
      });
      fetchCurrentUser.mockRejectedValue(new Error("Optipeople-login kunne ikke nås."));
      const res = await call("?next=%2Fperiode");
      expect(res.to).toBe("/auth/unavailable?next=%2Fperiode");
      expect(res.set).toEqual({
        ventisol_token: "new-access",
        ventisol_refresh: "new-refresh",
      });
    });
  });

  describe("refresh token refused", () => {
    it("clears nothing at first: it comes round again with a fingerprint of the token it tried", async () => {
      optipeopleLogin.mockResolvedValue({ ok: false, reason: "invalid" });
      const res = await call("?next=%2Fperiode");
      expect(res.to).toBe(`/auth/refresh?next=%2Fperiode&tried=${fp("old-refresh")}`);
      expect(res.set).toEqual({});
      // The fingerprint is not the token.
      expect(res.to).not.toContain("old-refresh");
    });

    it("ends the session when the cookie still holds the refused token", async () => {
      const res = await call(`?next=%2Fperiode&tried=${fp("old-refresh")}`);
      expect(res.to).toBe("/login?next=%2Fperiode");
      expect(res.set).toEqual(CLEARED);
      expect(optipeopleLogin).not.toHaveBeenCalled();
    });

    it("leaves the session alone when another tab has refreshed in the meantime", async () => {
      jar.set("ventisol_refresh", "new-refresh-from-other-tab");
      const res = await call(`?next=%2Fperiode&tried=${fp("old-refresh")}`);
      expect(res.to).toBe("/periode");
      expect(res.set).toEqual({});
      expect(optipeopleLogin).not.toHaveBeenCalled();
    });

    it("ends the session when the new token is refused by the user check", async () => {
      optipeopleLogin.mockResolvedValue({ ok: true, data: { access_token: "new-access" } });
      fetchCurrentUser.mockResolvedValue({ status: "unauthenticated" });
      const res = await call("?next=%2F");
      expect(res.to).toBe("/login");
      expect(res.set).toEqual(CLEARED);
    });
  });
});
