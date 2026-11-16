// The page guards: requireUser, requireRole and requireCapability. OptiCloud
// (fetch), the cookies, the redirect and the portal user lookup are mocked,
// so this is about how the guards put them together, and above all what they
// do when the database is down.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalIdentity } from "@/lib/portal/users";

const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

let fixtures = false;

vi.mock("@/lib/fixtures-flag", async (original) => ({
  ...(await original<typeof import("@/lib/fixtures-flag")>()),
  fixturesEnabled: () => fixtures,
}));

const resolvePortalUser =
  vi.fn<(user: { id: string }, accountId: string, options?: { superAdmin?: boolean }) => Promise<PortalIdentity>>();

vi.mock("@/lib/portal/users", () => ({
  resolvePortalUser: (user: { id: string }, accountId: string, options?: { superAdmin?: boolean }) =>
    resolvePortalUser(user, accountId, options),
}));

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
process.env.VENTISOL_ACCOUNT_ID = ACCOUNT;

const { requireCapability, requireRole, requireUser, getPortalAccess, noRolePath } = await import("@/lib/auth");
const { SESSION_COOKIES } = await import("@/lib/auth-cookies");
const { FIXTURE_ACCOUNT_ID, FIXTURE_USER } = await import("@/lib/fixtures-flag");

/** Sign in as a Ventisol user, or as a super administrator from another account. */
function signIn(options: { superAdmin?: boolean } = {}) {
  cookieJar.set(SESSION_COOKIES.token, "tok");
  const fetchMock = vi.fn(async () =>
    Response.json({
      data: {
        id: "u-anna",
        email: "anna@ventisol.dk",
        name: "Anna",
        permissionName: options.superAdmin ? "SuperAdministrator" : "User",
        accountId: options.superAdmin ? "99999999-9999-4999-8999-999999999999" : ACCOUNT,
        accountName: "Ventisol",
      },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function hasRole(role: PortalIdentity["role"]) {
  resolvePortalUser.mockResolvedValue({
    role,
    claims: { accountId: ACCOUNT, optiUserId: "u-anna", role },
    source: "row",
  });
}

async function redirectOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof Redirect) return err.to;
    throw err;
  }
  throw new Error("expected a redirect");
}

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cookieJar.clear();
  fixtures = false;
  resolvePortalUser.mockReset();
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  error.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requireUser", () => {
  it("fills in the portal role and the claims", async () => {
    signIn();
    hasRole("planner");
    const ctx = await requireUser("/periode");
    expect(ctx).toMatchObject({
      user: { id: "u-anna", email: "anna@ventisol.dk" },
      token: "tok",
      accountId: ACCOUNT,
      currentPath: "/periode",
      role: "planner",
      claims: { accountId: ACCOUNT, optiUserId: "u-anna", role: "planner" },
      roleDegraded: false,
    });
    expect(resolvePortalUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u-anna" }),
      ACCOUNT,
      { superAdmin: false }
    );
  });

  it("tells the lookup when the user is a super administrator, with Ventisol's account", async () => {
    signIn({ superAdmin: true });
    hasRole("admin");
    await requireUser("/");
    expect(resolvePortalUser).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { superAdmin: true });
  });

  it("sends a visitor without a session to the login page, without touching the database", async () => {
    expect(await redirectOf(requireUser("/periode"))).toBe("/login?next=%2Fperiode");
    expect(resolvePortalUser).not.toHaveBeenCalled();
    expect(await getPortalAccess()).toBeNull();
  });
});

describe("when the database is down", () => {
  it("a signed-in user still gets in, as a viewer, and the error is logged", async () => {
    signIn();
    resolvePortalUser.mockRejectedValue(new Error("connection refused"));
    const ctx = await requireUser("/");
    expect(ctx).toMatchObject({
      role: "viewer",
      claims: { accountId: ACCOUNT, optiUserId: "u-anna", role: "viewer" },
      roleDegraded: true,
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("pages a viewer may open still open", async () => {
    signIn();
    resolvePortalUser.mockRejectedValue(new Error("connection refused"));
    await expect(requireCapability("/stationer", "reports.view")).resolves.toMatchObject({ role: "viewer" });
  });

  it("anything above viewer is refused with the try-again page", async () => {
    signIn();
    resolvePortalUser.mockRejectedValue(new Error("connection refused"));
    expect(await redirectOf(requireCapability("/ledelse", "ledelse.view"))).toBe("/ingen-adgang?grund=database");
    expect(await redirectOf(requireRole("/indstillinger", "admin", "planner"))).toBe(
      "/ingen-adgang?grund=database"
    );
  });

  it("a super administrator stays admin", async () => {
    signIn({ superAdmin: true });
    resolvePortalUser.mockRejectedValue(new Error("connection refused"));
    const ctx = await requireCapability("/indstillinger", "users.manage");
    expect(ctx).toMatchObject({ role: "admin", roleDegraded: false });
  });

  it("a database that hangs is treated the same, after a timeout", async () => {
    signIn();
    resolvePortalUser.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = requireUser("/");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ role: "viewer", roleDegraded: true });
  });
});

describe("requireRole and requireCapability", () => {
  it("let a role in that is listed", async () => {
    signIn();
    hasRole("ledelse");
    await expect(requireRole("/ledelse", "admin", "ledelse")).resolves.toMatchObject({ role: "ledelse" });
    await expect(requireCapability("/ledelse", "ledelse.view")).resolves.toMatchObject({ role: "ledelse" });
  });

  it("send a role that is not to the no-access page", async () => {
    signIn();
    hasRole("planner");
    expect(await redirectOf(requireRole("/ledelse", "admin", "ledelse"))).toBe("/ingen-adgang?grund=rolle");
    expect(await redirectOf(requireCapability("/ledelse", "ledelse.view"))).toBe("/ingen-adgang?grund=rolle");
    expect(await redirectOf(requireCapability("/indstillinger/brugere", "users.manage"))).toBe(
      "/ingen-adgang?grund=rolle"
    );
  });

  it("still send a visitor without a session to the login page first", async () => {
    expect(await redirectOf(requireRole("/ledelse", "admin"))).toBe("/login?next=%2Fledelse");
  });

  it("noRolePath", () => {
    expect(noRolePath(false)).toBe("/ingen-adgang?grund=rolle");
    expect(noRolePath(true)).toBe("/ingen-adgang?grund=database");
  });
});

describe("fixture mode", () => {
  it("is an admin with fixed fake ids, with no network and no database", async () => {
    fixtures = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = await requireCapability("/indstillinger", "users.manage");
    expect(ctx).toMatchObject({
      user: FIXTURE_USER,
      token: "",
      accountId: "fixtures",
      role: "admin",
      claims: { accountId: FIXTURE_ACCOUNT_ID, optiUserId: FIXTURE_USER.id, role: "admin" },
      roleDegraded: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolvePortalUser).not.toHaveBeenCalled();
  });
});
