-- Trigram index for search_documents (apps/web/lib/tools/search-documents.ts).
--
-- The search tests `query <% content` (pg_trgm word similarity) beside the
-- full-text match. Without this index that test reads every chunk on every
-- search; with it Postgres answers both halves from an index.

create index document_chunks_content_trgm_idx on doc.document_chunks using gin (content gin_trgm_ops);
