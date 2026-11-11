import type { Metadata } from "next";
import {
  AuthCardHeader,
  AuthScreen,
  authBodyTextClasses,
  authCardClasses,
} from "@/components/auth/auth-screen";
import { buttonClasses } from "@/components/ui/button";
import { safeNextPath } from "@/lib/site";

export const metadata: Metadata = { title: "Ingen forbindelse" };

/**
 * Where /auth/refresh sends the user when OptiCloud cannot be reached. The
 * session cookies are untouched, so trying again picks up where they were.
 */
export default async function AuthUnavailablePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <AuthScreen>
      <div className={authCardClasses}>
        <AuthCardHeader title="Ingen forbindelse til OptiCloud" />
        <p className={authBodyTextClasses}>
          OptiCloud svarer ikke lige nu. Du er stadig logget ind. Prøv igen om
          lidt.
        </p>
        <div className="pt-3">
          {/* A plain link, not next/link: it must load the page fresh, not from the client cache. */}
          <a
            href={safeNextPath(next)}
            className={buttonClasses({ variant: "secondary" })}
          >
            Prøv igen
          </a>
        </div>
      </div>
    </AuthScreen>
  );
}
