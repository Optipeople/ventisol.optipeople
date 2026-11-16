"use client";

// One conversation: the messages, streaming answers with their tool results,
// and the question field. History lives on the server: the client sends only
// its new message with the conversation id (app/api/chat/handler.ts).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { Button, Spinner } from "@optipeople/ui";
import { Notice } from "@optipeople/ui/blocks";
import type { ToolResult } from "@/lib/tools/types";
import { AnswerText } from "./answer-text";
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

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] whitespace-pre-wrap rounded-[2px] bg-[var(--ds-blue-secondary)] px-3 py-2 text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]">
          {text}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {message.parts.map((part, i) => {
        if (part.type === "text") return part.text.trim() ? <AnswerText key={i} text={part.text} /> : null;
        if (!isToolUIPart(part)) return null;
        const name = getToolName(part);
        if (part.state === "output-available") {
          return <ToolResultCard key={part.toolCallId} name={name} result={part.output as ToolResult | undefined} />;
        }
        if (part.state === "output-error") {
          return (
            <p key={part.toolCallId} className="text-[13px] text-[var(--ds-grey-medium-05)]">
              {toolLabel(name)}: tallene kunne ikke hentes.
            </p>
          );
        }
        return (
          <p key={part.toolCallId} className="flex items-center gap-2 text-[13px] text-[var(--ds-grey-medium-05)]">
            <Spinner className="h-4 w-4" />
            {toolLabel(name)}…
          </p>
        );
      })}
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
  /** False: no AI Gateway credentials on the server. The page says so and the field is off. */
  configured: boolean;
  /** The conversation does not exist yet: the URL gets its id after the first question. */
  isNew: boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !configured) return;
    clearError();
    setInput("");
    if (isNew && messages.length === 0) {
      window.history.replaceState(null, "", `/chat?samtale=${conversationId}`);
    }
    void sendMessage({ text: question });
  }

  return (
    <div className="flex min-h-[60vh] flex-col">
      {!configured && (
        <Notice tone="warning" className="mb-4">
          AI er ikke konfigureret på denne server, så chatten kan ikke svare. Sæt AI_GATEWAY_API_KEY lokalt; på Vercel
          bruges OIDC. Tidligere samtaler kan stadig læses.
        </Notice>
      )}

      <div className="flex flex-1 flex-col gap-5" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
              Spørg om ordrer, stationer, ventetid og nøgletal. Svarene bygger kun på portalens egne data.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="ghost" size="pill" disabled={!configured} onClick={() => ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
        {status === "submitted" && (
          <p className="flex items-center gap-2 text-[13px] text-[var(--ds-grey-medium-05)]">
            <Spinner className="h-4 w-4" /> Tænker…
          </p>
        )}
        {error && <Notice tone="error">{errorText(error)}</Notice>}
        <div ref={bottom} />
      </div>

      <form
        className="sticky bottom-0 mt-5 flex items-end gap-2 border-t border-[var(--ds-grey-light-02)] bg-[var(--color-background,inherit)] pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          aria-label="Dit spørgsmål"
          className="min-h-[44px] flex-1 resize-y rounded-[2px] border border-[var(--ds-grey-light-03)] bg-[var(--color-surface)] px-3 py-2 text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)] disabled:opacity-60"
          rows={2}
          maxLength={4000}
          placeholder={configured ? "Skriv et spørgsmål…" : "AI er ikke konfigureret"}
          disabled={!configured}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={() => stop()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!configured || input.trim() === ""}>
            Send
          </Button>
        )}
      </form>
    </div>
  );
}
