"use server";

import { requestPasswordReset } from "@/lib/auth";
import { siteUrl } from "@/lib/site";

export type ForgotState =
  | { sent: true; email: string }
  | { error: string }
  | undefined;

export async function sendResetLink(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Indtast din e-mail." };

  // The backend emails a link back to this URL with ?token=...&email=....
  // Built from SITE_URL, never from the Host headers: a forged header would
  // otherwise send the reset token to someone else's site.
  const ok = await requestPasswordReset(email, `${siteUrl()}/reset-password`);

  return ok ? { sent: true, email } : { error: "Noget gik galt. Prøv igen." };
}
