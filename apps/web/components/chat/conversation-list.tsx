"use client";

// The sidebar beside the chat, built like Opti Assist's drawer: a dark panel
// with the user's conversations, newest first, "Ny samtale" and a way to hide
// one (DELETE /api/chat archives it). It folds to a thin rail; on a phone the
// rail opens the panel on top of the chat.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { buttonClasses, cn, Tooltip, TrashIcon } from "@optipeople/ui";
import { useFocusTrap } from "@optipeople/ui/lib/useFocusTrap";
import { MessageSquareIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "./icons";

export interface ConversationItem {
  id: string;
  title: string;
  /** Already formatted, Danish. */
  when: string;
}

const MOBILE_MQ = "(max-width: 639px)";

function subscribeMobile(onChange: () => void) {
  const mq = window.matchMedia(MOBILE_MQ);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const RAIL_BUTTON = cn(
  "tap-target inline-flex flex-col items-center gap-2 rounded px-1 py-2 text-white/70",
  "hover:bg-white/10 hover:text-white",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
);

const RAIL_LABEL = "select-none text-[10px] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]";

export function ConversationList({ items, activeId }: { items: ConversationItem[]; activeId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isMobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_MQ).matches,
    () => false
  );
  // Until the user chooses: open beside the chat on a wide screen, folded on a phone.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? !isMobile;

  // On a phone the open panel is a dialog over the chat.
  const overlay = useRef<HTMLDivElement>(null);
  useFocusTrap(overlay, isMobile && open);
  useEffect(() => {
    if (!isMobile || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChoice(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile, open]);

  function archive(id: string) {
    startTransition(async () => {
      await fetch(`/api/chat?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (id === activeId) router.push("/chat");
      router.refresh();
    });
  }

  // The chat is under the overlay on a phone: get out of its way.
  const leave = () => {
    if (isMobile) setChoice(false);
  };

  const panel = (
    <>
      <header className="flex items-end justify-between gap-2 border-b border-white/10 px-4 pt-5 sm:px-6">
        <h2 className="-mb-px border-b-2 border-white pb-2 text-[15px] font-semibold tracking-tight text-white">
          Samtaler
        </h2>
        <button
          type="button"
          onClick={() => setChoice(false)}
          aria-label="Skjul samtaler"
          tabIndex={open ? 0 : -1}
          className="mb-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <PanelLeftCloseIcon className="h-5 w-5" />
        </button>
      </header>
      <p className="px-4 pt-3 text-[14px] leading-[1.5] text-white/70 sm:px-6">
        Dine tidligere samtaler. Vælg en for at fortsætte den.
      </p>
      <div className="px-4 pt-4 sm:px-6">
        <Link
          href="/chat"
          onClick={leave}
          tabIndex={open ? 0 : -1}
          className={buttonClasses({ variant: "secondary", className: "w-full" })}
        >
          Ny samtale
        </Link>
      </div>
      <nav aria-label="Samtaler" className="scroll-area flex-1 overflow-y-auto pb-3 pt-6">
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-[15px] text-white/70 sm:px-6">Ingen samtaler endnu.</p>
        ) : (
          <ul className={cn("flex flex-col", pending && "opacity-60")}>
            {items.map((c) => {
              const active = c.id === activeId;
              return (
                <li
                  key={c.id}
                  className={cn(
                    "group relative rounded-[4px] transition-colors hover:bg-white/10",
                    active && "bg-white/15"
                  )}
                >
                  <Link
                    href={`/chat?samtale=${c.id}`}
                    onClick={leave}
                    aria-current={active ? "page" : undefined}
                    tabIndex={open ? 0 : -1}
                    className="flex w-full items-start gap-2.5 rounded-[4px] py-3 pl-4 pr-12 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:pl-6"
                  >
                    <MessageSquareIcon className="mt-0.5 h-5 w-5 shrink-0 text-white/70 group-hover:text-white" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-medium text-white">{c.title}</span>
                      <span className="mt-0.5 block text-[13px] text-white/70">{c.when}</span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Skjul samtalen ${c.title}`}
                    title="Skjul samtalen"
                    tabIndex={open ? 0 : -1}
                    onClick={() => archive(c.id)}
                    className="tap-target absolute right-2 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded text-white/70 opacity-0 hover:bg-white/10 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </>
  );

  // Wide screens: one aside that slides between the rail and the panel.
  if (!isMobile) {
    return (
      <aside
        aria-label="Samtaler"
        className={cn(
          "relative h-full shrink-0 overflow-hidden bg-[var(--color-brand)] transition-[width] duration-[220ms] ease-out",
          open ? "w-72 sm:w-80" : "w-[35px]"
        )}
      >
        <div
          className={cn(
            "absolute left-0 top-0 flex w-[35px] flex-col items-center pt-5 transition-opacity",
            open ? "pointer-events-none opacity-0 duration-100" : "opacity-100 delay-100 duration-200"
          )}
          aria-hidden={open}
        >
          <Tooltip content="Vis samtaler" side="right" variant="light">
            <button
              type="button"
              onClick={() => setChoice(true)}
              aria-label="Vis samtaler"
              tabIndex={open ? -1 : 0}
              className={RAIL_BUTTON}
            >
              <PanelLeftOpenIcon className="h-5 w-5" />
              <span aria-hidden className={RAIL_LABEL}>
                Samtaler
              </span>
            </button>
          </Tooltip>
        </div>
        <div
          className={cn(
            "absolute left-0 top-0 flex h-full w-72 flex-col transition-opacity sm:w-80",
            open ? "opacity-100 delay-100 duration-200" : "pointer-events-none opacity-0 duration-100"
          )}
          aria-hidden={!open}
        >
          {panel}
        </div>
      </aside>
    );
  }

  // Phones: the rail stays in place, the panel slides in over the chat.
  return (
    <aside aria-label="Samtaler" className="flex h-full w-[42px] shrink-0 flex-col items-center bg-[var(--color-brand)] pt-5">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        aria-label={open ? "Skjul samtaler" : "Vis samtaler"}
        aria-expanded={open}
        className={RAIL_BUTTON}
      >
        <PanelLeftOpenIcon className="h-5 w-5" />
        <span aria-hidden className={RAIL_LABEL}>
          Samtaler
        </span>
      </button>
      <div className={cn("fixed inset-0 z-40", open ? "pointer-events-auto" : "pointer-events-none")} aria-hidden={!open}>
        <div
          onClick={() => setChoice(false)}
          aria-hidden
          className={cn(
            "absolute inset-0 bg-black/30 transition-opacity ease-out",
            open ? "opacity-100 duration-200" : "opacity-0 duration-150"
          )}
        />
        <div
          ref={overlay}
          role="dialog"
          aria-label="Samtaler"
          aria-modal={open}
          className={cn(
            "absolute bottom-0 left-0 top-0 flex w-72 max-w-[85vw] flex-col bg-[var(--color-brand)] shadow-[var(--shadow-md)]",
            "transition-transform duration-[220ms] ease-out",
            open ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {panel}
        </div>
      </div>
    </aside>
  );
}
