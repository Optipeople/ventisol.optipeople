"use client";

// One conversation, laid out like Opti Assist: a centred column of messages
// that scrolls, and a panel fixed at the bottom with the starter questions,
// the scope tag and the question field. History lives on the server: the
// client sends only its new message with the conversation id
// (app/api/chat/handler.ts).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  Button,
  buttonClasses,
  CheckIcon,
  CircleExclamationIcon,
  CircleInfoIcon,
  cn,
  FieldFrame,
  IconButton,
  Spinner,
  Tag,
} from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import type { ToolResult } from "@/lib/tools/types";
import { AnswerText } from "./answer-text";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, SquareIcon } from "./icons";
import { ToolResultCard, toolLabel } from "./tool-views";

/** The six questions from the deck, offered in an empty conversation. */
export const SUGGESTIONS = [
  "Hvor er ordrenummer 1042, og hvornår er den klar til afsendelse?",
  "Hvor venter ordrerne mest i denne uge?",
  "Holder kalkulen pr. elementtype?",
  "Passer næste uges batches ind?",
  "Hvor mange skal stå ved montagen?",
  "Hvad skal ledelsen vide i dag?",
];

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

const messageText = (message: UIMessage) => message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** A quiet line under the messages: a running tool, or a tool that failed. */
const STEP_LINE = "msg-in flex items-center gap-2 text-[14px] text-[var(--color-muted-foreground)] sm:text-[15px]";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard on an insecure page. The text can still be selected.
    }
  }
  const label = copied ? "Kopieret" : "Kopiér svaret";
  return (
    <IconButton onClick={() => void copy()} title={label} aria-label={label} className={cn(copied && "text-[var(--ds-green)]")}>
      {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
    </IconButton>
  );
}

function MessageView({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  if (message.role === "user") {
    return (
      <div className="msg-in flex flex-col items-end">
        <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-[4px] bg-[var(--color-accent)] px-4 py-2.5 text-[16px] leading-[1.5] text-[var(--color-primary-foreground)] shadow-[var(--shadow-sm)] sm:max-w-[78%] sm:px-5 sm:py-3 sm:text-[19px] sm:leading-[1.55]">
          {messageText(message)}
        </div>
      </div>
    );
  }
  const text = messageText(message).trim();
  return (
    <div className="flex flex-col gap-4">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return part.text.trim() ? (
            <div key={i} className="msg-in">
              <AnswerText text={part.text} />
            </div>
          ) : null;
        }
        if (!isToolUIPart(part)) return null;
        const name = getToolName(part);
        if (part.state === "output-available") {
          return <ToolResultCard key={part.toolCallId} name={name} result={part.output as ToolResult | undefined} />;
        }
        if (part.state === "output-error") {
          return (
            <p key={part.toolCallId} className={STEP_LINE}>
              <CircleExclamationIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ds-red)]" />
              {toolLabel(name)}: tallene kunne ikke hentes.
            </p>
          );
        }
        return (
          <p key={part.toolCallId} className={STEP_LINE}>
            <Spinner className="h-3.5 w-3.5" />
            {toolLabel(name)}…
          </p>
        );
      })}
      {!streaming && text && (
        <div className="-mt-2 flex items-center gap-1">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  );
}

