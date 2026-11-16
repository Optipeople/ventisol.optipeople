import type { Metadata } from "next";
import Link from "next/link";
import { logout } from "@/app/login/actions";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";
import { Button } from "@optipeople/ui";

export const metadata: Metadata = { title: "Ingen adgang" };

// Where a signed-in user lands when something says no. Three reasons:
//
// - no `grund`: a data read got 403 from OptiCloud (lib/opticloud.ts). The
//   API will not let this user read Ventisol's tables, and a token refresh
//   would not change that.
// - `grund=rolle`: the user's portal role does not cover the page
//   (requireRole / requireCapability in lib/auth.ts).
// - `grund=database`: the same guards, but the role is only the fallback
//   used while the database cannot be reached, so the answer is "try again".
//
// The page itself shows nothing protected, so it has no guard of its own.
const REASONS = {
  opticloud: {
    title: "Ingen adgang til Ventisols data",
    text: "Du er logget ind, men OptiCloud giver ikke din bruger lov til at læse Ventisols scanninger. Kontakt Optipeople for at få adgang, eller log ind med en anden bruger.",
  },
  rolle: {
    title: "Din rolle giver ikke adgang til siden",
    text: "Du er logget ind, men din rolle i portalen dækker ikke denne side. Bed en administrator om at ændre din rolle, hvis du skal bruge den.",
  },
  database: {
    title: "Din rolle kunne ikke hentes",
    text: "Portalen kan ikke læse brugernes roller lige nu, så sider der kræver en bestemt rolle er lukket midlertidigt. Overblikket virker stadig. Prøv igen om lidt.",
  },
} as const;

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ grund?: string }>;
}) {
  const { grund } = await searchParams;
  const key = grund === "rolle" || grund === "database" ? grund : "opticloud";
  const reason = REASONS[key];

  return (
    <PageShell width="wide" className="py-10 sm:py-16">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          {reason.title}
        </h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          {reason.text}
        </p>
        {key !== "opticloud" && (
          <p className="mt-4 text-[14px] leading-[21px]">
            <Link href="/" className="underline">
              Til overblikket
            </Link>
          </p>
        )}
        <form action={logout} className="mt-5">
          <Button type="submit" variant={key === "opticloud" ? "primary" : "secondary"}>
            Log ind med en anden bruger
          </Button>
        </form>
      </SectionCard>
    </PageShell>
  );
}
