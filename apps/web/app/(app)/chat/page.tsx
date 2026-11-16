import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { PageHeader, PageShell } from "@optipeople/ui/blocks";
import { aiConfigured } from "@/app/api/chat/config";
import { listConversations, loadConversation, UUID_RE } from "@/app/api/chat/store";
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

  return (
    <PageShell width="wide">
      <PageHeader
        title="Chat"
        intro="Stil spørgsmål til produktionens tal og ordrer. Svarene bygger kun på portalens egne data."
      />
      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <ConversationList
            activeId={conversation?.id ?? null}
            items={conversations.map((c) => ({ id: c.id, title: c.title, when: formatDayTime(c.updatedAt) }))}
          />
        </aside>
        <section aria-label={conversation?.title ?? "Ny samtale"} className="min-w-0">
          <ChatView
            key={conversationId}
            conversationId={conversationId}
            initialMessages={conversation?.messages ?? []}
            configured={aiConfigured()}
            isNew={!conversation}
          />
        </section>
      </div>
    </PageShell>
  );
}
