// GET /api/chat/dock: what the small chat on every page opens with
// (components/chat/chat-dock.tsx). The user's conversation of today, or the
// id of a new one. ?ny=1 asks for a new one ("Ny samtale").
//
// A route and not a server action: Next runs server actions one at a time,
// behind navigations, and the panel must open while a page is loading.

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { getPortalAccess } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { aiConfigured } from "../config";
import { loadLatestConversation } from "../store";

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

export async function GET(request: Request): Promise<Response> {
  const access = await getPortalAccess();
  if (!access) return Response.json({ error: "Ikke logget ind." }, { status: 401 });
  if (!can(access.role, "chat.use")) return Response.json({ error: "Ingen adgang." }, { status: 403 });

  const fresh = new URL(request.url).searchParams.get("ny") === "1";
  const configured = aiConfigured();
  const latest = fresh ? null : await loadLatestConversation(access.claims, Date.now() - CONTINUE_WITHIN_MS);
  const body: DockConversation = latest
    ? { id: latest.id, messages: latest.messages, isNew: false, configured }
    : { id: randomUUID(), messages: [], isNew: true, configured };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
