"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 60_000;

/**
 * Keeps a page that shows live data up to date: re-reads the server
 * components every minute while the tab is visible, and at once when the tab
 * comes back after more than a minute away. Renders nothing. Mount it only
 * where the data moves (today's day view).
 */
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < REFRESH_MS - 1000) return;
      last = Date.now();
      router.refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  return null;
}
