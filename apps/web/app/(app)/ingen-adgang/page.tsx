import type { Metadata } from "next";
import { logout } from "@/app/login/actions";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";
import { Button } from "@optipeople/ui";

export const metadata: Metadata = { title: "Ingen adgang" };

// Where a data read lands when OptiCloud answers 403 (lib/opticloud.ts): the
// user is signed in, but the API will not let them read Ventisol's tables.
// A token refresh would not change that, so this page says so instead.
export default function NoAccessPage() {
  return (
    <PageShell width="wide" className="py-10 sm:py-16">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          Ingen adgang til Ventisols data
        </h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          Du er logget ind, men OptiCloud giver ikke din bruger lov til at læse
          Ventisols scanninger. Kontakt Optipeople for at få adgang, eller log
          ind med en anden bruger.
        </p>
        <form action={logout} className="mt-5">
          <Button type="submit">Log ind med en anden bruger</Button>
        </form>
      </SectionCard>
    </PageShell>
  );
}
