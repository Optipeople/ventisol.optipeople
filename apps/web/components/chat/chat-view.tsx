"use client";

// One conversation, drawn with the shared chat views of @optipeople/ui/chat:
// ChatLayout (sidebar, scrolling column, pinned footer), MessageRow,
// SuggestionChips and ChatComposer. This file keeps what is the app's own:
// sending and streaming with the AI SDK, and mapping its messages to the
// shared ChatMessage (messages.ts). History lives on the server: the client
// sends only its new message with the conversation id
// (app/api/chat/handler.ts).
//
// The same view is the chat page and, with `dock`, the small chat on every
// other page (chat-dock.tsx): no sidebar, tighter text, and each question
// carries the page it was asked from.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { buttonClasses, CircleInfoIcon, cn } from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import {
  ChatComposer,
  ChatLayout,
  MessageRow,
  OutageCard,
  speakableText,
  SuggestionChips,
  WorkingRow,
  type ChatLayoutHandle,
} from "@optipeople/ui/chat";
import { useChatSidebar } from "./chat-shell";
import { growthKey, toChatRow, type ChatRow } from "./messages";
import { ToolFailedLine, ToolResultCard, toolLabel } from "./tool-views";

/** The six questions from the deck, offered in an empty conversation. */
export const SUGGESTIONS = [
  "Hvor er ordrenummer 1042, og hvornår er den klar til afsendelse?",
  "Hvor venter ordrerne mest i denne uge?",
  "Holder kalkulen pr. elementtype?",
  "Passer næste uges batches ind?",
  "Hvor mange skal stå ved montagen?",
  "Hvad skal ledelsen vide i dag?",
];

/** The longest question the server takes (MAX_TEXT in app/api/chat/handler.ts). */
const MAX_QUESTION = 4000;

const newId = () => crypto.randomUUID();

/** The server's own message when it refused (429, 503), else a general one. */
function errorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON: a network or stream error.
  }
  return "Svaret kunne ikke hentes. Prøv igen om lidt.";
}

/** The page a question is asked from, for the server (PageContext in app/api/chat/handler.ts). */
function currentPage(): { path: string; title: string } {
  return {
    path: `${window.location.pathname}${window.location.search}`.slice(0, 300),
    // The root layout's title template puts the app's name first.
    title: document.title.replace(/^Ventisol:\s*/, "").slice(0, 200),
  };
}

/** Shown in an empty conversation, above the starter questions. */
function Intro({ dock }: { dock: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <p
        className={cn(
          "msg-in max-w-2xl text-[18px] leading-[1.5] tracking-[-0.005em] text-[var(--color-foreground)]",
          !dock && "sm:text-[22px] sm:leading-[1.55]"
        )}
      >
        {dock
          ? "Spørg om det du ser på siden, eller om ordrer, stationer, ventetid og nøgletal."
          : "Spørg om ordrer, stationer, ventetid og nøgletal i produktionen."}
      </p>
      <p
        role="note"
        className={cn(
          "msg-in flex max-w-2xl items-start gap-2.5 text-[16px] leading-[1.5] text-[var(--color-foreground)]/80",
          !dock && "sm:text-[17px]"
        )}
      >
        <CircleInfoIcon size={18} className="mt-1 shrink-0 text-[var(--color-foreground)]/70" />
        <span>
          <span className="font-semibold text-[var(--color-foreground)]">Jeg kan tage fejl.</span> Svarene bygger kun på
          portalens egne data. Tjek tallene i portalen, før du handler på dem.
        </span>
      </p>
    </div>
  );
}

/**
 * One answer: the tables and figures of its finished tool calls, then the
 * shared row with the text (or the running steps while there is no text).
 */
function AnswerRow({
  row,
  streaming,
  onAsk,
}: {
  row: ChatRow;
  streaming: boolean;
  onAsk: ((question: string) => void) | undefined;
}) {
  const hasRow = streaming || row.message.content !== "";
  if (!hasRow && row.outcomes.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {row.outcomes.map((o) =>
        o.state === "done" ? (
          <ToolResultCard key={o.id} name={o.name} result={o.result} />
        ) : (
          <ToolFailedLine key={o.id} name={o.name} />
        )
      )}
      {hasRow && <MessageRow message={row.message} isStreaming={streaming} onAsk={onAsk} />}
    </div>
  );
}

