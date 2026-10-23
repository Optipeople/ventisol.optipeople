"use server";

import { headers } from "next/headers";
import { requestPasswordReset } from "@/lib/auth";

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
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const ok = await requestPasswordReset(email, `${proto}://${host}/reset-password`);

  return ok ? { sent: true, email } : { error: "Noget gik galt. Prøv igen." };
}
