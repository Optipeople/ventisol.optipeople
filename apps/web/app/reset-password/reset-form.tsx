"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPassword, type ResetState } from "@/app/reset-password/actions";
import { Button, Spinner } from "@optipeople/ui";
import {
  AuthCardHeader,
  authBodyTextClasses,
  authCardClasses,
  authErrorClasses,
  authInputClasses,
  authLinkClasses,
} from "@optipeople/ui/blocks";

export function ResetPasswordForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [state, action, pending] = useActionState<ResetState, FormData>(
    resetPassword,
    undefined
  );

  const linkInvalid = !token || !email;

  return (
    <form action={action} className={authCardClasses}>
      <AuthCardHeader eyebrow="Ventisol rapporter" title="Vælg en ny adgangskode" />

      {state && "done" in state ? (
        <>
          <p className={authBodyTextClasses}>
            Din adgangskode er opdateret. Du kan nu logge ind med den nye
            adgangskode.
          </p>
          <div className="pt-3">
            <Link href="/login" className={`text-[14px] ${authLinkClasses}`}>
              Gå til login
            </Link>
          </div>
        </>
      ) : linkInvalid ? (
        <>
          <p className="pb-3 text-[14px] leading-[21px] text-[var(--color-error)]">
            Dette nulstillingslink er ikke gyldigt.
          </p>
          <p className="pb-3 text-[14px] leading-[21px] text-black/70">
            Linket kan være udløbet eller allerede brugt.
          </p>
          <div className="pt-3">
            <Link href="/forgot-password" className={`text-[14px] ${authLinkClasses}`}>
              Bed om et nyt nulstillingslink
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className={authBodyTextClasses}>
            Vælg en ny adgangskode til <strong>{email}</strong>.
          </p>

          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="email" value={email} />

          <div className="flex flex-col gap-2 pb-2">
            <input
              id="new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              disabled={pending}
              placeholder="Ny adgangskode"
              aria-label="Ny adgangskode"
              aria-describedby="password-hint"
              className={authInputClasses}
            />
            <input
              id="confirm-password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              disabled={pending}
              placeholder="Gentag ny adgangskode"
              aria-label="Gentag ny adgangskode"
              className={authInputClasses}
            />
          </div>

          {/* Same rule as meetsPasswordPolicy in actions.ts, which enforces it. */}
          <p
            id="password-hint"
            className="text-[13px] leading-[18px] text-black/70"
          >
            Mindst 10 tegn med et stort bogstav, et lille bogstav, et tal og et
            specialtegn.
          </p>

          {state && "error" in state && (
            <p role="alert" className={authErrorClasses}>
              {state.error}
            </p>
          )}

          <div className="pt-3">
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending && <Spinner className="mr-2 h-[14px] w-[14px]" />}
              {pending ? "Gemmer…" : "Gem ny adgangskode"}
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