export function ChatView({
  conversationId,
  initialMessages,
  configured,
  isNew,
  sidebar,
  dock = false,
  onAsked,
  onReady,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  /** False: no Anthropic API key on the server. The page says so and the field is off. */
  configured: boolean;
  /** The conversation does not exist yet: the URL gets its id after the first question. */
  isNew: boolean;
  /** The conversation list, left of the chat. */
  sidebar?: ReactNode;
  /** The small chat on every page: it sends the page along, and leaves the URL and the page alone. */
  dock?: boolean;
  /** A question was sent. */
  onAsked?: () => void;
  /** The view is on the page, with its question field. */
  onReady?: (field: HTMLTextAreaElement | null) => void;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const layout = useRef<ChatLayoutHandle>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // The AI SDK's parts carry no times, so the timer of a running tool step
  // counts from when its call arrived here. Until the call has arrived in
  // full, it counts from when the question was sent.
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const [sentAt, setSentAt] = useState(() => Date.now());

  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: conversationId,
    messages: initialMessages,
    generateId: newId,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ id, messages: all }) => ({
        body: { id, message: all[all.length - 1], ...(dock ? { page: currentPage() } : {}) },
      }),
    }),
    onToolCall: ({ toolCall }) => {
      const at = Date.now();
      setStartedAt((known) => (toolCall.toolCallId in known ? known : { ...known, [toolCall.toolCallId]: at }));
    },
    // The list on the left shows the new conversation and its title. The
    // dock has no list, and the page under it is not the chat's to reload.
    onFinish: () => {
      if (!dock) router.refresh();
    },
  });

  const ready = useRef(onReady);
  useEffect(() => {
    ready.current?.(field.current);
  }, []);

  const busy = status === "submitted" || status === "streaming";
  const rows = useMemo(
    () => messages.map((m) => toChatRow(m, { toolLabel, startedAt, fallbackStart: sentAt })),
    [messages, startedAt, sentAt]
  );
  const last = rows[rows.length - 1];
  const lastIsAnswer = last?.message.role === "assistant";

  // The composer is locked while an answer streams, which drops the focus.
  // Give it back when the answer is done, unless the user went elsewhere.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && (!document.activeElement || document.activeElement === document.body)) {
      field.current?.focus();
    }
    wasBusy.current = busy;
  }, [busy]);

  function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !configured) return;
    clearError();
    setInput("");
    layout.current?.scrollToBottom();
    if (!dock && isNew && messages.length === 0) {
      window.history.replaceState(null, "", `/chat?samtale=${conversationId}`);
    }
    setSentAt(Date.now());
    onAsked?.();
    void sendMessage({ text: question });
  }

  const { open: sidebarOpen } = useChatSidebar();
  const footer = (
    <>
      {!configured && (
        <Notice tone="warning" className="mb-4">
          AI er ikke konfigureret på denne server, så chatten kan ikke svare. Sæt ANTHROPIC_API_KEY på serveren. Tidligere
          samtaler kan stadig læses.
        </Notice>
      )}
      {rows.length === 0 && (
        <SuggestionChips
          questions={dock ? SUGGESTIONS.slice(0, 3) : SUGGESTIONS}
          onAsk={ask}
          disabled={!configured}
          className={cn(dock && "sm:mb-6")}
        />
      )}
      {/* The sidebar has "Ny samtale" too: this one shows only while that one is folded away.
          The dock has its own in its header. */}
      {rows.length > 0 && !dock && (
        <div className={cn("msg-in mb-4 flex flex-wrap items-end gap-2 sm:mb-5", sidebarOpen !== false && "sm:hidden")}>
          <Link
            href="/chat"
            className={buttonClasses({
              variant: "secondary",
              size: "sm",
              className: "tap-target ml-auto leading-[16px] sm:text-[14px]",
            })}
          >
            Ny samtale
          </Link>
        </div>
      )}
      <ChatComposer
        value={input}
        onChange={(value) => setInput(value.slice(0, MAX_QUESTION))}
        onSubmit={() => ask(input)}
        onStop={() => void stop()}
        streaming={busy}
        disabled={!configured}
        placeholder={configured ? undefined : "AI er ikke konfigureret"}
        textareaRef={field}
      />
    </>
  );

  return (
    <ChatLayout
      ref={layout}
      sidebar={sidebar}
      footer={footer}
      scrollKey={`${growthKey(rows)}:${status}:${error ? 1 : 0}`}
      showJumpToLatest={rows.length > 0}
      // The root layout already draws the stripe under every page.
      brandStripe={false}
    >
      {rows.length === 0 ? (
        <Intro dock={dock} />
      ) : (
        <div className="flex flex-col gap-6 sm:gap-8">
          {rows.map((row, i) => {
            if (row.message.role === "user") return <MessageRow key={row.message.id} message={row.message} />;
            const isLast = i === rows.length - 1;
            return (
              <AnswerRow
                key={row.message.id}
                row={row}
                streaming={busy && isLast}
                onAsk={!busy && isLast ? ask : undefined}
              />
            );
          })}
          {/* Sent, and nothing has come back yet. */}
          {status === "submitted" && !lastIsAnswer && <WorkingRow />}
          {error && <OutageCard info={{ kind: "error", title: "Noget gik galt" }} message={errorText(error)} />}
        </div>
      )}
      {/* A streamed answer is silent to a screen reader: read it out when it is done. */}
      <div aria-live="polite" className="sr-only">
        {!busy && !error && last && lastIsAnswer ? speakableText(last.message.content) : ""}
      </div>
    </ChatLayout>
  );
}
