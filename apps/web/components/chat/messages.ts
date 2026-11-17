// From the AI SDK's messages to what the shared chat views draw. An AI SDK
// message is a list of parts (text, tool calls); the shared MessageRow takes
// one ChatMessage with Markdown and the tool steps that are still running.
// Finished tool calls are not part of ChatMessage: their tables and figures
// are this app's own views (tool-views.tsx), drawn beside the row.

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ChatMessage, ChatToolStep } from "@optipeople/ui/chat";
import type { ToolResult } from "@/lib/tools/types";

/** A tool call that has ended: with a result to draw, or failed. */
export type ToolOutcome =
  | { id: string; name: string; state: "done"; result: ToolResult | undefined }
  | { id: string; name: string; state: "failed" };

export interface ChatRow {
  message: ChatMessage;
  /** Ended tool calls of the message, in the order the model made them. */
  outcomes: ToolOutcome[];
}

export interface RowOptions {
  /** The text of a running step, by tool name. */
  toolLabel: (name: string) => string;
  /** When each running tool call was first seen, by tool call id (epoch ms). */
  startedAt: Readonly<Record<string, number>>;
  /** Start time for a running call that is not in `startedAt`. */
  fallbackStart: number;
}

export function toChatRow(message: UIMessage, options: RowOptions): ChatRow {
  const texts: string[] = [];
  const toolSteps: ChatToolStep[] = [];
  const outcomes: ToolOutcome[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim()) texts.push(part.text);
      continue;
    }
    if (!isToolUIPart(part)) continue;
    const name = getToolName(part);
    const id = part.toolCallId;
    if (part.state === "output-available") {
      outcomes.push({ id, name, state: "done", result: part.output as ToolResult | undefined });
    } else if (part.state === "output-error" || part.state === "output-denied") {
      outcomes.push({ id, name, state: "failed" });
    } else {
      toolSteps.push({
        id,
        name,
        label: `${options.toolLabel(name)}…`,
        startedAt: options.startedAt[id] ?? options.fallbackStart,
      });
    }
  }

  const role = message.role === "user" ? "user" : "assistant";
  return {
    message: {
      id: message.id,
      role,
      // The user's text is shown as written. The answer is Markdown, so its
      // text parts (before and after a tool call) become separate paragraphs.
      content: role === "user" ? texts.join("") : texts.join("\n\n"),
      toolSteps,
    },
    outcomes,
  };
}

/**
 * Changes whenever the conversation grows, also for each piece of a streamed
 * answer. ChatLayout follows the bottom when it does.
 */
export function growthKey(rows: ChatRow[]): string {
  const last = rows[rows.length - 1];
  if (!last) return "0";
  return `${rows.length}:${last.message.content.length}:${last.message.toolSteps?.length ?? 0}:${last.outcomes.length}`;
}
