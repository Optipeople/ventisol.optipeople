"use client";

// The small chat on every page: a button in the bottom right corner that
// opens a panel with the same chat as the chat page (ChatView with `dock`).
// It continues the user's conversation of today, so a question asked here
// is on the chat page too, and the other way round. PortalChrome mounts it
// for the roles that may chat.
//
// The panel stays mounted while it is closed, so an answer keeps streaming
// behind the button. Whether it is open is kept for the browser tab, because
// app/(app) and app/(detail) each mount their own chrome: going from a list
// to one order would otherwise close it.

import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Maximize2, MessageSquare, SquarePen } from "lucide-react";
import { buttonClasses, cn, Spinner, XIcon } from "@optipeople/ui";
import { openDockConversation, type DockConversation } from "./dock-actions";

// The chat brings Markdown, maths and the AI SDK with it. They are fetched
// when the panel opens, so the other pages do not carry them.
const ChatView = lazy(() => import("./chat-view").then((m) => ({ default: m.ChatView })));

const OPEN_KEY = "ventisol.chat-dock.open";

/** An answer that was still being written when the panel was mounted is asked for again this often. */
const POLL_MS = 3000;
const MAX_POLLS = 20;

// Whether the panel is open, for this browser tab. Read once from
// sessionStorage, and kept in memory when the browser will not store it.
let openNow: boolean | null = null;
const listeners = new Set<() => void>();

function readOpen(): boolean {
  if (openNow === null) {
    try {
      openNow = window.sessionStorage.getItem(OPEN_KEY) === "1";
    } catch {
      openNow = false;
    }
  }
  return openNow;
}

