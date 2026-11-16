// Optipeople auth for the Ventisol reports site. Adapted from optipeople.vola.
//
// OAuth2 password grant against the Optipeople backend, identity and role
// resolved via /api/User/GetCurrentUser, tokens in httpOnly cookies so server
// components can read the session and call the API on the user's behalf.
//
// Unlike vola (which reads through the External API with an access key), this
// site reads the scans with the signed-in user's own bearer token, so the
// token is also the data credential. It never reaches the browser.
//
// Access policy, in two steps:
//
// 1. Who gets in at all (identity, OptiCloud): super administrators, plus any
//    user in the Ventisol account (VENTISOL_ACCOUNT_ID).
// 2. What they may do (authorisation, the portal): a portal role from
//    app.portal_users, resolved once per request by getPortalAccess(). The
//    rules are in lib/portal/users.ts, the capabilities in
//    lib/portal/roles.ts. Pages call requireUser, requireRole or
//    requireCapability; nothing compares roles by hand.
//
// When the database cannot be reached, a valid OptiCloud login still gets
// in: a super administrator as admin (that never needed the database),
// everyone else as viewer for that request, with `roleDegraded` set and the
// error logged. So pages that need no more than a viewer keep working, and
// requireRole / requireCapability refuse everything above viewer with a "try
// again" page instead of a silent lock-out or a silent promotion.

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIES } from "@/lib/auth-cookies";
import type { Claims } from "@/lib/db";
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_ROLE,
  FIXTURE_USER,
  fixturesEnabled,
} from "@/lib/fixtures-flag";
import {
  ADMIN_ROLE,
  can,
  DEFAULT_ROLE,
  hasAnyRole,
  type Capability,
  type PortalRole,
} from "@/lib/portal/roles";
import { resolvePortalUser } from "@/lib/portal/users";
import "@/lib/fixture-seeds";

/** Base URL of the Optipeople API (login and data). */
export const API_URL = (
  process.env.OPTIPEOPLE_API_URL ?? "https://api.optipeople.dk"
).replace(/\/+$/, "");

/** Ventisol's OptiCloud account id. Required: it gates access and is the account read. */
export function ventisolAccountId(): string | null {
  const id = process.env.VENTISOL_ACCOUNT_ID?.trim().toLowerCase();
  return id ? id : null;
}

/**
 * Longest wait for one answer from the Optipeople API. Without it a hung
 * upstream would hold the request (and the user) until the platform gives
 * up. A timeout is handled like any other network failure: "unavailable".
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

const upstreamTimeout = () => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

// Stable code id; the human label ("Super Administrator") can drift.
const SUPER_ADMIN_PERMISSION = "SuperAdministrator";

export type LoginResponse = {
  access_token: string;
  refresh_token?: string;
  user_name?: string;
  expires_in?: number;
};

export type LoginResult =
  | { ok: true; data: LoginResponse }
  | { ok: false; reason: "invalid" | "unavailable" };

/**
 * POST /api/Authentication/login, password or refresh_token grant. This is
 * the one response not wrapped in {data, errors, meta}.
 */
export async function optipeopleLogin(
  body: Record<string, string>
): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/Authentication/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: upstreamTimeout(),
    });
  } catch (err) {
    console.error("optipeopleLogin: upstream unreachable:", err);
    return { ok: false, reason: "unavailable" };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: res.status === 400 || res.status === 401 ? "invalid" : "unavailable",
    };
  }

  // The body can still time out or be cut off after the headers arrived.
  let data: LoginResponse;
  try {
    data = (await res.json()) as LoginResponse;
  } catch (err) {
    console.error("optipeopleLogin: unreadable response:", err);
    return { ok: false, reason: "unavailable" };
  }
  if (!data?.access_token) return { ok: false, reason: "invalid" };
  return { ok: true, data };
}

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  roleName: string | null;
  permissionName: string | null;
  accountId: string | null;
  /** Human name of the Optipeople account, shown in the user menu. */
  accountName: string | null;
};

type CurrentUserResult =
  | { status: "ok"; user: SessionUser }
  | { status: "unauthenticated" };

/**
 * Resolve the token's user via GET /api/User/GetCurrentUser. The token is an
 * opaque bearer string: identity and role always come from this call, never
 * from decoding the token.
 */
