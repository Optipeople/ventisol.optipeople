"use client";

// The 3E production list, drawn with pdf.js into canvases. Not the browser's
// own viewer: the site sends `frame-ancestors 'none'`, X-Frame-Options DENY
// and `object-src 'none'` on every response (next.config.ts), which blocks an
// iframe or object holding the PDF. pdf.js fetches the bytes from our own
// route and draws them, so no framing is needed.
//
// Give it `key={src}`: a new document is a new viewer.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@optipeople/ui";

type State = { status: "loading" } | { status: "ready"; pages: number } | { status: "error"; message: string };

/** One worker for the page's lifetime, shared by every viewer. */
let workerPort: Worker | null = null;

export function PdfViewer({ src, title }: { src: string; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;

    (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (!workerPort) {
        workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
      }
      pdfjs.GlobalWorkerOptions.workerPort = workerPort;

      const res = await fetch(src, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Dokumentet findes ikke længere i OptiCloud."
            : res.status === 503
              ? "OptiCloud kan ikke nås lige nu. Prøv igen om lidt."
              : "Dokumentet kunne ikke hentes."
        );
      }
      const data = new Uint8Array(await res.arrayBuffer());
      if (cancelled) return;

      const task = pdfjs.getDocument({ data });
      destroy = () => void task.destroy();
      const doc = await task.promise;
      const host = container.current;
      if (cancelled || !host) return;

      host.replaceChildren();
      const width = Math.max(320, host.clientWidth);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        canvas.className = "block bg-white shadow-sm";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `${title}, side ${n} af ${doc.numPages}`);
        host.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!cancelled) setState({ status: "ready", pages: doc.numPages });
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.error("PdfViewer:", err);
      setState({
        status: "error",
        message: err instanceof Error && /OptiCloud|Dokumentet/.test(err.message) ? err.message : "PDF'en kunne ikke vises.",
      });
    });

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [src, title]);

  return (
    <div className="rounded-[var(--ds-radius-surface)] border border-[var(--ds-grey-light-02)] bg-[var(--ds-grey-light-01)] p-4">
      {state.status === "loading" && (
        <div className="flex h-[240px] items-center justify-center gap-2 text-[14px] text-[var(--ds-grey-medium-05)]">
          <Spinner className="h-5 w-5" aria-label="Henter PDF" /> Henter produktionslisten…
        </div>
      )}
      {state.status === "error" && (
        <p className="p-6 text-center text-[14px] leading-[21px] text-[var(--ds-red-dark)]">{state.message}</p>
      )}
      <div
        ref={container}
        className="mx-auto flex max-h-[80vh] max-w-[900px] flex-col gap-3 overflow-auto"
        aria-busy={state.status === "loading"}
      />
    </div>
  );
}
