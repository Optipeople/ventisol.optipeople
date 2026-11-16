"use server";

import { headers } from "next/headers";
import { setNewForgottenPassword } from "@/lib/auth";
import {
  allowAttempt,
  clientIp,
  resetLimits,
  TOO_MANY_ATTEMPTS,
} from "@/lib/rate-limit";

// Mirrors the OptiCloud backend policy: at least 10 characters with a
// lowercase letter, an uppercase letter, a digit and a special character.
// The backend validates again, so drift here only costs a vaguer error.
// reset-form.tsx repeats the 10 in minLength and in its hint text.
const MIN_PASSWORD_LENGTH = 10;

function meetsPasswordPolicy(password: string): boolean {
  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^a-zA-Z0-9]/.test(password)
  );
}

export type ResetState = { done: true } | { error: string } | undefined;

export async function resetPassword(
  _prev: ResetState,
  formData: FormData
): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token || !email) {
    return { error: "Dette nulstillingslink er ikke gyldigt." };
  }
  if (!meetsPasswordPolicy(password)) {
    return {
      error: `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn og indeholde et stort bogstav, et lille bogstav, et tal og et specialtegn.`,
    };
  }
  if (password !== confirm) {
    return { error: "De to adgangskoder er ikke ens." };
  }

  // Only tries that go upstream are counted, so a typo in the form above
  // costs nothing. Stops guessing at reset tokens for an e-mail.
  if (!(await allowAttempt(resetLimits, clientIp(await headers()), email))) {
    return { error: TOO_MANY_ATTEMPTS };
  }

  const ok = await setNewForgottenPassword({ token, email, newPassword: password });
  return ok ? { done: true } : { error: "Noget gik galt. Prøv igen." };
}
