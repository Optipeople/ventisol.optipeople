"use server";

import { setNewForgottenPassword } from "@/lib/auth";

const MIN_PASSWORD_LENGTH = 8;

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
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn.` };
  }
  if (password !== confirm) {
    return { error: "De to adgangskoder er ikke ens." };
  }

  const ok = await setNewForgottenPassword({ token, email, newPassword: password });
  return ok ? { done: true } : { error: "Noget gik galt. Prøv igen." };
}