export function ChatView({
  conversationId,
  initialMessages,
  configured,
  isNew,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  /** False: no Anthropic API key on the server. The page says so and the field is off. */
  configured: boolean;
  /** The conversation does not exist yet: the URL gets its id after the first question. */
  isNew: boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  // The bottom panel lies over the scrolling column. Its measured height is
  // the column's bottom padding, so the last message never hides under it.
  const [footerHeight, setFooterHeight] = useState(224);
  const scroller = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: conversationId,
    messages: initialMessages,
    generateId: newId,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ id, messages: all }) => ({ body: { id, message: all[all.length - 1] } }),
    }),
    // The list on the left shows the new conversation and its title.
    onFinish: () => router.refresh(),
  });

  const busy = status === "submitted" || status === "streaming";
  const isEmpty = messages.length === 0;
  const canSend = configured && !busy && input.trim() !== "";
  const last = messages[messages.length - 1];

  // Follow the answer only while the reader is at the bottom. Scrolling up to
  // read must not be pulled back; the "Nyeste" pill takes them down again.
  useEffect(() => {
    if (!atBottom) return;
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, status, atBottom, footerHeight]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = footer.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setFooterHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The field grows with the question, up to about seven lines.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  function jumpToLatest() {
    setAtBottom(true);
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !configured) return;
    clearError();
    setInput("");
    setAtBottom(true);
    if (isNew && messages.length === 0) {
      window.history.replaceState(null, "", `/chat?samtale=${conversationId}`);
    }
    void sendMessage({ text: question });
  }

  return (
    <>
      <div ref={scroller} className="scroll-area flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 sm:pt-12" style={{ paddingBottom: footerHeight + 32 }}>
          {isEmpty ? (
            <div className="flex flex-col gap-3 sm:gap-4">
              <p className="msg-in max-w-2xl text-[18px] leading-[1.5] tracking-[-0.005em] text-[var(--color-foreground)] sm:text-[22px] sm:leading-[1.55]">
                Spørg om ordrer, stationer, ventetid og nøgletal i produktionen.
              </p>
              <p
                role="note"
                className="msg-in flex max-w-2xl items-start gap-2.5 text-[16px] leading-[1.5] text-[var(--color-foreground)]/80 sm:text-[17px]"
              >
                <CircleInfoIcon size={18} className="mt-1 shrink-0 text-[var(--color-foreground)]/70" />
                <span>
                  <span className="font-semibold text-[var(--color-foreground)]">Jeg kan tage fejl.</span> Svarene bygger
                  kun på portalens egne data. Tjek tallene i portalen, før du handler på dem.
                </span>
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6 sm:gap-8">
              {messages.map((m) => (
                <MessageView key={m.id} message={m} streaming={busy && m === last} />
              ))}
              {status === "submitted" && (
                <p className="msg-in animate-pulse text-[18px] font-medium text-[var(--color-muted-foreground)] motion-reduce:animate-none">
                  Tænker…
                </p>
              )}
            </div>
          )}
        </div>
        {/* A streamed answer is silent to a screen reader: read it out when it is done. */}
        <div aria-live="polite" className="sr-only">
          {!busy && !error && last?.role === "assistant" ? messageText(last) : ""}
        </div>
      </div>

      {!atBottom && !isEmpty && (
        <button
          type="button"
          onClick={jumpToLatest}
          style={{ bottom: footerHeight + 12 }}
          className={cn(
            "tap-target absolute left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5",
            "border border-[var(--color-hairline)] bg-[var(--color-surface)] text-[13px] text-[var(--color-foreground)]",
            "shadow-[var(--shadow-md)] transition-colors hover:bg-[var(--color-muted)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          )}
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
          Nyeste
        </button>
      )}

      <footer ref={footer} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        {/* The messages fade out above the solid panel. */}
        <div
          aria-hidden
          className="h-8 w-full"
          style={{
            background:
              "linear-gradient(to top, var(--color-background) 0%, oklch(from var(--color-background) l c h / 0%) 100%)",
          }}
        />
        <div className="pointer-events-auto w-full bg-[var(--color-background)]">
          <div className="mx-auto max-w-3xl px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 sm:px-4 sm:pb-8">
            {!configured && (
              <Notice tone="warning" className="mb-4">
                AI er ikke konfigureret på denne server, så chatten kan ikke svare. Sæt ANTHROPIC_API_KEY på serveren.
                Tidligere samtaler kan stadig læses.
              </Notice>
            )}
            {error && (
              <Notice tone="error" className="mb-4">
                {errorText(error)}
              </Notice>
            )}
            {isEmpty && (
              <div className="msg-in mb-6 flex max-w-xl flex-wrap gap-2 sm:mb-10">
                {SUGGESTIONS.map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    size="sm"
                    disabled={!configured}
                    onClick={() => ask(s)}
                    className="tap-target max-w-full whitespace-normal rounded-full text-left leading-[16px] sm:text-[14px]"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            )}
            <div className="msg-in mb-4 flex flex-wrap items-end gap-2 sm:mb-5">
              <Tag size="small">Portalens data</Tag>
              {!isEmpty && (
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
              )}
            </div>
            <form
              className={cn("flex items-stretch gap-1.5 sm:gap-2", !configured && "opacity-60")}
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <FieldFrame
                disabled={!configured}
                className="flex min-w-0 flex-1 items-end p-[6px] focus-within:shadow-[inset_0_0_0_2px_var(--ds-green-80),var(--ds-shadow-input)] sm:p-[8px]"
              >
                <textarea
                  ref={field}
                  aria-label="Dit spørgsmål"
                  rows={1}
                  maxLength={4000}
                  placeholder={configured ? "Skriv dit spørgsmål her…" : "AI er ikke konfigureret"}
                  disabled={!configured}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      ask(input);
                    }
                  }}
                  className={cn(
                    "min-w-0 flex-1 resize-none overflow-y-auto bg-transparent outline-none",
                    "px-1.5 py-[7px] sm:px-2 sm:py-[5px]",
                    "text-[16px] font-normal leading-[22px] sm:text-[19px] sm:leading-[26px]",
                    "text-[var(--ds-grey-dark-09)] placeholder:text-[var(--ds-grey-medium-04)]",
                    "disabled:cursor-not-allowed disabled:text-[var(--ds-grey-medium-05)]"
                  )}
                />
              </FieldFrame>
              {busy ? (
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => stop()}
                  aria-label="Stop svaret"
                  title="Stop svaret"
                  className="h-11 shrink-0 px-3 sm:h-auto sm:px-8"
                >
                  <SquareIcon className="h-4 w-4 sm:mr-1.5" fill="currentColor" />
                  <span className="hidden sm:inline-block">Stop</span>
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="lg"
                  disabled={!canSend}
                  aria-label="Send"
                  className="h-11 shrink-0 px-3 sm:h-auto sm:px-8"
                >
                  <span className="hidden sm:inline-block">Send</span>
                  <ArrowUpIcon className="h-5 w-5 sm:hidden" />
                </Button>
              )}
            </form>
          </div>
        </div>
      </footer>
    </>
  );
}
