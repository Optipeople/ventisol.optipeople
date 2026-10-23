// GET /auth/refresh?next=<path>[&retry=1]: exchanges the refresh token for a
// new access token, then sends the user back where they came from. Reached
// when requireUser() finds an expired access token, or a data read gets a 401.
// Any failure clears the session and lands on /login, which also breaks
// potential redirect loops. retry=1 means a data read was refused again right
// after a refresh: another refresh would only loop, so the session ends.
// Copied from optipeople.vola.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIES } from "@/lib/auth-cookies";
import {
  cookieOptions,
  fetchCurrentUser,
  isAllowedUser,
  loginPath,
  optipeopleLogin,
} from "@/lib/auth";
import { safeNextPath } from "@/lib/site";

/** How long a refresh counts as "just now" for the loop breaker. */
const REFRESHED_SECONDS = 60;

export async function GET(request: NextRequest) {
  // Only paths on this origin: never redirect off-site.
  const next = safeNextPath(request.nextUrl.searchParams.get("next"), request.url);
  const retry = request.nextUrl.searchParams.get("retry") === "1";

  const fail = (error?: string) => {
    const res = NextResponse.redirect(new URL(loginPath(next, error), request.url));
    for (const name of Object.values(SESSION_COOKIES)) res.cookies.delete(name);
    return res;
  };

  if (retry) return fail("session");

  const store = await cookies();
  const refreshToken = store.get(SESSION_COOKIES.refresh)?.value;
  const email = store.get(SESSION_COOKIES.email)?.value;
  if (!refreshToken || !email) return fail();

  // grant_type=refresh_token needs the username as well.
  const result = await optipeopleLogin({
    grant_type: "refresh_token",
    username: email,
    refresh_token: refreshToken,
  });
  if (!result.ok) return fail();

  // Validate the new token (and re-check authorization) before redirecting
  // back; otherwise a token the backend rejects would bounce the user
  // between the page and this route forever.
  const me = await fetchCurrentUser(result.data.access_token);
  if (me.status !== "ok") return fail();

  // Keep the persistence the user chose at login ("Husk mig").
  const options = cookieOptions(
    store.get(SESSION_COOKIES.persist)?.value === "1"
  );

  const target = isAllowedUser(me.user) ? next : "/login?error=forbidden";
  const res = NextResponse.redirect(new URL(target, request.url));
  res.cookies.set(SESSION_COOKIES.token, result.data.access_token, options);
  if (result.data.refresh_token) {
    res.cookies.set(SESSION_COOKIES.refresh, result.data.refresh_token, options);
  }
  res.cookies.set(SESSION_COOKIES.email, me.user.email, options);
  res.cookies.set(SESSION_COOKIES.refreshed, "1", {
    ...cookieOptions(false),
    maxAge: REFRESHED_SECONDS,
  });
  return res;
}
