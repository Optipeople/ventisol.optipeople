import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@optipeople/ui/blocks";
import { LoginForm } from "@/app/login/login-form";
import { getSession } from "@/lib/auth";
import { safeNextPath } from "@/lib/site";

export const metadata: Metadata = { title: "Log ind" };

const AUTH_FOOTER_LINKS = [
  {
    label: "Handelsbetingelser",
    href: "https://optipeople.com/terms-and-conditions/",
  },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next: nextParam } = await searchParams;
  const next = safeNextPath(nextParam);
  const session = await getSession();
  if (session.status === "ok") redirect(next);

  const showForbidden = error === "forbidden" || session.status === "forbidden";

  return (
    <AuthScreen footerLinks={AUTH_FOOTER_LINKS}>
      <LoginForm
        initialError={
          showForbidden
            ? "Din Optipeople-bruger har ikke adgang til Ventisol. Log ind med en bruger på Ventisol-kontoen, eller kontakt Optipeople."
            : error === "session"
              ? "OptiCloud afviste dit login, også efter en fornyelse. Log ind igen."
              : undefined
        }
        next={next === "/" ? undefined : next}
      />
    </AuthScreen>
  );
}
