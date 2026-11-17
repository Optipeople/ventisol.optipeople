// search_documents: search in the text of the 3E production lists
// (doc.document_chunks, written by lib/sync/documents.ts from toSearchChunks).
//
// Hybrid of Danish full-text search (the generated tsv column) and trigram
// word similarity (pg_trgm), so both words ("terrassedør") and codes or
// half-typed names ("KF 68", "Hansen") find something. Chunks with every
// word of the query are the hits; only when there are none do chunks with
// some of the words count, most words first, and the answer says so
// (`matched: "some"`). The embedding column exists but nothing fills it yet, so there is no vector
// search: add it here once the sync writes embeddings.
//
// The answer always says how many chunks matched in all, and `offset` reads
// on from there, so the model knows when it has seen only a part.
//
// This is the one tool with its own SQL: document search is not a report
// figure, and it reads doc.* only, as the user (row level security applies).

import { z } from "zod";
import { withUser } from "@/lib/db";
import { compact } from "./compact";
import type { ChatTool, ToolContext, ToolResult } from "./types";

/** Longest piece of one chunk the model sees. Chunks are a position each. */
const MAX_CHUNK_CHARS = 1200;

/** Hits per call when the model does not say: more when it lists one order. */
const DEFAULT_LIMIT = 8;
const DEFAULT_ORDER_LIMIT = 20;

/** How alike a word in the chunk must be to the query to count as a trigram hit. */
const WORD_SIMILARITY = 0.5;

export const searchDocumentsSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Det der søges efter: få, præcise ord (et ord, en profil, et beslag, et mål, en kunde), ikke en hel sætning. Kan udelades når orderNo er givet: så listes ordrens positioner i rækkefølge."
    ),
  orderNo: z.number().int().min(1).optional().describe("Kun i denne ordres produktionsliste."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Højst så mange hits. Standard 8, eller 20 når kun orderNo er givet."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe("Spring så mange hits over. Brug den til at hente resten, når total er større end det du har fået."),
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

export interface DocumentSearch {
  hits: DocumentHit[];
  /** Chunks that match in all, also those before `offset` and after the last hit. */
  total: number;
  offset: number;
  /** "some": the query has several words and no chunk had them all, so hits have only some of them. */
  matched: "all" | "some";
}

interface HitRow {
  file_name: string;
  order_no: number | null;
  position: number | null;
  chunk_index: number;
  content: string;
  score: number | string;
  total: number | string;
  partial?: boolean;
}

/**
 * The search itself, as the user. An empty query with an order lists that
 * order's positions.
 *
 * A hit has every word of the query (`strict`) or is a trigram match. Only
 * when no chunk has every word do chunks with some of them count (`loose`,
 * the same words with "or" between them): otherwise one common word such as
 * "glas" would make half the table a hit. Ranking: the number of query
 * words in the chunk, then full-text rank plus trigram similarity. The
 * trigram test uses the `<%` operator so the gin_trgm_ops index can answer
 * it; its threshold is set for this transaction only. The query is read as
 * plain words (plainto_tsquery): a minus or "or" in it is not an operator,
 * so the three forms of the query always agree.
 */
export async function findDocuments(ctx: ToolContext, input: SearchDocumentsInput): Promise<DocumentSearch> {
  const query = input.query?.trim() ?? "";
  const offset = input.offset ?? 0;
  if (query === "" && input.orderNo == null) return { hits: [], total: 0, offset, matched: "all" };
  const limit = input.limit ?? (query === "" ? DEFAULT_ORDER_LIMIT : DEFAULT_LIMIT);

  const rows = await withUser(ctx.claims, async (db) => {
    if (query === "") {
      return db.query<HitRow>(
        `select file_name, order_no, "position", chunk_index, content, 0 as score, count(*) over () as total
           from doc.document_chunks
          where order_no = $1
          order by "position" nulls last, chunk_index
          limit $2 offset $3`,
        [input.orderNo, limit, offset]
      );
    }
    await db.query(`select set_config('pg_trgm.word_similarity_threshold', $1, true)`, [String(WORD_SIMILARITY)]);
    return db.query<HitRow>(
      `with q as (
         select plainto_tsquery('danish'::regconfig, $1) as strict,
                replace(plainto_tsquery('danish'::regconfig, $1)::text, ' & ', ' | ')::tsquery as loose,
                tsvector_to_array(to_tsvector('danish'::regconfig, $1)) as words
       ),
       s as (
         select exists (
           select 1 from doc.document_chunks c, q
            where ($2::integer is null or c.order_no = $2) and c.tsv @@ q.strict
         ) as found
       )
       select c.file_name, c.order_no, c."position", c.chunk_index, c.content,
              (select count(*) from unnest(q.words) w where w = any (tsvector_to_array(c.tsv)))
                + ts_rank(c.tsv, q.loose) + word_similarity($1, c.content) as score,
              count(*) over () as total,
              bool_or(not s.found and cardinality(q.words) > 1 and c.tsv @@ q.loose) over () as partial
         from doc.document_chunks c
        cross join q
        cross join s
        where ($2::integer is null or c.order_no = $2)
          and (c.tsv @@ q.strict or $1 <% c.content or (not s.found and c.tsv @@ q.loose))
        order by score desc, c.order_no desc nulls last, c."position" nulls last, c.chunk_index
        limit $3 offset $4`,
      [query, input.orderNo ?? null, limit, offset]
    );
  });

  // An offset past the last hit returns no row to carry the count: ask again from the start.
  const total =
    rows.length > 0
      ? Number(rows[0].total)
      : offset > 0
        ? (await findDocuments(ctx, { ...input, offset: 0, limit: 1 })).total
        : 0;

  return {
    hits: rows.map((r) => ({
      fileName: r.file_name,
      orderNo: r.order_no,
      position: r.position,
      chunkIndex: r.chunk_index,
      content: r.content.length > MAX_CHUNK_CHARS ? `${r.content.slice(0, MAX_CHUNK_CHARS)}…` : r.content,
      score: Math.round(Number(r.score) * 1000) / 1000,
    })),
    total,
    offset,
    matched: rows[0]?.partial === true ? "some" : "all",
  };
}

/** The hits alone. */
export async function searchDocuments(ctx: ToolContext, input: SearchDocumentsInput): Promise<DocumentHit[]> {
  return (await findDocuments(ctx, input)).hits;
}

export const searchDocumentsTool: ChatTool<typeof searchDocumentsSchema> = {
  name: "search_documents",
  description:
    "Søg i teksten i 3E-produktionslisterne (PDF'erne pr. ordre): elementer, profiler, glas, beslag, tilbehør, mål, leveringsuge. Brug den til spørgsmål om hvad en ordre indeholder, ikke til tider eller status. Svaret har total (alle hits) og more: er more true, har du kun set en del, så hent resten med offset eller sig at der er flere. matched 'some' betyder at ingen tekst havde alle ordene, så hits har kun nogle af dem: søg igen med færre ord.",
  inputSchema: searchDocumentsSchema,
  async run(ctx, input): Promise<ToolResult> {
    const { hits, total, offset, matched } = await findDocuments(ctx, input);
    return {
      // The model gets the text and where it is from; the score and the file
      // name (the order number again) are left out.
      data: compact({
        hits: hits.map((h) => ({ orderNo: h.orderNo, position: h.position, content: h.content })),
        count: hits.length,
        total,
        offset,
        more: offset + hits.length < total,
        // Only said when it matters: no chunk had every word.
        ...(matched === "some" ? { matched } : {}),
      }),
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
              total,
            },
      ],
      href: input.orderNo ? `/ordre/${input.orderNo}` : undefined,
    };
  },
};
