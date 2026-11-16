// The chat request, apart from Next: route.ts wires in the real session,
// model and clock, the tests a mock model (lib/tools/chat-route.test.ts).
//
// Flow: signed in (401) -> may chat (403) -> AI configured (503) -> rate
// limit (429) -> daily token budget (429) -> body (400) -> conversation is
// the user's (404) -> stream. The history is loaded on the server; the client
// sends only its new message. The answer, its tool calls and the usage row
// are stored when the stream ends, also when the client has gone away.

import { randomUUID } from "node:crypto";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { PortalAccess } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { allowAttempt, clientIp, createAttemptLimits } from "@/lib/rate-limit";
import { buildSystemPrompt, type ToolContext } from "@/lib/tools";
import { dailyTokenBudget, FALLBACK_CHAT_MODELS } from "./config";
import { estimateCostUsd, gatewayCost } from "./pricing";
import { beginTurn, finishTurn, tokensUsedToday, UUID_RE, type TurnUsage } from "./store";
import { aiTools } from "./tools";

/** 30 questions per 10 minutes per user (and IP), 120 per IP. */
export const chatLimits = createAttemptLimits({ name: "chat", windowMs: 10 * 60_000, ipLimit: 120, accountLimit: 30 });

/** Model calls in one answer: enough for a few tools in a row, not a runaway loop. */
const MAX_STEPS = 8;

/** Longest question. */
const MAX_TEXT = 4000;

export interface ChatDeps {
  access(): Promise<PortalAccess | null>;
  model(): LanguageModel;
  /** The model id stored in ai.usage_events when the response does not say. */
  modelId(): string;
  configured(): boolean;
  now(): number;
  allow(ip: string, optiUserId: string): Promise<boolean>;
}

const bodySchema = z.object({
  id: z.string().regex(UUID_RE),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(MAX_TEXT) }))
      .min(1)
      .max(10),
  }),
});

const json = (status: number, error: string) => Response.json({ error }, { status });

export const defaultAllow = (ip: string, user: string) => allowAttempt(chatLimits, ip, user);

export async function handleChat(request: Request, deps: ChatDeps): Promise<Response> {
  const access = await deps.access();
  if (!access) return json(401, "Ikke logget ind.");
  if (!can(access.role, "chat.use")) return json(403, "Din rolle har ikke adgang til chatten.");
  if (!deps.configured()) return json(503, "AI er ikke konfigureret på denne server.");

  const { claims } = access;
  if (!(await deps.allow(clientIp(request.headers), claims.optiUserId))) {
    return json(429, "For mange spørgsmål på kort tid. Prøv igen om lidt.");
  }

  const now = deps.now();
  if ((await tokensUsedToday(claims, now)) >= dailyTokenBudget()) {
    return json(429, "Dagens forbrug af AI er brugt op. Prøv igen i morgen.");
  }

  // JSON only: a cross-site form cannot send it without a CORS preflight.
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json(415, "Ugyldig forespørgsel.");
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return json(400, "Ugyldig forespørgsel.");
  }
  const message: UIMessage = {
    id: UUID_RE.test(body.message.id) ? body.message.id : randomUUID(),
    role: "user",
    parts: body.message.parts,
  };

  const turn = await beginTurn(claims, body.id, message);
  if (!turn) return json(404, "Samtalen findes ikke.");

  const ctx: ToolContext = { claims, now };
  const tools = aiTools(ctx);

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: [...turn.history, message], tools });
  } catch (error) {
    // A stored message no longer matches the tools (a tool was removed or the
    // role changed): answer this question without the old history.
    console.error("chat: stored history did not validate, starting without it:", error);
    messages = [message];
  }

  const assistantId = randomUUID();
  const toolDurations = new Map<string, number>();
  let resolveUsage: (usage: TurnUsage | null) => void = () => {};
  const usage = new Promise<TurnUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  const result = streamText({
    model: deps.model(),
    instructions: buildSystemPrompt({ now, role: claims.role }),
    messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    reasoning: "medium",
    providerOptions: {
      gateway: {
        caching: "auto",
        models: FALLBACK_CHAT_MODELS,
        user: claims.optiUserId,
        tags: ["ventisol-chat"],
      },
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
      toolDurations.set(toolCall.toolCallId, Math.round(toolExecutionMs));
    },
    onEnd: (event) => {
      const model = event.finalStep?.response?.modelId || deps.modelId();
      const tokens = {
        inputTokens: event.usage.inputTokens ?? 0,
        outputTokens: event.usage.outputTokens ?? 0,
        cachedTokens: event.usage.inputTokenDetails?.cacheReadTokens ?? 0,
      };
      const reported = event.steps.map((s) => gatewayCost(s.providerMetadata));
      const costUsd = reported.every((c) => c != null)
        ? reported.reduce<number>((sum, c) => sum + (c ?? 0), 0)
        : estimateCostUsd(model, tokens);
      resolveUsage({ model, ...tokens, costUsd });
    },
    onError: ({ error }) => {
      console.error("chat: model stream failed:", error);
      resolveUsage(null);
    },
    onAbort: () => resolveUsage(null),
  });

  // Run to the end even when the browser goes away, so the answer is stored.
  void result.consumeStream();

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: messages,
      generateMessageId: () => assistantId,
      sendReasoning: false,
      onError: () => "Svaret kunne ikke hentes. Prøv igen om lidt.",
      onEnd: async ({ responseMessage }) => {
        try {
          const turnUsage = await Promise.race([
            usage,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
          ]);
          if (responseMessage.parts.length > 0 || turnUsage) {
            await finishTurn(claims, body.id, responseMessage, turnUsage, toolDurations);
          }
        } catch (error) {
          console.error("chat: storing the answer failed:", error);
        }
      },
    }),
  });
}
