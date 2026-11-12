import type { ReactNode } from "react";
import { OptipeopleLogo } from "@/components/logo";
import { cn } from "@/lib/utils";

// Shared shell for the unauthenticated screens (login, forgot/reset
// password). Copied from optipeople.vola: midnight-green backdrop, centered
// white card with the logo, terms in the footer, brand stripe at the bottom
// (the stripe comes from the root layout). Danish only, so no language toggle.

export const authCardClasses = cn(
  "msg-in relative w-full max-w-[400px] rounded-[4px] bg-white px-6 pt-8 pb-6 sm:px-12 sm:pt-12 sm:pb-8",
  "border border-[#aab5b5]",
  "shadow-[inset_0_2px_2px_0_rgba(0,0,0,0.1)]"
);

export const authInputClasses = cn(
  "h-11 w-full bg-white px-[10px] py-[6px] text-[16px] leading-[21px] text-[#212529] sm:h-[30px] sm:px-[7px] sm:text-[14px]",
  "shadow-[0_0.5px_2.5px_0_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(0,0,0,0.05)]",
  "placeholder:text-[var(--ds-grey-medium-05)]",
  "focus:outline-none focus:shadow-[0_0.5px_2.5px_0_rgba(0,0,0,0.3),0_0_0_1px_var(--ds-midnight-green)]",
  "disabled:opacity-60"
);

export const authLinkClasses =
  "text-[var(--ds-midnight-green)] underline decoration-solid hover:opacity-70";

export const authErrorClasses =
  "mt-3 text-[13px] leading-[18px] text-[var(--color-error)]";

export const authBodyTextClasses =
  "pb-3 text-[14px] leading-[21px] text-black/90";

export function AuthCardHeader({ title }: { title: string }) {
  return (
    <>
      <div className="flex flex-col items-center pt-4 pb-6 sm:pt-6 sm:pb-8">
        <OptipeopleLogo
          className="h-[42px] w-auto text-[#0f1a21] sm:h-[50px]"
          aria-label="Optipeople"
        />
        <p className="mt-3 text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--ds-grey-medium-04)]">
          Ventisol rapporter
        </p>
      </div>
      <h1 className="pb-[18px] pt-[6px] text-[21px] font-black leading-[28px] text-black/75">
        {title}
      </h1>
    </>
  );
}

export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto bg-[var(--ds-midnight-green)] px-4 py-6 sm:px-0 sm:py-0">
      {children}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center pb-[59px]">
        <p className="flex flex-wrap items-center justify-center gap-x-9 gap-y-2 text-[14px] leading-[21px] text-[#eaeeee]">
          <a
            href="https://optipeople.com/terms-and-conditions/"
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto hover:underline"
          >
            Handelsbetingelser
          </a>
        </p>
      </div>
    </main>
  );
}
