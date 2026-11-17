"use client";

// The frame of the chat page, as in Opti Assist: a dark band that holds the
// sidebar, with the light chat panel beside it. It fills the window under the
// portal's header and tabs, so only the messages scroll, never the page.

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Height of the three colour stripe that the root layout puts under every page. */
const STRIPE_PX = 27;

export function ChatShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // The header and the tabs above are not this page's to measure in CSS, so
  // the frame reads where it starts and takes the rest of the window. The
  // class below holds a close guess until this has run.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `max(320px, calc(100dvh - ${Math.round(top) + STRIPE_PX}px))`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div ref={ref} className="flex h-[calc(100dvh-113px)] min-h-[320px] bg-[var(--color-brand)]">
      {sidebar}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[var(--radius)] bg-[var(--color-background)]">
        {children}
      </div>
    </div>
  );
}
