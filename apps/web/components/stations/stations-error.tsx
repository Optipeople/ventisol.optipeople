"use client";

import { useEffect } from "react";
import { Button } from "@optipeople/ui";
import { Notice, PageHeader, PageShell } from "@optipeople/ui/blocks";

/**
 * When a station report cannot be read (the database is down, a query
 * failed). The error state of the Stationer list and of one station's page.
 */
export function StationsError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;

  return (
    <PageShell width="wide">
      <PageHeader title="Stationer" />
      <Notice tone="error" prominent>
        Stationernes tal kunne ikke hentes lige nu. Prøv igen om lidt.
        {digest ? <span className="mt-2 block text-[12px] opacity-70">Fejlkode {digest}</span> : null}
      </Notice>
      <div className="mt-4 flex justify-center">
        <Button variant="secondary" onClick={() => retry()}>
          Prøv igen
        </Button>
      </div>
    </PageShell>
  );
}
