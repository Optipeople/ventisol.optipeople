"use client";

import { useEffect } from "react";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";
import { Button } from "@optipeople/ui";

// Inside the app layout, so the header and the tabs stay while the
// overview's own numbers could not be read.
export default function OverviewError({ error, retry }: { error: unknown; retry: () => void }) {
  const message = error instanceof Error ? error.message : "";

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell width="wide" className="py-10 sm:py-16">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          Overblikket kunne ikke hentes
        </h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          Tallene kunne ikke læses lige nu. Det er som regel forbigående, så prøv igen om et øjeblik.
        </p>
        {process.env.NODE_ENV !== "production" && message && (
          <p className="mt-3 break-words text-[12px] leading-[18px] text-[var(--ds-red-dark)]">{message}</p>
        )}
        <div className="mt-5">
          <Button onClick={() => retry()}>Prøv igen</Button>
        </div>
      </SectionCard>
    </PageShell>
  );
}
