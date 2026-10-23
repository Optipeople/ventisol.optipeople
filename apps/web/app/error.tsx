"use client";

import { useEffect } from "react";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell className="py-10 sm:py-16">
      <div className="mx-auto max-w-md rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          Kunne ikke hente data
        </h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          Noget gik galt under hentningen fra OptiCloud. Det er som regel
          forbigående, så prøv igen om et øjeblik.
        </p>
        {process.env.NODE_ENV !== "production" && error.message && (
          <p className="mt-3 break-words text-[12px] leading-[18px] text-[var(--ds-red-dark)]">
            {error.message}
          </p>
        )}
        <Button className="mt-5" onClick={() => reset()}>
          Prøv igen
        </Button>
      </div>
    </PageShell>
  );
}
