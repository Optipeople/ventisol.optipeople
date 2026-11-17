"use client";

// The sidebar beside the chat: the shared dark drawer (KnowledgeDrawer) with
// one tab, the user's conversations, newest first. The rows are this app's
// own: each is a link (?samtale=<id>) with a button that hides the
// conversation (DELETE /api/chat archives it), which the shared
// ConversationList does not have.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { MessageSquare } from "lucide-react";
import { buttonClasses, cn, TrashIcon } from "@optipeople/ui";
import { KnowledgeDrawer, useKnowledgeDrawer } from "@optipeople/ui/chat";
import { useChatSidebar } from "./chat-shell";

export interface ConversationItem {
  id: string;
  title: string;
  /** Already formatted, Danish. */
  when: string;
}

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]";

function NewConversationLink() {
  const drawer = useKnowledgeDrawer();
  return (
    <Link
      href="/chat"
      onClick={() => drawer?.closeOnMobile()}
      className={buttonClasses({ variant: "secondary", className: "w-full" })}
    >
      Ny samtale
    </Link>
  );
}

function ConversationRows({ items, activeId }: { items: ConversationItem[]; activeId: string | null }) {
  const router = useRouter();
  const drawer = useKnowledgeDrawer();
  const [pending, startTransition] = useTransition();

  function archive(id: string) {
    startTransition(async () => {
      await fetch(`/api/chat?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (id === activeId) router.push("/chat");
      router.refresh();
    });
  }

  if (items.length === 0) {
    return <p className="px-4 py-8 text-center text-[15px] text-white/70 sm:px-6">Ingen samtaler endnu.</p>;
  }

  return (
    <ul className={cn("flex flex-col", pending && "opacity-60")}>
      {items.map((c) => {
        const active = c.id === activeId;
        return (
          <li
            key={c.id}
            className={cn("group relative rounded-[4px] transition-colors hover:bg-white/10", active && "bg-white/15")}
          >
            <Link
              href={`/chat?samtale=${c.id}`}
              // The chat is under the drawer on a phone: get out of its way.
              onClick={() => drawer?.closeOnMobile()}
              aria-current={active ? "page" : undefined}
              className={cn("flex w-full items-start gap-2.5 rounded-[4px] py-3 pl-4 pr-12 text-left sm:pl-6", FOCUS_RING)}
            >
              <MessageSquare className="mt-0.5 h-5 w-5 shrink-0 text-white/70 group-hover:text-white" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium text-white">{c.title}</span>
                <span className="mt-0.5 block text-[13px] text-white/70">{c.when}</span>
              </span>
            </Link>
            <button
              type="button"
              aria-label={`Skjul samtalen ${c.title}`}
              title="Skjul samtalen"
              onClick={() => archive(c.id)}
              className={cn(
                "tap-target absolute right-2 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded text-white/70",
                "opacity-0 hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                FOCUS_RING
              )}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ConversationSidebar({ items, activeId }: { items: ConversationItem[]; activeId: string | null }) {
  const { open, setOpen } = useChatSidebar();
  return (
    <KnowledgeDrawer
      title="Samtaler"
      open={open}
      onOpenChange={setOpen}
      footerAction={<NewConversationLink />}
      tabs={[
        {
          id: "samtaler",
          label: "Samtaler",
          description: "Dine tidligere samtaler. Vælg en for at fortsætte den.",
          content: <ConversationRows items={items} activeId={activeId} />,
        },
      ]}
    />
  );
}
