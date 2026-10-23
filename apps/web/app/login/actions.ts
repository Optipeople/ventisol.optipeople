"use server";

import { redirect } from "next/navigation";
import {
  clearSessionCookies,
  fetchCurrentUser,
  isAllowedUser,
  optipeopleLogin,
  setSessionCookies,
} from "@/lib/auth";

export type LoginState = { error: string } | undefined;

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";
  if (!email || !password) {
    return { error: "Indtast din e-mail og adgangskode." };
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
          ? "Forkert e-mail eller adgangskode."
          : "Login-tjenesten er ikke tilgængelig lige nu. Prøv igen om lidt.",
    };
  }

  // Authorization happens before any cookie is set: only super admins and
  // Ventisol-account users get a session at all.
  const me = await fetchCurrentUser(result.data.access_token);
  if (me.status !== "ok") {
    return { error: "Din bruger kunne ikke bekræftes. Prøv igen." };
  }
  if (!isAllowedUser(me.user)) {
    return {
      error:
        "Din Optipeople-bruger har ikke adgang til Ventisol. Log ind med en bruger på Ventisol-kontoen.",
    };
  }

  await setSessionCookies(result.data, me.user.email, remember);
  redirect("/");
}

export async function logout(): Promise<void> {
  await clearSessionCookies();
  redirect("/login");
}
