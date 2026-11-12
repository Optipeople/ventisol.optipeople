"use client";

import Link from "next/link";
import { useActionState } from "react";
import { sendResetLink, type ForgotState } from "@/app/forgot-password/actions";
import { Button, Spinner } from "@optipeople/ui";
import {
  AuthCardHeader,
  authBodyTextClasses,
  authCardClasses,
  authErrorClasses,
  authInputClasses,
  authLinkClasses,
} from "@optipeople/ui/blocks";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(
    sendResetLink,
    undefined
  );

  return (
    <form action={action} className={authCardClasses}>
      <AuthCardHeader eyebrow="Ventisol rapporter" title="Nulstil din adgangskode" />

      {state && "sent" in state ? (
        <>
          <p className={authBodyTextClasses}>
            Hvis der findes en konto for <strong>{state.email}</strong>, har vi
            sendt et nulstillingslink.
          </p>
          <p className="pb-3 text-[14px] leading-[21px] text-black/70">
            Tjek din indbakke, og for en sikkerheds skyld også dit spamfilter.
            Linket er kun gyldigt i et stykke tid.
          </p>
          <div className="pt-3">
            <Link href="/login" className={`text-[14px] ${authLinkClasses}`}>
              Tilbage til login
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className={authBodyTextClasses}>
            Indtast e-mailen på din konto, så sender vi dig et link til at
            vælge en ny adgangskode.
          </p>

          <div className="flex flex-col gap-2 pb-2">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              disabled={pending}
              placeholder="E-mail"
              aria-label="E-mail"
              className={authInputClasses}
            />
          </div>

          {state && "error" in state && (
            <p role="alert" className={authErrorClasses}>
              {state.error}
            </p>
          )}

          <div className="pt-3">
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending && <Spinner className="mr-2 h-[14px] w-[14px]" />}
              {pending ? "Sender…" : "Send nulstillingslink"}
            </Button>
          </div>

          <p className="pt-6 pb-3 text-[14px] leading-[21px] text-black/90">
            <Link href="/login" className={authLinkClasses}>
              Tilbage til login
            </Link>
          </p>
        </>
      )}
    </form>
  );
}
