"use client";

// "Hent Excel" for the week, from the production lists only. A fetch, not a
// plain link: a refusal (rate limit, no access) is shown here instead of
// being saved as the .xlsx.

import { useState } from "react";
import { Button, Spinner } from "@optipeople/ui";
import { fetchWorkbook } from "./download";

export function WeekPlanDownloadButton({ week }: { /** "2026-48". */ week: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await fetchWorkbook(`/api/ugeplan?uge=${encodeURIComponent(week)}`);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Excel-filen kunne ikke hentes. Prøv igen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={() => void download()} disabled={busy}>
        {busy && <Spinner className="h-4 w-4" aria-hidden />}
        {busy ? "Henter…" : "Hent Excel"}
      </Button>
      <p role="alert" className="max-w-[320px] text-right text-[12px] leading-[18px] text-[var(--ds-red-dark)]">
        {error}
      </p>
    </div>
  );
}
