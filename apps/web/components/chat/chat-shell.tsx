"use client";

// Gives the shared ChatLayout a height. ChatLayout is `h-full` and made for
// a page whose body is one window tall. Here the chat sits under the
// portal's header and tabs and above the three colour stripe of the root
// layout, so this frame takes what is left of the window. Only the messages
// scroll, never the page.

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Height of the three colour stripe that the root layout puts under every page. */
const STRIPE_PX = 27;

interface SidebarState {
  /** Undefined lets the drawer pick by screen width. The frame starts it folded. */
  open: boolean | undefined;
  setOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarState>({ open: undefined, setOpen: () => {} });

/**
 * The user's choice for the sidebar. It lives in the frame, because the chat
 * inside is mounted again for every conversation and would forget it.
 */
export function useChatSidebar(): SidebarState {
  return useContext(SidebarContext);
}

export function ChatFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Folded until the user opens it: the chat gets the whole width first.
  const [open, setOpen] = useState<boolean | undefined>(false);
  const sidebar = useMemo(() => ({ open, setOpen }), [open]);

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
    <div ref={ref} className="h-[calc(100dvh-113px)] min-h-[320px]">
      <SidebarContext.Provider value={sidebar}>{children}</SidebarContext.Provider>
    </div>
  );
}
