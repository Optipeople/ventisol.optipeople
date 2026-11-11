// Optimistic auth check: anyone without a session cookie is sent to /login
// before any page renders. This is only a fast pre-filter; the real
// enforcement (token validation + Ventisol account check) happens in
// requireUser()/getSession() in lib/auth.ts, close to the data.
// Copied from optipeople.vola.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIES } from "@/lib/auth-cookies";
import { fixturesEnabled } from "@/lib/fixtures-flag";

const PUBLIC_PATHS = [
  "/login",
  "/auth/refresh",
  "/auth/unavailable",
  "/forgot-password",
  "/reset-password",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  // Dev-only fixture mode has no login on the report pages.
  if (isPublic || fixturesEnabled()) return NextResponse.next();

  const hasToken = Boolean(request.cookies.get(SESSION_COOKIES.token)?.value);
  if (!hasToken) {
    // Back to this page after signing in (the login page checks `next` again).
    const login = new URL("/login", request.nextUrl);
    const here = `${pathname}${request.nextUrl.search}`;
    if (here !== "/") login.searchParams.set("next", here);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static files (paths with a dot).
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
