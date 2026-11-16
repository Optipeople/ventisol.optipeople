// lib/tools as AI SDK tools. The only place the plain tool functions meet
// `ai`: the model reads `data` (toModelOutput), the UI gets the whole
// ToolResult with its views.

import { tool, type JSONValue, type ToolSet } from "ai";
import { chatToolsFor, runChatTool, type ToolContext, type ToolResult } from "@/lib/tools";

export function aiTools(ctx: ToolContext): ToolSet {
  const set: ToolSet = {};
  for (const t of chatToolsFor(ctx.claims)) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: (input: unknown): Promise<ToolResult> => runChatTool(ctx, t.name, input),
      toModelOutput: ({ output }) => ({
        type: "json",
        value: ((output as ToolResult | undefined)?.data ?? null) as JSONValue,
      }),
    });
  }
  return set;
}
