// The two-factor step of the login: what optipeopleLogin makes of the
// Optipeople API's answers, and the cookie that holds a login between its
// two steps. The network (fetch) and the cookie store are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();
const cookieOptions = new Map<string, Record<string, unknown>>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieJar.set(name, value);
      cookieOptions.set(name, options);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

const { clearPendingMfa, clearSessionCookies, getPendingMfa, optipeopleLogin, resendMfaCode, setPendingMfa } =
  await import("@/lib/auth");
const { MFA_COOKIE, SESSION_COOKIES } = await import("@/lib/auth-cookies");

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json(body, { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  cookieJar.clear();
  cookieOptions.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("optipeopleLogin with two-factor authentication", () => {
  it("answers with the challenge when the user must enter a code", async () => {
    answer({ mfa_required: true, mfa_token: "mfa-1", mfa_method: "email", masked_destination: "m***@optipeople.dk" });
    const result = await optipeopleLogin({ grant_type: "password", username: "morten", password: "pw" });
    expect(result).toEqual({
      ok: false,
      reason: "mfa",
      challenge: { mfaToken: "mfa-1", method: "email", maskedDestination: "m***@optipeople.dk" },
    });
  });

  it("takes a challenge without a method as an authenticator app", async () => {
    answer({ mfa_required: true, mfa_token: "mfa-1" });
    const result = await optipeopleLogin({ grant_type: "password", username: "morten", password: "pw" });
    expect(result).toMatchObject({ reason: "mfa", challenge: { method: "totp", maskedDestination: null } });
  });

  it("posts the code with the mfa grant and gets the session", async () => {
    const fetchMock = answer({ access_token: "tok", refresh_token: "ref", user_name: "morten" });
    const result = await optipeopleLogin({ grant_type: "mfa", mfa_token: "mfa-1", code: "123456", code_type: "otp" });
    expect(result).toEqual({ ok: true, data: { access_token: "tok", refresh_token: "ref", user_name: "morten" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/Authentication\/login$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "mfa",
      mfa_token: "mfa-1",
      code: "123456",
      code_type: "otp",
    });
  });

  it("a wrong or expired code is refused: the API answers 200 with errors and no token", async () => {
    answer({ data: {}, errors: [{ title: "mfa_token", message: "Your sign-in has expired." }], meta: {} });
    const result = await optipeopleLogin({ grant_type: "mfa", mfa_token: "x", code: "000000", code_type: "otp" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("a login without two-factor authentication is as before", async () => {
    answer({ access_token: "tok" });
    expect(await optipeopleLogin({ grant_type: "password", username: "a", password: "b" })).toEqual({
      ok: true,
      data: { access_token: "tok" },
    });
    answer({}, 401);
    expect(await optipeopleLogin({ grant_type: "password", username: "a", password: "b" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("resendMfaCode", () => {
  it("returns where the new code went", async () => {
    const fetchMock = answer({ data: { maskedDestination: "+45 ** ** 38 10" }, errors: [], meta: {} });
    expect(await resendMfaCode("mfa-1")).toBe("+45 ** ** 38 10");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/Authentication\/mfa\/resend$/);
    expect(JSON.parse(String(init?.body))).toEqual({ mfa_token: "mfa-1" });
  });

  it("is null when the backend sent it without saying where", async () => {
    answer({ data: {}, errors: [], meta: {} });
    expect(await resendMfaCode("mfa-1")).toBeNull();
  });

  it("is false when the backend refuses, also with 200 and errors", async () => {
    answer({ data: {}, errors: [{ title: "mfa_token", message: "expired" }], meta: {} });
    expect(await resendMfaCode("x")).toBe(false);
    answer({}, 500);
    expect(await resendMfaCode("x")).toBe(false);
  });
});

describe("the login between its two steps", () => {
  const pending = {
    id: "c-1",
    mfaToken: "mfa-1",
    method: "sms",
    maskedDestination: "+45 ** ** 38 10",
    email: "morten",
    remember: true,
  };

  it("is kept in a short-lived cookie the page's script cannot read", async () => {
    await setPendingMfa(pending);
    expect(await getPendingMfa()).toEqual(pending);
    expect(cookieOptions.get(MFA_COOKIE)).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600 });
  });

  it("is gone after cancel, and after log out", async () => {
    await setPendingMfa(pending);
    await clearPendingMfa();
    expect(await getPendingMfa()).toBeNull();

    await setPendingMfa(pending);
    cookieJar.set(SESSION_COOKIES.token, "tok");
    await clearSessionCookies();
    expect(await getPendingMfa()).toBeNull();
    expect(cookieJar.size).toBe(0);
  });

  it("a cookie that is not ours is no pending login", async () => {
    cookieJar.set(MFA_COOKIE, "not json");
    expect(await getPendingMfa()).toBeNull();
    cookieJar.set(MFA_COOKIE, JSON.stringify({ id: "c-1" }));
    expect(await getPendingMfa()).toBeNull();
  });

  it("is not a session cookie: it gives no access", () => {
    expect(Object.values(SESSION_COOKIES)).not.toContain(MFA_COOKIE);
  });
});
