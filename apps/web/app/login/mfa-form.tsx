"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  cancelMfa,
  resendMfa,
  verifyMfa,
  type MfaState,
  type MfaStep,
} from "@/app/login/actions";
import { Button, Spinner } from "@optipeople/ui";
import {
  AuthCardHeader,
  authCardClasses,
  authErrorClasses,
  authInputClasses,
  authLinkClasses,
} from "@optipeople/ui/blocks";

// As in the OptiCloud portal: a new e-mail or SMS code can be asked for once a minute.
const RESEND_COOLDOWN_SECONDS = 60;

const canResend = (step: MfaStep) => step.method === "email" || step.method === "sms";

/**
 * The second login step for a user with two-factor authentication: the code
 * from the authenticator app, the e-mail or the SMS, or a recovery code. The
 * same step as in the OptiCloud portal and Opti Assist.
 */
export function MfaForm({
  step,
  next,
  onBack,
}: {
  step: MfaStep;
  next?: string;
  onBack: () => void;
}) {
  const [state, action, pending] = useActionState<MfaState, FormData>(verifyMfa, undefined);
  const [recovery, setRecovery] = useState(false);
  const [destination, setDestination] = useState(step.maskedDestination);
  const [resendError, setResendError] = useState<string | null>(null);
  // The backend sends the first e-mail or SMS code with the challenge, so the wait starts at once.
  const [cooldown, setCooldown] = useState(canResend(step) ? RESEND_COOLDOWN_SECONDS : 0);
  const [busy, startTransition] = useTransition();

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const disabled = pending || busy;
  const error = resendError ?? state?.error;

  const instruction = recovery
    ? "Indtast en af de gendannelseskoder, du gemte, da du slog totrinsbekræftelse til."
    : step.method === "email"
      ? `Vi har sendt en 6-cifret kode til ${destination ?? "din e-mail"}.`
      : step.method === "sms"
        ? `Vi har sendt en 6-cifret kode på SMS til ${destination ?? "din telefon"}.`
        : "Indtast den 6-cifrede kode fra din godkendelsesapp.";
  const placeholder = recovery ? "Gendannelseskode" : "6-cifret kode";

  function resend() {
    if (cooldown > 0) return;
    setResendError(null);
    startTransition(async () => {
      const result = await resendMfa();
      if (!result.ok) {
        setResendError("Vi kunne ikke sende en ny kode. Prøv igen om lidt.");
        return;
      }
      if (result.destination) setDestination(result.destination);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    });
  }

  function back() {
    startTransition(async () => {
      await cancelMfa();
      onBack();
    });
  }

  return (
    <form action={action} className={authCardClasses} onSubmit={() => setResendError(null)}>
      <AuthCardHeader eyebrow="Ventisol rapporter" title="Totrinsbekræftelse" />
      {next && <input type="hidden" name="next" value={next} />}
      <input type="hidden" name="recovery" value={recovery ? "1" : "0"} />

      <p className="pb-4 text-[14px] leading-[21px] text-black/90">{instruction}</p>

      <div className="pb-2">
        <input
          // A new field per kind of code: the one typed for the other kind must not stay.
          key={recovery ? "recovery" : "otp"}
          id="mfa-code"
          name="code"
          type="text"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          className={authInputClasses}
        />
      </div>

      {error && (
        <p role="alert" className={authErrorClasses}>
          {error}
        </p>
      )}

      <div className="pt-3">
        <Button type="submit" variant="secondary" disabled={disabled}>
          {pending && <Spinner className="mr-2 h-[14px] w-[14px]" />}
          {pending ? "Bekræfter…" : "Bekræft"}
        </Button>
      </div>

      <div className="flex flex-col items-start gap-2 pt-6 pb-3 text-[14px] leading-[21px]">
        {canResend(step) && !recovery && (
          <button
            type="button"
            onClick={resend}
            disabled={cooldown > 0 || disabled}
            className={
              cooldown > 0 ? "text-[var(--color-muted-foreground)]" : `${authLinkClasses} disabled:opacity-60`
            }
          >
            {cooldown > 0 ? `Send koden igen om ${cooldown}s` : "Send koden igen"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setRecovery((v) => !v);
            setResendError(null);
          }}
          disabled={disabled}
          className={`${authLinkClasses} disabled:opacity-60`}
        >
          {recovery ? "Brug en bekræftelseskode i stedet" : "Brug en gendannelseskode i stedet"}
        </button>
        <button type="button" onClick={back} disabled={disabled} className={`${authLinkClasses} disabled:opacity-60`}>
          Tilbage til log ind
        </button>
      </div>
    </form>
  );
}
