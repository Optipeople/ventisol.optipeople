"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@optipeople/ui";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";

/**
 * The error state of the Ordrer pages. Kept inside the app chrome (the nav
 * stays), unlike the root error page.
 */
export function OrdersError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  const message = error instanceof globalThis.Error ? error.message : "";
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell width="wide" className="py-10">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">Kunne ikke hente {what}</h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          Databasen svarede ikke som ventet. Det er som regel forbigående, så prøv igen om et øjeblik.
        </p>
        {process.env.NODE_ENV !== "production" && message && (
          <p className="mt-3 break-words text-[12px] leading-[18px] text-[var(--ds-red-dark)]">{message}</p>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => retry()}>Prøv igen</Button>
          <Link href="/ordrer" className={buttonClasses({ variant: "secondary" })}>
            Til ordrerne
          </Link>
        </div>
      </SectionCard>
    </PageShell>
  );
}