function writeOpen(open: boolean) {
  openNow = open;
  try {
    window.sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the choice lasts until the next full load.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface Wanted {
  /** Counts the loads asked for. */
  n: number;
  /** A new conversation ("Ny samtale"), not the one of today. */
  fresh: boolean;
}

interface Loaded {
  n: number;
  /** Null: it could not be read. */
  chat: DockConversation | null;
}

const sameConversation = (a: DockConversation | null | undefined, b: DockConversation | null) =>
  !!a && !!b && a.id === b.id && a.messages.length === b.messages.length && a.configured === b.configured;

const HEADER_BUTTON = cn(
  "tap-target inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-white/80 transition-colors",
  "hover:bg-white/10 hover:text-white",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
);

export function ChatDock() {
  const pathname = usePathname();
  // The chat page is the same chat in full size.
  const onChatPage = pathname === "/chat";
  const open = useSyncExternalStore(subscribe, readOpen, () => false);
  const active = open && !onChatPage;

  const [wanted, setWanted] = useState<Wanted>({ n: 0, fresh: false });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const polls = useRef(0);
  /** The user has asked something in this panel: it is no longer replaced by a newer copy. */
  const asked = useRef(false);

  // The conversation is read when the panel opens, and again when another
  // one is wanted.
  const loadedN = loaded?.n;
  useEffect(() => {
    if (!active || loadedN === wanted.n) return;
    let cancelled = false;
    const done = (chat: DockConversation | null) => {
      if (cancelled) return;
      setLoaded((before) => ({ n: wanted.n, chat: sameConversation(before?.chat, chat) ? before!.chat : chat }));
    };
    openDockConversation(wanted.fresh).then(done, () => done(null));
    return () => {
      cancelled = true;
    };
  }, [active, wanted, loadedN]);

  // What was asked on the chat page is not in a copy read before it: read
  // again after a visit there.
  const [wasOnChatPage, setWasOnChatPage] = useState(onChatPage);
  if (onChatPage !== wasOnChatPage) {
    setWasOnChatPage(onChatPage);
    if (!onChatPage) setWanted((w) => ({ n: w.n + 1, fresh: false }));
  }
  useEffect(() => {
    asked.current = false;
    polls.current = 0;
  }, [onChatPage]);

  const chat = loaded?.chat ?? null;
  const pending = loaded?.n !== wanted.n;
  const waitingForAnswer = chat?.messages.at(-1)?.role === "user";

  // A question whose answer was still being written when this was read (the
  // user asked and went on to another page): the server finishes and stores
  // it, so look again until it is there.
  useEffect(() => {
    if (!active || pending || !waitingForAnswer || asked.current || polls.current >= MAX_POLLS) return;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      setWanted((w) => ({ n: w.n + 1, fresh: false }));
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, pending, waitingForAnswer, loadedN]);

  // Opening puts the cursor in the question field. Not when the panel is
  // open from an earlier page: the cursor is the page's then.
  const chatKey = chat ? `${chat.id}:${chat.messages.length}` : null;
  const wantsFocus = useRef(false);
  useEffect(() => {
    if (active && chatKey && wantsFocus.current) panel.current?.querySelector("textarea")?.focus();
  }, [active, chatKey]);

  // The panel grows out of the button's corner and shrinks back into it.
  // Only after a click: a panel that is open from an earlier page is just there.
  const [animated, setAnimated] = useState(false);
  // Important: the theme sets a transition on every button, outside the
  // utility layer, which would otherwise win on the round button.
  const motion =
    animated &&
    "transition-[opacity,scale,translate,visibility]! ease-[var(--ease-apple)]! motion-reduce:transition-none!";

  function openPanel() {
    wantsFocus.current = true;
    setAnimated(true);
    writeOpen(true);
  }

  function close() {
    wantsFocus.current = false;
    setAnimated(true);
    writeOpen(false);
    // The button can take the focus once this render has shown it.
    window.setTimeout(() => launcher.current?.focus(), 0);
  }

  function startNew() {
    wantsFocus.current = true;
    asked.current = false;
    polls.current = 0;
    setWanted((w) => ({ n: w.n + 1, fresh: true }));
  }

  if (onChatPage) return null;

  const showSpinner = !loaded || (pending && wanted.fresh);
  const spinner = (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-8 w-8" aria-label="Henter samtalen" />
    </div>
  );

  return (
    <>
      <button
        ref={launcher}
        type="button"
        onClick={openPanel}
        aria-expanded={open}
        aria-controls="chat-dock"
        className={cn(
          buttonClasses({
            variant: "primary",
            className:
              "fixed bottom-4 right-4 z-30 h-12 origin-bottom-right gap-2 rounded-full px-5 text-[16px] shadow-[var(--shadow-lg)] print:hidden",
          }),
          motion,
          // It comes back a moment after the panel has started to leave.
          open ? "invisible scale-75 opacity-0 duration-150!" : "delay-100! duration-300!"
        )}
      >
        <MessageSquare className="h-5 w-5" aria-hidden />
        Spørg chatten
      </button>

      <section
        id="chat-dock"
        ref={panel}
        role="dialog"
        aria-label="Chat"
        aria-hidden={!open}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) close();
        }}
        className={cn(
          "fixed inset-0 z-40 flex origin-bottom-right flex-col overflow-hidden bg-[var(--color-background)] print:hidden",
          "sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(720px,calc(100dvh-2rem))] sm:w-[440px]",
          "sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border)] sm:shadow-[var(--shadow-lg)]",
          motion,
          // `invisible` also takes the closed panel out of the tab order.
          open ? "duration-300!" : "invisible translate-y-3 scale-95 opacity-0 duration-200!"
        )}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 bg-[var(--color-brand)] pl-4 pr-2 text-white">
          <h2 className="mr-auto text-[16px] font-semibold">Chat</h2>
          <button type="button" onClick={startNew} aria-label="Ny samtale" title="Ny samtale" className={HEADER_BUTTON}>
            <SquarePen className="h-4 w-4" aria-hidden />
          </button>
          <Link
            href={chat && !chat.isNew ? `/chat?samtale=${chat.id}` : "/chat"}
            onClick={() => writeOpen(false)}
            aria-label="Åbn i fuld chat"
            title="Åbn i fuld chat"
            className={HEADER_BUTTON}
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </Link>
          <button type="button" onClick={close} aria-label="Luk chatten" title="Luk" className={HEADER_BUTTON}>
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1">
          {showSpinner ? (
            spinner
          ) : chat ? (
            <Suspense fallback={spinner}>
              <ChatView
                key={chatKey}
                conversationId={chat.id}
                initialMessages={chat.messages}
                configured={chat.configured}
                isNew={chat.isNew}
                dock
                // The view arrives after the panel the first time it opens.
                onReady={(field) => {
                  if (wantsFocus.current) field?.focus();
                }}
                onAsked={() => {
                  asked.current = true;
                }}
              />
            </Suspense>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="text-[16px] text-[var(--color-foreground)]">Samtalen kunne ikke hentes.</p>
              <button
                type="button"
                onClick={() => setWanted((w) => ({ n: w.n + 1, fresh: false }))}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Prøv igen
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
