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
  type LanguageModelUsage,
  type SystemModelMessage,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { PortalAccess } from "@/lib/auth";
import { can } from "@/lib/portal/roles";
import { allowAttempt, clientIp, createAttemptLimits } from "@/lib/rate-limit";
import { buildSystemPromptParts, chatToolsFor, type ChatTool, type ToolContext } from "@/lib/tools";
import { dailyTokenBudget } from "./config";
import { estimateCostUsd } from "./pricing";
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

/** What a finished step tells about its cost (a slice of the AI SDK's StepResult). */
export interface StepUsage {
  usage: LanguageModelUsage;
  response?: { modelId?: string };
}

/**
 * The usage of the finished steps, summed. The cost is the list price of
 * those tokens. Null without steps.
 */
export function usageFromSteps(steps: readonly StepUsage[], fallbackModel: string): TurnUsage | null {
  if (steps.length === 0) return null;
  const model = steps.at(-1)?.response?.modelId || fallbackModel;
  const tokens = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let cacheWriteTokens = 0;
  for (const step of steps) {
    tokens.inputTokens += step.usage.inputTokens ?? 0;
    tokens.outputTokens += step.usage.outputTokens ?? 0;
    tokens.cachedTokens += step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    cacheWriteTokens += step.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  }
  return { model, ...tokens, costUsd: estimateCostUsd(model, { ...tokens, cacheWriteTokens }) };
}

/** The characters the tool definitions add to every request: names, descriptions and schemas. */
export function toolDefinitionChars(tools: readonly ChatTool[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += t.name.length + t.description.length;
    try {
      chars += JSON.stringify(z.toJSONSchema(t.inputSchema)).length;
    } catch {
      // A schema that does not convert is left out of the estimate.
    }
  }
  return chars;
}

/**
 * About 4 characters per token: the prompt was sent even when no step
 * finished. `promptChars` counts the tool definitions too, which are most of
 * a short request.
 */
export function estimatedUsage(model: string, promptChars: number): TurnUsage {
  const tokens = { inputTokens: Math.ceil(promptChars / 4), outputTokens: 0, cachedTokens: 0 };
  return { model, ...tokens, costUsd: estimateCostUsd(model, tokens) };
}

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
  // Two cache points. The first sits after the tools and the fixed part of
  // the system prompt, which are the same for every user of one role, so a
  // new conversation reads them from the cache instead of paying for them
  // again. The second (providerOptions on the request, below) follows the
  // end of the conversation. The dates and the role come after the first
  // point, so a new day does not empty the cache.
  const prompt = buildSystemPromptParts({ now, role: claims.role });
  const instructions: SystemModelMessage[] = [
    { role: "system", content: prompt.fixed, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
    { role: "system", content: prompt.current },
  ];
  const modelMessages = await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true });

  // The usage row is always written, also when the stream fails or is
  // aborted, so failed answers count against the daily budget too: from the
  // finished steps when there are any, else estimated from the prompt.
  const finishedSteps: StepUsage[] = [];
  let failed = false;
  let settled: TurnUsage | null = null;
  let resolveUsage: (usage: TurnUsage) => void = () => {};
  const usage = new Promise<TurnUsage>((resolve) => {
    resolveUsage = resolve;
  });
  const settle = (value: TurnUsage) => {
    settled ??= value;
    resolveUsage(settled);
  };
  const fallbackUsage = () =>
    usageFromSteps(finishedSteps, deps.modelId()) ??
    estimatedUsage(
      deps.modelId(),
      prompt.fixed.length +
        prompt.current.length +
        toolDefinitionChars(chatToolsFor(claims)) +
        JSON.stringify(modelMessages).length
    );

  const result = streamText({
    model: deps.model(),
    instructions,
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    reasoning: "medium",
    providerOptions: {
      // Prompt caching of the history: the cache point at the end of the
      // conversation. The one after the system prompt is set above.
      anthropic: {
        cacheControl: { type: "ephemeral" },
        metadata: { userId: claims.optiUserId },
      },
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
      toolDurations.set(toolCall.toolCallId, Math.round(toolExecutionMs));
    },
    onStepEnd: (step) => {
      finishedSteps.push(step);
    },
    onEnd: (event) => {
      settle(usageFromSteps(event.steps, deps.modelId()) ?? fallbackUsage());
    },
    // An error chunk ends its step with onStepEnd; onEnd follows only when a
    // step finished. The UI stream's onEnd settles from the steps otherwise.
    onError: ({ error }) => {
      console.error("chat: model stream failed:", error);
      failed = true;
    },
    onAbort: ({ steps }) => {
      settle(usageFromSteps(steps, deps.modelId()) ?? fallbackUsage());
    },
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
          // After a failure streamText may never call onEnd: do not wait for it.
          const turnUsage =
            settled ??
            (failed
              ? null
              : await Promise.race([
                  usage,
                  new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
                ])) ??
            fallbackUsage();
          await finishTurn(claims, body.id, responseMessage, turnUsage, toolDurations);
        } catch (error) {
          console.error("chat: storing the answer failed:", error);
        }
      },
    }),
  });
}
