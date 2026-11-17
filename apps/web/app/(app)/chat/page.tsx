import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { aiConfigured } from "@/app/api/chat/config";
import { listConversations, loadConversation, UUID_RE } from "@/app/api/chat/store";
import { ChatShell } from "@/components/chat/chat-shell";
import { ChatView } from "@/components/chat/chat-view";
import { ConversationList } from "@/components/chat/conversation-list";
import { requireCapability } from "@/lib/auth";
import { formatDayTime } from "@/lib/reports/format";

export const metadata: Metadata = { title: "Chat" };

// The AI chat (docs/web-portal-plan.md 4.5 and 5). ?samtale=<id> opens a
// conversation; without it a new one starts, with an id made here so the
// first question can create it.
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ samtale?: string }> }) {
  const { samtale } = await searchParams;
  const requested = samtale && UUID_RE.test(samtale) ? samtale : null;
  const ctx = await requireCapability(requested ? `/chat?samtale=${requested}` : "/chat", "chat.use");

  const [conversations, conversation] = await Promise.all([
    listConversations(ctx.claims),
    requested ? loadConversation(ctx.claims, requested) : Promise.resolve(null),
  ]);
  const conversationId = conversation?.id ?? randomUUID();

  // No PageShell here: like Opti Assist, the chat fills the window under the
  // header and the tabs, with its own sidebar and its own scrolling column.
  return (
    <ChatShell
      sidebar={
        <ConversationList
          activeId={conversation?.id ?? null}
          items={conversations.map((c) => ({ id: c.id, title: c.title, when: formatDayTime(c.updatedAt) }))}
        />
      }
    >
      <h1 className="sr-only">Chat</h1>
      <section aria-label={conversation?.title ?? "Ny samtale"} className="flex min-h-0 flex-1 flex-col">
        <ChatView
          key={conversationId}
          conversationId={conversationId}
          initialMessages={conversation?.messages ?? []}
          configured={aiConfigured()}
          isNew={!conversation}
        />
      </section>
    </ChatShell>
  );
}
