"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  clearSessionCookies,
  fetchCurrentUser,
  isAllowedUser,
  optipeopleLogin,
  setSessionCookies,
} from "@/lib/auth";
import {
  allowAttempt,
  clientIp,
  forgetAccountAttempts,
  loginLimits,
  TOO_MANY_ATTEMPTS,
} from "@/lib/rate-limit";
import { safeNextPath } from "@/lib/site";

/** The user name comes back so the field keeps it: React resets the form after an action. */
export type LoginState = { error: string; email: string } | undefined;

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  // The field is called "email" but takes an OptiCloud user name as well.
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";
  // Where to go after signing in; only a path on this site.
  const next = safeNextPath(String(formData.get("next") ?? ""));
  if (!email || !password) {
    return { error: "Indtast brugernavn og adgangskode.", email };
  }

  // Before anything goes upstream. The same answer for every account, known
  // or not, so it says nothing about which ones exist.
  const ip = clientIp(await headers());
  if (!(await allowAttempt(loginLimits, ip, email))) {
    return { error: TOO_MANY_ATTEMPTS, email };
  }

  const result = await optipeopleLogin({
    grant_type: "password",
    username: email,
    password,
  });
  if (!result.ok) {
    return {
      error:
        result.reason === "invalid"
          ? "Forkert brugernavn eller adgangskode."
          : "Login-tjenesten er ikke tilgængelig lige nu. Prøv igen om lidt.",
      email,
    };
  }

  // The password was right: this client's earlier typos at the account no longer count.
  await forgetAccountAttempts(loginLimits, ip, email);

  // Authorization happens before any cookie is set: only super admins and
  // Ventisol-account users get a session at all.
  const me = await fetchCurrentUser(result.data.access_token);
  if (me.status !== "ok") {
    return { error: "Din bruger kunne ikke bekræftes. Prøv igen.", email };
  }
  if (!isAllowedUser(me.user)) {
    return {
      error:
        "Din Optipeople-bruger har ikke adgang til Ventisol. Log ind med en bruger på Ventisol-kontoen.",
      email,
    };
  }

  await setSessionCookies(result.data, me.user.email, remember);
  redirect(next);
}

export async function logout(): Promise<void> {
  // The Optipeople API has no logout or token revoke endpoint (checked in docs/api/optipeople.swagger.json), so the tokens are only dropped here.
  await clearSessionCookies();
  redirect("/login");
}
