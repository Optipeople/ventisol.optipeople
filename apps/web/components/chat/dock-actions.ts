"use server";

// What the small chat on every page (chat-dock.tsx) opens with. It is read
// when the panel opens, not in the layout, so a page that never opens the
// chat pays nothing for it.

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { aiConfigured } from "@/app/api/chat/config";
import { loadLatestConversation } from "@/app/api/chat/store";
import { getPortalAccess } from "@/lib/auth";
import { can } from "@/lib/portal/roles";

/** The panel continues a conversation this fresh. An older one stays on the chat page. */
const CONTINUE_WITHIN_MS = 8 * 60 * 60_000;

export interface DockConversation {
  id: string;
  messages: UIMessage[];
  /** No conversation to continue: the id is new and the first question creates it. */
  isNew: boolean;
  /** False: no Anthropic API key on the server. */
  configured: boolean;
}

/**
 * The user's conversation of today, or a new one. `fresh` asks for a new one
 * ("Ny samtale"). Null when the user is signed out or may not chat.
 */
export async function openDockConversation(fresh = false): Promise<DockConversation | null> {
  const access = await getPortalAccess();
  if (!access || !can(access.role, "chat.use")) return null;
  const configured = aiConfigured();
  const latest = fresh ? null : await loadLatestConversation(access.claims, Date.now() - CONTINUE_WITHIN_MS);
  return latest
    ? { id: latest.id, messages: latest.messages, isNew: false, configured }
    : { id: randomUUID(), messages: [], isNew: true, configured };
}
