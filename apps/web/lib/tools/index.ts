// The chat tools (docs/web-portal-plan.md section 5.1). Plain functions with
// a zod schema and a ToolContext; no import from `ai` or from the chat route,
// so the same tools can be served over MCP later.
//
// A role gets one tool per report query it may run (reportQueriesFor), plus
// station_timeline (reports.view) and search_documents. A tool it does not
// get is never offered to the model, and running one anyway still fails in
// runReportQuery (or the tool's own check) and in the database.

import { ZodError } from "zod";
import type { Claims } from "@/lib/db";
import { can } from "@/lib/portal/roles";
import { ReportAccessError, reportQueriesFor } from "@/lib/reports";
import { reportTool } from "./report-tools";
import { searchDocumentsTool } from "./search-documents";
import { stationTimelineTool } from "./station-timeline";
import type { ChatTool, ToolContext, ToolResult } from "./types";

export type { ChatTool, ToolContext, ToolResult, ToolView, ViewColumn } from "./types";
export { compact, compactResult, MAX_LIST } from "./compact";
export { findDocuments, searchDocuments, searchDocumentsTool } from "./search-documents";
export { stationTimeline, stationTimelineTool, TIMELINE_MAX_DAYS, TIMELINE_MAX_ROWS } from "./station-timeline";
export { buildSystemPrompt, buildSystemPromptParts, type PromptContext } from "./prompt";

/** The tools this role may use, in a fixed order (stable for prompt caching). */
export function chatToolsFor(claims: Claims): ChatTool[] {
  const timeline = can(claims.role, "reports.view") ? [stationTimelineTool as ChatTool] : [];
  return [...reportQueriesFor(claims).map(reportTool), ...timeline, searchDocumentsTool];
}

/** A tool result the model can read when the call failed: never a stack trace. */
export function toolErrorResult(error: unknown): ToolResult {
  if (error instanceof ReportAccessError) {
    return { data: { error: "forbidden", message: error.message }, views: [{ kind: "note", text: error.message }] };
  }
  if (error instanceof ZodError) {
    const message = `Ugyldige parametre: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
    return { data: { error: "invalid_input", message }, views: [] };
  }
  return {
    data: { error: "failed", message: "Værktøjet fejlede. Tallene kunne ikke hentes." },
    views: [{ kind: "note", text: "Tallene kunne ikke hentes." }],
  };
}

/**
 * Validates the input and runs one tool for this user. Never throws: an
 * unknown tool, a refused role or bad input comes back as an error result
 * the model can explain.
 */
export async function runChatTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  const tool = chatToolsFor(ctx.claims).find((t) => t.name === name);
  if (!tool) {
    return toolErrorResult(new ReportAccessError());
  }
  try {
    return await tool.run(ctx, tool.inputSchema.parse(input ?? {}));
  } catch (error) {
    if (!(error instanceof ReportAccessError) && !(error instanceof ZodError)) {
      console.error(`chat tool ${name} failed:`, error);
    }
    return toolErrorResult(error);
  }
}
