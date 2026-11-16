import type { Metadata } from "next";
import { EmptyState, PageHeader, PageShell } from "@optipeople/ui/blocks";
import { requireCapability } from "@/lib/auth";

export const metadata: Metadata = { title: "Chat" };

// Placeholder until the chat is built (docs/web-portal-plan.md 5).
export default async function ChatPage() {
  await requireCapability("/chat", "chat.use");
  return (
    <PageShell width="wide">
      <PageHeader title="Chat" intro="Stil spørgsmål til produktionens tal og ordrer." />
      <EmptyState title="Kommer snart">Chatten er på vej.</EmptyState>
    </PageShell>
  );
}
