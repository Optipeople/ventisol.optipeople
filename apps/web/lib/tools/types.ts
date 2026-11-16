// The shape every chat tool has. Transport free: no import from `ai` or from
// the chat route (docs/portal-architecture.md section 5), so an MCP endpoint
// can expose the same functions later without rewriting them.

import type { z } from "zod";
import type { Claims } from "@/lib/db";

/** Who asks and when. Tools never read the clock themselves. */
export interface ToolContext {
  claims: Claims;
  /** "Now" as epoch milliseconds. */
  now: number;
}

/** One column of a table view. Values in the rows are already formatted (Danish). */
export interface ViewColumn {
  key: string;
  label: string;
  align?: "right";
}

/**
 * What the chat UI draws for a tool result. Small and formatted on the
 * server, so the client needs no knowledge of the report types.
 */
export type ToolView =
  | { kind: "kpis"; title: string; items: { label: string; value: string; note?: string }[] }
  | {
      kind: "table";
      title: string;
      columns: ViewColumn[];
      rows: Record<string, string>[];
      /** Rows before the view was cut to its first rows. */
      total?: number;
    }
  | {
      kind: "bars";
      title: string;
      items: { label: string; value: number; display: string }[];
    }
  | { kind: "note"; text: string };

/** What a tool returns: compact JSON for the model, views for the screen. */
export interface ToolResult {
  /** Compact JSON: the only part the model reads. */
  data: unknown;
  /** What the UI shows. Not sent to the model. */
  views: ToolView[];
  /** The portal page that shows the same numbers, for "se mere". */
  href?: string;
}

export interface ChatTool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Danish, for the model. */
  description: string;
  /** What the model may send. Validated before run. */
  inputSchema: S;
  run(ctx: ToolContext, input: z.output<S>): Promise<ToolResult>;
}
