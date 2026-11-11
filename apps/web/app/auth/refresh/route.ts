// GET /auth/refresh?next=<path>[&retry=1]: exchanges the refresh token for a
// new access token, then sends the user back where they came from. Reached
// when requireUser() finds an expired access token, or a data read gets a 401.
//
// How it ends:
// - The backend refuses the refresh token ("invalid"): the session is over,
//   the cookies are cleared and the user lands on /login. That also breaks
//   potential redirect loops.
// - The backend cannot be reached, times out or answers 5xx ("unavailable"):
//   the cookies stay. A short OptiCloud outage must not log out someone with
//   a 30 day session. The user lands on /auth/unavailable and can try again.
// - retry=1 means a data read was refused again right after a refresh:
//   another refresh would only loop, so the session ends. It only counts
//   while the ventisol_refreshed cookie this route set is present, so a link
//   on another site cannot log anyone out with it.
//
// Two tabs can refresh at the same moment. If the backend rotates refresh
// tokens, the slower tab is refused with a token the faster tab has already
// replaced. So a refusal does not clear anything at once: the browser is sent
// round one more time with a fingerprint of the refused token (`tried`), and
// the session only ends if the cookie still holds that same token.

import { createHash } from "node:crypto";
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

/** Names a refresh token in a URL without giving it away. */
function fingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // Only paths on this origin: never redirect off-site.
  const next = safeNextPath(params.get("next"), request.url);
  const tried = params.get("tried");

  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));

  /** The session is over: clear it and show the login. */
  const end = (error?: string) => {
    const res = to(loginPath(next, error));
    for (const name of Object.values(SESSION_COOKIES)) res.cookies.delete(name);
    return res;
  };

  /** OptiCloud is down, not the session: keep the cookies. */
  const unavailable = () =>
    to(`/auth/unavailable?next=${encodeURIComponent(next)}`);

  const store = await cookies();

  const justRefreshed = Boolean(store.get(SESSION_COOKIES.refreshed)?.value);
  if (params.get("retry") === "1" && justRefreshed) return end("session");

  const refreshToken = store.get(SESSION_COOKIES.refresh)?.value;
  const email = store.get(SESSION_COOKIES.email)?.value;
  if (!refreshToken || !email) return end();

  // Second leg after a refusal: these are the browser's cookies as they are
  // now. A different token means another tab refreshed in the meantime, so
  // that session is left alone and the page gets another go.
  if (tried) {
    return tried === fingerprint(refreshToken) ? end() : to(next);
  }

  // grant_type=refresh_token needs the username as well.
  const result = await optipeopleLogin({
    grant_type: "refresh_token",
    username: email,
    refresh_token: refreshToken,
  });
  if (!result.ok) {
    if (result.reason === "unavailable") return unavailable();
    const again = new URLSearchParams({ next, tried: fingerprint(refreshToken) });
    return to(`/auth/refresh?${again}`);
  }

  // Keep the persistence the user chose at login ("Husk mig").
  const options = cookieOptions(
    store.get(SESSION_COOKIES.persist)?.value === "1"
  );
  const withTokens = (res: NextResponse) => {
    res.cookies.set(SESSION_COOKIES.token, result.data.access_token, options);
    if (result.data.refresh_token) {
      res.cookies.set(SESSION_COOKIES.refresh, result.data.refresh_token, options);
    }
    return res;
  };

  // Validate the new token (and re-check authorization) before redirecting
  // back; otherwise a token the backend rejects would bounce the user
  // between the page and this route forever.
  let me: Awaited<ReturnType<typeof fetchCurrentUser>>;
  try {
    me = await fetchCurrentUser(result.data.access_token);
  } catch {
    // The refresh itself went through, so the old refresh token may be used
    // up: the new tokens must be kept or the session is lost anyway. Nothing
    // is granted by this, every page checks the user again (requireUser).
    return withTokens(unavailable());
  }
  if (me.status !== "ok") return end();

  const target = isAllowedUser(me.user) ? next : "/login?error=forbidden";
  const res = withTokens(to(target));
  res.cookies.set(SESSION_COOKIES.email, me.user.email, options);
  res.cookies.set(SESSION_COOKIES.refreshed, "1", {
    ...cookieOptions(false),
    maxAge: REFRESHED_SECONDS,
  });
  return res;
}