export async function fetchCurrentUser(
  token: string
): Promise<CurrentUserResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/User/GetCurrentUser`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: upstreamTimeout(),
    });
  } catch (err) {
    console.error("fetchCurrentUser: upstream unreachable:", err);
    throw new Error("Optipeople-login kunne ikke nås.");
  }

  // This backend uses 401 for both authentication and authorization failures.
  if (res.status === 401 || res.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!res.ok) {
    throw new Error(`Optipeople auth error (${res.status})`);
  }

  // Responses are wrapped in { data, errors, meta }; the user is flat inside
  // data with role fields hoisted to the top level.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("Optipeople auth returned an unexpected response.");
  }
  const data =
    body && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : null;
  if (!data || typeof data !== "object") return { status: "unauthenticated" };

  const obj = data as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const email = typeof obj.email === "string" ? obj.email : null;
  if (!id || !email) return { status: "unauthenticated" };

  return {
    status: "ok",
    user: {
      id,
      email,
      name: typeof obj.name === "string" ? obj.name : null,
      roleName: typeof obj.roleName === "string" ? obj.roleName : null,
      permissionName:
        typeof obj.permissionName === "string" ? obj.permissionName : null,
      accountId:
        typeof obj.accountId === "string" && obj.accountId.length > 0
          ? obj.accountId
          : null,
      accountName:
        typeof obj.accountName === "string" && obj.accountName.length > 0
          ? obj.accountName
          : null,
    },
  };
}

export function isSuperAdmin(user: SessionUser): boolean {
  return user.permissionName === SUPER_ADMIN_PERMISSION;
}

/** Super admins, or any user in the Ventisol account. */
export function isAllowedUser(user: SessionUser): boolean {
  const ventisol = ventisolAccountId();
  return (
    isSuperAdmin(user) ||
    (ventisol !== null && user.accountId?.toLowerCase() === ventisol)
  );
}

/**
 * The account whose scans this user reads. Ventisol users read their own
 * account; a super admin from another account reads Ventisol's.
 */
export function dataAccountId(): string {
  const ventisol = ventisolAccountId();
  if (ventisol) return ventisol;
  // Without the env var only a super admin gets this far (isAllowedUser),
  // and reading their own account would show the wrong data.
  throw new Error(
    "VENTISOL_ACCOUNT_ID er ikke sat. Tilføj den i miljøvariablerne."
  );
}

export type Session =
  | { status: "ok"; user: SessionUser; token: string }
  | { status: "unauthenticated" }
  /** Token rejected but a refresh token exists: worth a refresh attempt. */
  | { status: "expired" }
  /** Valid Optipeople user, but not a super admin and not in the Ventisol account. */
  | { status: "forbidden"; user: SessionUser };

export const getSession = cache(async (): Promise<Session> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIES.token)?.value;
  if (!token) return { status: "unauthenticated" };

  const result = await fetchCurrentUser(token);
  if (result.status === "unauthenticated") {
    return store.get(SESSION_COOKIES.refresh)?.value
      ? { status: "expired" }
      : { status: "unauthenticated" };
  }
  return isAllowedUser(result.user)
    ? { status: "ok", user: result.user, token }
    : { status: "forbidden", user: result.user };
});

/** The portal side of a signed-in user: the role and how to query as them. */
export type PortalAccess = {
  role: PortalRole;
  /** Pass to withUser() from @/lib/db to run queries as this user. */
  claims: Claims;
  /**
   * True when the role could not be read from the database and a fallback is
   * used instead (viewer, or admin for a super administrator). Such a user is
   * refused by requireRole and requireCapability for anything above viewer.
   */
  roleDegraded: boolean;
};

/** Longest wait for the role read before the fallback is used. */
const ROLE_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
      ms
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * The portal role of the signed-in user, or null without a valid session.
 * Resolved once per request (React cache), so the layout and the page share
 * one database read. Fixture mode: admin with fixed fake ids, no network and
 * no database.
 */
export const getPortalAccess = cache(async (): Promise<PortalAccess | null> => {
  if (fixturesEnabled()) {
    return {
      role: FIXTURE_ROLE,
      claims: {
        accountId: FIXTURE_ACCOUNT_ID,
        optiUserId: FIXTURE_USER.id,
        role: FIXTURE_ROLE,
      },
      roleDegraded: false,
    };
  }
  const session = await getSession();
  if (session.status !== "ok") return null;

  const accountId = dataAccountId();
  const superAdmin = isSuperAdmin(session.user);
  try {
    const identity = await withTimeout(
      resolvePortalUser(session.user, accountId, { superAdmin }),
      ROLE_TIMEOUT_MS
    );
    return { role: identity.role, claims: identity.claims, roleDegraded: false };
  } catch (err) {
    // See the header: never a silent lock-out, never a silent promotion.
    const role = superAdmin ? ADMIN_ROLE : DEFAULT_ROLE;
    console.error(
      `getPortalAccess: the portal role of ${session.user.id} could not be read, continuing as ${role}:`,
      err
    );
    return {
      role,
      claims: { accountId, optiUserId: session.user.id, role },
      roleDegraded: !superAdmin,
    };
  }
});

/** What a protected page needs: who is signed in and how to read the data. */
export type AuthContext = PortalAccess & {
  user: SessionUser;
  /** Bearer token for the data reads. Empty in fixture mode. */
  token: string;
  /** The account the scans are read from. */
  accountId: string;
  /** The page being rendered, for the refresh flow's return trip. */
  currentPath: string;
};

/**
 * Page guard: call at the top of every protected page. Redirects to the
 * refresh flow on an expired token and to /login otherwise. The proxy only
 * does an optimistic cookie check; this is the real enforcement.
 */
export async function requireUser(currentPath: string): Promise<AuthContext> {
  if (fixturesEnabled()) {
    const access = (await getPortalAccess())!;
    return { ...access, user: FIXTURE_USER, token: "", accountId: "fixtures", currentPath };
  }
  const session = await getSession();
  switch (session.status) {
    case "ok": {
      // Not null: the session is ok, and both reads are cached per request.
      const access = (await getPortalAccess())!;
      return {
        ...access,
        user: session.user,
        token: session.token,
        accountId: dataAccountId(),
        currentPath,
      };
    }
    case "expired":
      redirect(refreshPath(currentPath));
    case "forbidden":
      redirect("/login?error=forbidden");
    default:
      redirect(loginPath(currentPath));
  }
}

/**
 * Where a signed-in user lands when their portal role does not cover a page.
 * `database` instead of `rolle` when the role is only a fallback because the
 * database could not be reached: then the answer is "try again", not "ask an
 * administrator".
 */
export function noRolePath(roleDegraded: boolean): string {
  return `/ingen-adgang?grund=${roleDegraded ? "database" : "rolle"}`;
}

/**
 * Page guard for pages only some roles may open: requireUser, then the role
 * has to be one of `roles`. Others are sent to /ingen-adgang. Prefer
 * requireCapability, which says what the page needs instead of who has it.
 */
export async function requireRole(
  currentPath: string,
  ...roles: PortalRole[]
): Promise<AuthContext> {
  const ctx = await requireUser(currentPath);
  if (!hasAnyRole(ctx.role, roles)) redirect(noRolePath(ctx.roleDegraded));
  return ctx;
}

/** Page guard: requireUser, then the role has to have `capability`. */
export async function requireCapability(
  currentPath: string,
  capability: Capability
): Promise<AuthContext> {
  const ctx = await requireUser(currentPath);
  if (!can(ctx.role, capability)) redirect(noRolePath(ctx.roleDegraded));
  return ctx;
}

/**
 * The refresh flow for a page. `retry` marks a second refusal right after a
 * refresh: /auth/refresh then ends the session instead of trying again.
 */
export function refreshPath(currentPath: string, retry = false): string {
  return `/auth/refresh?next=${encodeURIComponent(currentPath)}${retry ? "&retry=1" : ""}`;
}

/** The login page, coming back to `currentPath` after signing in. */
export function loginPath(currentPath: string, error?: string): string {
  const qs = new URLSearchParams();
  if (error) qs.set("error", error);
  if (currentPath && currentPath !== "/") qs.set("next", currentPath);
  return qs.size ? `/login?${qs}` : "/login";
}

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

/**
 * "Husk mig" gives persistent cookies (they outlive the access token on
 * purpose: token expiry is enforced upstream and triggers the refresh flow).
 * Otherwise session cookies that die with the browser.
 */
export function cookieOptions(persistent: boolean) {
  return persistent
    ? { ...BASE_COOKIE_OPTIONS, maxAge: 60 * 60 * 24 * 30 }
    : BASE_COOKIE_OPTIONS;
}

export async function setSessionCookies(
  data: LoginResponse,
  email: string,
  remember: boolean
): Promise<void> {
  const store = await cookies();
  const options = cookieOptions(remember);
  store.set(SESSION_COOKIES.token, data.access_token, options);
  if (data.refresh_token) {
    store.set(SESSION_COOKIES.refresh, data.refresh_token, options);
  }
  store.set(SESSION_COOKIES.email, data.user_name ?? email, options);
  if (remember) {
    store.set(SESSION_COOKIES.persist, "1", options);
  } else {
    store.delete(SESSION_COOKIES.persist);
  }
  store.delete(SESSION_COOKIES.refreshed);
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  for (const name of Object.values(SESSION_COOKIES)) store.delete(name);
}

// --- Password reset (same Optipeople endpoints as vola) ---

/**
 * "sent": the backend took the request. "rejected": it answered 4xx, which
 * may only mean the e-mail is unknown, so callers must not tell it apart
 * from "sent" in what they show. "unavailable": network failure, timeout or
 * 5xx.
 */
export type PasswordResetRequest = "sent" | "rejected" | "unavailable";

export async function requestPasswordReset(
  email: string,
  resetUrl: string
): Promise<PasswordResetRequest> {
  try {
    const res = await fetch(
      `${API_URL}/api/IncomacAuthentication/ForgotPassword`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, resetUrl }),
        cache: "no-store",
        signal: upstreamTimeout(),
      }
    );
    if (res.ok) return "sent";
    return res.status >= 400 && res.status < 500 ? "rejected" : "unavailable";
  } catch (err) {
    console.error("requestPasswordReset: upstream unreachable:", err);
    return "unavailable";
  }
}

export async function setNewForgottenPassword(args: {
  token: string;
  email: string;
  newPassword: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/User/SetNewForgottenPassword`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: upstreamTimeout(),
    });
    return res.ok;
  } catch (err) {
    console.error("setNewForgottenPassword: upstream unreachable:", err);
    return false;
  }
}
