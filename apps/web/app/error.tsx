"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";
import { Button, buttonClasses } from "@optipeople/ui";

export default function Error({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  // A value thrown in a client component need not be an Error. globalThis,
  // because this component is itself called Error.
  const message = error instanceof globalThis.Error ? error.message : "";

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell width="wide" className="py-10 sm:py-16">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          Kunne ikke hente data
        </h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          Noget gik galt under hentningen fra OptiCloud. Det er som regel
          forbigående, så prøv igen om et øjeblik.
        </p>
        {process.env.NODE_ENV !== "production" && message && (
          <p className="mt-3 break-words text-[12px] leading-[18px] text-[var(--ds-red-dark)]">
            {message}
          </p>
        )}
        {/* retry() fetches the segment again; reset() would only re-render the failed result. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => retry()}>Prøv igen</Button>
          <Link href="/" className={buttonClasses({ variant: "secondary" })}>
            Til forsiden
          </Link>
        </div>
      </SectionCard>
    </PageShell>
  );
}
