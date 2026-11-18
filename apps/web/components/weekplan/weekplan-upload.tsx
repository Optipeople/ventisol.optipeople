"use client";

// The Ugeplan page's one control: drop the week's 3E database, see what was
// read, and fetch the workbook. The MDB is read here in the browser
// (lib/weekplan/mdb.ts, loaded on demand: mdb-reader is large); only the plan
// is posted to /api/ugeplan, which returns the .xlsx.

import { useId, useState } from "react";
import { Button, FileDropZone, Spinner } from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import type { WeekPlan } from "@/lib/weekplan/types";

type Phase = "idle" | "reading" | "ready" | "sending";

const FALLBACK_FILE_NAME = "ugeplan.xlsx";
/** How many orders with unplaced positions the warning lists by name. */
const MAX_WARNINGS = 20;

const hoursFormat = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const amountFormat = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const countFormat = new Intl.NumberFormat("da-DK");

export function WeekPlanUpload() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const zoneId = useId();
  const busy = phase === "reading" || phase === "sending";

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
      const res = await fetch("/api/ugeplan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).trim();
        throw new Error(text || `Portalen svarede med fejl ${res.status}.`);
      }
      const blob = await res.blob();
      const name = fileNameFrom(res.headers.get("content-disposition"));
      saveBlob(blob, name);
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

      {plan && <Preview plan={plan} />}

      {plan && (
        <div>
          <Button onClick={() => void download()} disabled={busy || plan.orders.length === 0}>
            {phase === "sending" ? "Henter…" : "Hent Excel"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Preview({ plan }: { plan: WeekPlan }) {
  const elements = plan.orders.reduce((sum, o) => sum + o.elements, 0);
  const hours = plan.orders.reduce((sum, o) => sum + o.hours, 0);
  const amount = plan.orders.reduce((sum, o) => sum + (o.amount ?? 0), 0);
  const withUnknown = plan.orders.filter((o) => o.unknown.length > 0);

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

      {withUnknown.length > 0 && (
        <Notice tone="warning" icon>
          <p>
            {withUnknown.length === 1
              ? "1 ordre har positioner, der ikke kunne placeres i en elementtype:"
              : `${countFormat.format(withUnknown.length)} ordrer har positioner, der ikke kunne placeres i en elementtype:`}
          </p>
          <ul className="mt-2 list-disc pl-5">
            {withUnknown.slice(0, MAX_WARNINGS).map((o) => (
              <li key={o.orderNo}>
                Ordre {o.orderNo}
                {o.customer ? ` (${o.customer})` : ""}: {o.unknown.join("; ")}
              </li>
            ))}
          </ul>
          {withUnknown.length > MAX_WARNINGS && (
            <p className="mt-2">Og {countFormat.format(withUnknown.length - MAX_WARNINGS)} ordrer mere.</p>
          )}
        </Notice>
      )}
    </section>
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

/** The file name of a Content-Disposition header: filename* first, then filename. */
function fileNameFrom(header: string | null): string {
  if (!header) return FALLBACK_FILE_NAME;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // A broken encoding: try the plain filename.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name || FALLBACK_FILE_NAME;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
