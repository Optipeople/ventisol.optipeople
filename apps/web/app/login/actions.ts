"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  clearPendingMfa,
  clearSessionCookies,
  fetchCurrentUser,
  getPendingMfa,
  isAllowedUser,
  optipeopleLogin,
  resendMfaCode as resendUpstream,
  setPendingMfa,
  setSessionCookies,
  type LoginResponse,
} from "@/lib/auth";
import {
  allowAttempt,
  clientIp,
  forgetAccountAttempts,
  loginLimits,
  mfaLimits,
  TOO_MANY_ATTEMPTS,
} from "@/lib/rate-limit";
import { safeNextPath } from "@/lib/site";

/**
 * The second step, as the form needs it. The mfa token itself stays in an
 * httpOnly cookie (see setPendingMfa); `id` only tells one challenge from the next.
 */
export type MfaStep = {
  id: string;
  /** "email" and "sms": a code was sent and can be sent again. Else an authenticator app. */
  method: string;
  maskedDestination: string | null;
};

/** The user name comes back so the field keeps it: React resets the form after an action. */
export type LoginState =
  | { error: string; email: string; mfa?: undefined }
  | { mfa: MfaStep; email: string; error?: undefined }
  | undefined;

export type MfaState = { error: string } | undefined;

/**
 * The tail of every login, with or without a code: authorization happens
 * before any cookie is set, so only super admins and Ventisol-account users
 * get a session at all. Returns the message to show, or redirects.
 */
async function finishLogin(
  data: LoginResponse,
  email: string,
  remember: boolean,
  next: string
): Promise<string> {
  const me = await fetchCurrentUser(data.access_token);
  if (me.status !== "ok") {
    return "Din bruger kunne ikke bekræftes. Prøv igen.";
  }
  if (!isAllowedUser(me.user)) {
    return "Din Optipeople-bruger har ikke adgang til Ventisol. Log ind med en bruger på Ventisol-kontoen.";
  }
  await clearPendingMfa();
  await setSessionCookies(data, me.user.email, remember);
  redirect(next);
}

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

  if (!result.ok && result.reason === "mfa") {
    // The password was right; the code is the second step, with its own limits (mfaLimits).
    await forgetAccountAttempts(loginLimits, ip, email);
    const id = randomUUID();
    await setPendingMfa({ ...result.challenge, id, email, remember });
    return {
      mfa: {
        id,
        method: result.challenge.method,
        maskedDestination: result.challenge.maskedDestination,
      },
      email,
    };
  }

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

  return { error: await finishLogin(result.data, email, remember, next), email };
}

const MFA_EXPIRED = "Bekræftelsen er udløbet. Gå tilbage og log ind igen.";

/** The second step: the code from the app, the e-mail or the SMS, or a recovery code. */
export async function verifyMfa(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const recovery = formData.get("recovery") === "1";
  const raw = String(formData.get("code") ?? "");
  const code = recovery ? raw.trim() : raw.replace(/\s/g, "");
  const next = safeNextPath(String(formData.get("next") ?? ""));

  const pending = await getPendingMfa();
  // Another tab logged in again since this form was shown: its code belongs to the other challenge.
  if (!pending || pending.id !== String(formData.get("challenge") ?? "")) return { error: MFA_EXPIRED };
  if (!code) return { error: recovery ? "Indtast en gendannelseskode." : "Indtast den 6-cifrede kode." };
  if (!recovery && !/^\d{6}$/.test(code)) return { error: "Indtast den 6-cifrede kode." };

  // A code is six digits, so it must not be guessable either.
  const ip = clientIp(await headers());
  if (!(await allowAttempt(mfaLimits, ip, pending.email))) {
    return { error: TOO_MANY_ATTEMPTS };
  }

  const result = await optipeopleLogin({
    grant_type: "mfa",
    mfa_token: pending.mfaToken,
    code,
    code_type: recovery ? "recovery_code" : "otp",
  });
  if (!result.ok) {
    return {
      error:
        result.reason === "unavailable"
          ? "Login-tjenesten er ikke tilgængelig lige nu. Prøv igen om lidt."
          : "Koden er ikke gyldig eller er udløbet.",
    };
  }

  await forgetAccountAttempts(mfaLimits, ip, pending.email);
  return { error: await finishLogin(result.data, pending.email, pending.remember, next) };
}

/** A new e-mail or SMS code. `destination` is where it went (masked), when upstream says. */
export async function resendMfa(): Promise<{ ok: boolean; destination?: string }> {
  const pending = await getPendingMfa();
  if (!pending) return { ok: false };
  // Counted like a code try, so the button cannot be used to flood a phone or a mailbox.
  const ip = clientIp(await headers());
  if (!(await allowAttempt(mfaLimits, ip, pending.email))) return { ok: false };
  const sent = await resendUpstream(pending.mfaToken);
  if (sent === false) return { ok: false };
  return sent ? { ok: true, destination: sent } : { ok: true };
}

/** "Tilbage til log ind": the half-done login is dropped. */
export async function cancelMfa(): Promise<void> {
  await clearPendingMfa();
}

export async function logout(): Promise<void> {
  // The Optipeople API has no logout or token revoke endpoint (checked in docs/api/optipeople.swagger.json), so the tokens are only dropped here.
  await clearSessionCookies();
  redirect("/login");
}
