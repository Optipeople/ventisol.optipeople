"use server";

import { headers } from "next/headers";
import { requestPasswordReset } from "@/lib/auth";
import {
  allowAttempt,
  clientIp,
  forgotLimits,
  TOO_MANY_ATTEMPTS,
} from "@/lib/rate-limit";
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

  // Counted per IP, and per IP and e-mail typed, known or not, so the answer
  // says nothing about which accounts exist.
  if (!(await allowAttempt(forgotLimits, clientIp(await headers()), email))) {
    return { error: TOO_MANY_ATTEMPTS };
  }

  // The backend emails a link back to this URL with ?token=...&email=....
  // Built from SITE_URL, never from the Host headers: a forged header would
  // otherwise send the reset token to someone else's site.
  const result = await requestPasswordReset(email, `${siteUrl()}/reset-password`);

  // A 4xx may only mean "no such e-mail". It gets the same neutral answer as
  // a mail that was sent, so the form cannot be used to find out who has an
  // account. Only a failure that has nothing to do with the e-mail (network,
  // timeout, 5xx) is shown as an error.
  return result === "unavailable"
    ? { error: "Noget gik galt. Prøv igen om lidt." }
    : { sent: true, email };
}
