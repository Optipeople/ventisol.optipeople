// search_documents: search in the text of the 3E production lists
// (doc.document_chunks, written by lib/sync/documents.ts from toSearchChunks).
//
// Hybrid of Danish full-text search (the generated tsv column) and trigram
// word similarity (pg_trgm), so both words ("terrassedør") and codes or
// half-typed names ("KF 68", "Hansen") find something. The embedding column
// exists but nothing fills it yet, so there is no vector search: add it here
// once the sync writes embeddings.
//
// This is the one tool with its own SQL: document search is not a report
// figure, and it reads doc.* only, as the user (row level security applies).

import { z } from "zod";
import { withUser } from "@/lib/db";
import { compact } from "./compact";
import type { ChatTool, ToolContext, ToolResult } from "./types";

/** Longest piece of one chunk the model sees. Chunks are a position each. */
const MAX_CHUNK_CHARS = 1200;

export const searchDocumentsSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Det der søges efter: et ord, en profil, et beslag, et mål, en kunde. Kan udelades når orderNo er givet."),
  orderNo: z.number().int().min(1).optional().describe("Kun i denne ordres produktionsliste."),
  limit: z.number().int().min(1).max(20).optional().describe("Højst så mange hits. Standard 8."),
});

export type SearchDocumentsInput = z.output<typeof searchDocumentsSchema>;

export interface DocumentHit {
  fileName: string;
  orderNo: number | null;
  position: number | null;
  chunkIndex: number;
  content: string;
  score: number;
}

interface HitRow {
  file_name: string;
  order_no: number | null;
  position: number | null;
  chunk_index: number;
  content: string;
  score: number | string;
}

/** The search itself, as the user. An empty query with an order lists that order's positions. */
export async function searchDocuments(ctx: ToolContext, input: SearchDocumentsInput): Promise<DocumentHit[]> {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 8;
  if (query === "" && input.orderNo == null) return [];

  const rows = await withUser(ctx.claims, (db) =>
    query === ""
      ? db.query<HitRow>(
          `select file_name, order_no, "position", chunk_index, content, 0 as score
             from doc.document_chunks
            where order_no = $1
            order by "position" nulls last, chunk_index
            limit $2`,
          [input.orderNo, limit]
        )
      : db.query<HitRow>(
          `with q as (select websearch_to_tsquery('danish'::regconfig, $1) as tsq)
           select c.file_name, c.order_no, c."position", c.chunk_index, c.content,
                  ts_rank(c.tsv, q.tsq) + ws.sim as score
             from doc.document_chunks c
            cross join q
            cross join lateral (select word_similarity($1, c.content) as sim) ws
            where ($2::integer is null or c.order_no = $2)
              and (c.tsv @@ q.tsq or ws.sim >= 0.5)
            order by score desc, c.order_no desc nulls last, c."position" nulls last, c.chunk_index
            limit $3`,
          [query, input.orderNo ?? null, limit]
        )
  );

  return rows.map((r) => ({
    fileName: r.file_name,
    orderNo: r.order_no,
    position: r.position,
    chunkIndex: r.chunk_index,
    content: r.content.length > MAX_CHUNK_CHARS ? `${r.content.slice(0, MAX_CHUNK_CHARS)}…` : r.content,
    score: Math.round(Number(r.score) * 1000) / 1000,
  }));
}

export const searchDocumentsTool: ChatTool<typeof searchDocumentsSchema> = {
  name: "search_documents",
  description:
    "Søg i teksten i 3E-produktionslisterne (PDF'erne pr. ordre): elementer, profiler, glas, beslag, tilbehør, mål, leveringsuge. Brug den til spørgsmål om hvad en ordre indeholder, ikke til tider eller status.",
  inputSchema: searchDocumentsSchema,
  async run(ctx, input): Promise<ToolResult> {
    const hits = await searchDocuments(ctx, input);
    return {
      data: compact({ hits, count: hits.length }),
      views: [
        hits.length === 0
          ? { kind: "note", text: "Ingen hits i produktionslisterne." }
          : {
              kind: "table",
              title: "Hits i produktionslisterne",
              columns: [
                { key: "order", label: "Ordre" },
                { key: "position", label: "Pos." },
                { key: "text", label: "Uddrag" },
              ],
              rows: hits.map((h) => ({
                order: h.orderNo == null ? "" : String(h.orderNo),
                position: h.position == null ? "" : String(h.position),
                text: h.content.split("\n").slice(0, 2).join(" · ").slice(0, 140),
              })),
              total: hits.length,
            },
      ],
      href: input.orderNo ? `/ordre/${input.orderNo}` : undefined,
    };
  },
};
