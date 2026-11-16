"use client";

// The user's conversations beside the chat, newest first, with "Ny samtale"
// and a way to hide one (DELETE /api/chat archives it).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { buttonClasses, IconButton, TrashIcon } from "@optipeople/ui";
import { cn } from "@optipeople/ui";

export interface ConversationItem {
  id: string;
  title: string;
  /** Already formatted, Danish. */
  when: string;
}

export function ConversationList({ items, activeId }: { items: ConversationItem[]; activeId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function archive(id: string) {
    startTransition(async () => {
      await fetch(`/api/chat?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (id === activeId) router.push("/chat");
      router.refresh();
    });
  }

  return (
    <nav aria-label="Samtaler" className="flex flex-col gap-3">
      <Link href="/chat" className={buttonClasses({ variant: "primary", size: "compact" })}>
        Ny samtale
      </Link>
      {items.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-grey-medium-05)]">Ingen samtaler endnu.</p>
      ) : (
        <ul className={cn("flex flex-col gap-1", pending && "opacity-60")}>
          {items.map((c) => (
            <li
              key={c.id}
              className={cn(
                "group flex items-start gap-1 rounded-[2px] border border-transparent",
                c.id === activeId
                  ? "border-[var(--ds-grey-light-02)] bg-[var(--color-surface)]"
                  : "hover:bg-[var(--ds-grey-light-01)]"
              )}
            >
              <Link
                href={`/chat?samtale=${c.id}`}
                aria-current={c.id === activeId ? "page" : undefined}
                className="min-w-0 flex-1 px-2 py-1.5"
              >
                <span className="block truncate text-[13px] leading-[18px] text-[var(--ds-grey-dark-09)]">{c.title}</span>
                <span className="block text-[11px] leading-[14px] text-[var(--ds-grey-medium-05)]">{c.when}</span>
              </Link>
              <IconButton
                aria-label={`Skjul samtalen ${c.title}`}
                title="Skjul samtalen"
                className="mt-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => archive(c.id)}
              >
                <TrashIcon className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
