"use client";

// The Ugeplan page's optional part: drop the week's 3E database, see what was
// read, and fetch the workbook with 3E's data merged into the portal's. The
// MDB is read here in the browser (lib/weekplan/mdb.ts, loaded on demand:
// mdb-reader is large); only the plan is posted to /api/ugeplan?uge=, which
// returns the .xlsx.

import Link from "next/link";
import { useId, useState } from "react";
import { Button, FileDropZone, Spinner } from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import type { WeekPlan } from "@/lib/weekplan/types";
import { parseWeekParam, weekParam } from "@/lib/weekplan/week";
import { fetchWorkbook } from "./download";
import { UnknownPositionsNotice } from "./unknown-notice";

type Phase = "idle" | "reading" | "ready" | "sending";


const hoursFormat = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const amountFormat = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const countFormat = new Intl.NumberFormat("da-DK");

export function WeekPlanUpload({ week }: { /** The page's week, "2026-48". */ week: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const zoneId = useId();
  const busy = phase === "reading" || phase === "sending";
  const mismatch = plan !== null && isOtherWeek(plan, week);

  async function readFile(file: File) {
    setPhase("reading");
    setPlan(null);
    setError(null);
    setStatus(`Læser ${file.name}…`);
    try {
      const [{ Buffer }, { readWeekPlanFile }] = await Promise.all([
        import("buffer"),
        import("@/lib/weekplan/mdb"),
      ]);
      // mdb-reader's browser build expects Node's Buffer as a global.
      (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const read = await readWeekPlanFile(bytes, file.name);
      setPlan(read);
      setPhase("ready");
      setStatus(`${file.name} er læst: ${countFormat.format(read.orders.length)} ordrer.`);
    } catch (e) {
      setPhase("idle");
      setStatus("");
      setError(readError(e));
    }
  }

  async function download() {
    if (!plan) return;
    setPhase("sending");
    setError(null);
    setStatus("Laver Excel-filen…");
    try {
      const name = await fetchWorkbook(`/api/ugeplan?uge=${encodeURIComponent(week)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      });
      setStatus(`${name} er hentet.`);
    } catch (e) {
      setStatus("");
      setError(e instanceof Error && e.message ? e.message : "Excel-filen kunne ikke hentes. Prøv igen.");
    } finally {
      setPhase("ready");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <FileDropZone
          id={zoneId}
          accept=".mdb,.accdb"
          onFiles={(files) => {
            const file = files[0];
            if (file) void readFile(file);
          }}
          disabled={busy}
          label="Træk ugens 3E-fil herind, eller klik for at vælge den"
          hint=".MDB eller .ACCDB, fx Uge 48.MDB"
        />
      </div>

      <p aria-live="polite" role="status" className="flex min-h-[20px] items-center gap-2 text-[13px] leading-[20px]">
        {busy && <Spinner className="h-4 w-4" aria-hidden />}
        {status}
      </p>

      {error && (
        <Notice tone="error" icon>
          <span role="alert">{error}</span>
        </Notice>
      )}

      {plan && mismatch && <WeekMismatch plan={plan} week={week} />}

      {plan && <Preview plan={plan} />}

      {plan && (
        <div>
          <Button onClick={() => void download()} disabled={busy || mismatch || plan.orders.length === 0}>
            {phase === "sending" ? "Henter…" : "Hent Excel med 3E-data"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Preview({ plan }: { plan: WeekPlan }) {
  const elements = plan.orders.reduce((sum, o) => sum + o.elements, 0);
  const hours = plan.orders.reduce((sum, o) => sum + (o.hours ?? 0), 0);
  const amount = plan.orders.reduce((sum, o) => sum + (o.amount ?? 0), 0);

  const facts: { label: string; value: string }[] = [
    { label: "Uge", value: weekLabel(plan) },
    { label: "Ordrer", value: countFormat.format(plan.orders.length) },
    { label: "Elementer", value: countFormat.format(elements) },
    { label: "Timer", value: hoursFormat.format(hours) },
    { label: "Ordresum", value: `${amountFormat.format(amount)} kr.` },
  ];

  return (
    <section aria-label="Det læste" className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="rounded-[var(--ds-radius-surface)] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] px-4 py-3"
          >
            <dt className="text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">{fact.label}</dt>
            <dd className="text-[18px] font-medium leading-[26px] tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {plan.orders.length === 0 && <Notice tone="warning">Filen har ingen ordrer.</Notice>}

      <UnknownPositionsNotice orders={plan.orders} />
    </section>
  );
}

/** The 3E file is of another week than the page shows. */
function isOtherWeek(plan: WeekPlan, week: string): boolean {
  const page = parseWeekParam(week);
  if (plan.year === null || plan.week === null || !page) return false;
  return plan.year !== page.year || plan.week !== page.week;
}

/** The file is of another week: no workbook for this one, offer the file's week. */
function WeekMismatch({ plan, week }: { plan: WeekPlan; week: string }) {
  const page = parseWeekParam(week);
  if (plan.year === null || plan.week === null || !page) return null;
  const mdbWeek = weekParam({ year: plan.year, week: plan.week });
  return (
    <Notice tone="warning" icon>
      Filen er for uge {plan.week}, {plan.year}, men siden viser uge {page.week}, {page.year}.{" "}
      <Link href={`/ugeplan?uge=${mdbWeek}`} className="font-bold underline">
        Gå til uge {plan.week}, {plan.year}
      </Link>{" "}
      og træk filen ind igen.
    </Notice>
  );
}

function weekLabel(plan: WeekPlan): string {
  if (plan.week === null) return "Ukendt";
  return plan.year === null ? `Uge ${plan.week}` : `Uge ${plan.week}, ${plan.year}`;
}

function readError(e: unknown): string {
  if (e instanceof Error && e.name === "NotA3EDatabaseError") {
    return `${e.message} Er det ugens 3E-fil?`;
  }
  return "Filen kunne ikke læses. Er det ugens 3E-fil (.MDB)?";
}
