"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { login, type LoginState } from "@/app/login/actions";
import { MfaForm } from "@/app/login/mfa-form";
import { Button, Spinner } from "@optipeople/ui";
import {
  AuthCardHeader,
  authCardClasses,
  authErrorClasses,
  authInputClasses,
  authLinkClasses,
} from "@optipeople/ui/blocks";

export function LoginForm({ initialError, next }: { initialError?: string; next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    login,
    undefined
  );
  const error = state?.error ?? initialError;
  // The challenge the user went back from: the login form shows again until a new one comes.
  const [left, setLeft] = useState<string | null>(null);

  // The password was right and the user has two-factor authentication on: ask for the code.
  if (state?.mfa && state.mfa.id !== left) {
    const step = state.mfa;
    return <MfaForm key={step.id} step={step} next={next} onBack={() => setLeft(step.id)} />;
  }

  return (
    <form action={action} className={authCardClasses}>
      <AuthCardHeader eyebrow="Ventisol rapporter" title="Log ind" />
      {next && <input type="hidden" name="next" value={next} />}

      <div className="flex flex-col gap-2 pb-2">
        <input
          id="email"
          name="email"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={state?.email}
          required
          disabled={pending}
          placeholder="Brugernavn eller e-mail"
          aria-label="Brugernavn eller e-mail"
          className={authInputClasses}
        />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          placeholder="Adgangskode"
          aria-label="Adgangskode"
          className={authInputClasses}
        />
      </div>

      <label className="mt-2 inline-flex cursor-pointer items-center gap-[6px] text-[14px] leading-[14px] text-[#071818]">
        <input
          type="checkbox"
          name="remember"
          defaultChecked
          className="size-[14px] cursor-pointer accent-[var(--ds-midnight-green)]"
        />
        Husk mig på denne computer
      </label>

      {error && (
        <p role="alert" className={authErrorClasses}>
          {error}
        </p>
      )}

      <div className="pt-3">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending && <Spinner className="mr-2 h-[14px] w-[14px]" />}
          {pending ? "Logger ind…" : "Log ind"}
        </Button>
      </div>

      <p className="pt-6 pb-3 text-[14px] leading-[21px] text-black/90">
        Log ind med din OptiCloud-bruger.
        <br aria-hidden />
        Jeg har{" "}
        <Link href="/forgot-password" className={authLinkClasses}>
          glemt min adgangskode
        </Link>
        .
      </p>
    </form>
  );
}
