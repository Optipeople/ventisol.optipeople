// POST /api/chat: the streaming chat (docs/web-portal-plan.md section 5).
// The work is in handler.ts; this file wires in the session, the AI Gateway
// model and the clock.
//
// DELETE /api/chat?id=<conversation>: hides a conversation from the list.

import { getPortalAccess } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { aiConfigured, chatModelId } from "./config";
import { defaultAllow, handleChat } from "./handler";
import { archiveConversation } from "./store";

// A few tool calls and a long answer fit easily; the default is too short on Vercel.
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  return handleChat(request, {
    access: getPortalAccess,
    model: chatModelId,
    modelId: chatModelId,
    configured: aiConfigured,
    now: Date.now,
    allow: defaultAllow,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const access = await getPortalAccess();
  if (!access) return Response.json({ error: "Ikke logget ind." }, { status: 401 });
  if (!can(access.role, "chat.use")) return Response.json({ error: "Ingen adgang." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const archived = await archiveConversation(access.claims, id);
  return archived ? new Response(null, { status: 204 }) : Response.json({ error: "Samtalen findes ikke." }, { status: 404 });
}
