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
  | {
      /** A trend over time, drawn as a line. One point per week or month, oldest first. */
      kind: "line";
      title: string;
      /** What the values count, as the chart names it: "h" for hours, "min", "%". */
      unit?: string;
      points: LinePoint[];
    }
  | { kind: "note"; text: string };

/** One bucket of a line view. */
export interface LinePoint {
  /** Formatted name of the bucket: "Uge 46", "nov. 2026". */
  label: string;
  /** The number the line is drawn from, in the view's unit. Null for no data. */
  value: number | null;
  /** The value formatted (Danish), e.g. "11 t 20 min". */
  display: string;
  /** First day of the bucket as yyyy-MM-dd: the chart's x axis is a time axis. */
  start: string;
  /** Only on week buckets, so the chart names each week by its ISO number. */
  isoYear?: number;
  isoWeek?: number;
}

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
