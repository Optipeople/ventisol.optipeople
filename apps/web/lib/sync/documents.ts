// Document sync: mirrors the OptiCloud list VentisolOrderDocuments (one row
// per 3E production list PDF, docs/order-documents.md) into
// raw.order_documents, parses each PDF once, and keeps its search chunks in
// doc.document_chunks.
//
// Two steps, both idempotent:
//
// 1. THE LIST. Every row of the list is read (it is small: one row per
//    printed order) and upserted by file name, at most every 5 minutes. A row
//    whose Sha256 or file reference changed is marked for parsing again. A
//    row without a file yet (the station writes the row first and uploads
//    the file after) is stored as it is and simply has nothing to parse
//    until the file shows up in a later read. A stored row that a complete
//    read of the list no longer holds is deleted (its chunks go with it),
//    unless more than a fifth of the rows (and more than 5) would go: that
//    says the read is wrong, not the list.
//
// 2. THE QUEUE. Rows with a file that are not parsed, or were parsed by
//    another PARSER_VERSION, are taken newest print date first: fetch the
//    bytes, parse, store `parsed`, `parsed_at`, `parser_version`,
//    `parse_problems` and replace the file's chunks, all in one transaction
//    per file. A run takes at most DOCUMENT_MAX_FILES files and
//    DOCUMENT_MAX_BYTES bytes and stops at its deadline, so months of files
//    are worked off over several runs. The queue is the table itself, so
//    nothing is lost between runs.
//
// A file that cannot be fetched is tried again later with a growing wait (5
// minutes doubling up to 6 hours, kept in app.sync_state), so one broken file
// never holds up the others. A file over 50 MB is not read, as on the
// station. The parser never throws: what it could not read is stored in
// parse_problems.
//
// SEVERAL FILES FOR ONE ORDER (reprints, prefixes) are all stored. Readers
// pick the newest the way the station's locator does: newest print_date
// (the date in the name), then newest claimed_at, then the file name. See
// NEWEST_DOCUMENT_ORDER.
//
// BS FILES ("58931_20261127BS.pdf", "B S tegninger 58931_20261112.pdf", see
// lib/orderdoc/file-name.ts) are an order's arched and bevelled positions and
// their drawings, beside its list. They are stored with prefix "BS" or "BS
// tegninger" and always without a print_date, so every reader that orders by
// print_date desc nulls last keeps the order's own list first; a BS file only
// stands for the order when it has nothing else.
//
// Element type rules come from config.element_types.recognition when that
// table has active rows with rules, else DEFAULT_ELEMENT_TYPE_RULES.
//
// Embeddings are left null here. writeChunks keeps the embedding of a chunk
// whose text did not change and clears it when the text did, so a later step
// can fill in `where embedding is null` and never has stale vectors.

import { createHash } from "node:crypto";
import { withService, type Db } from "@/lib/db";
import {
  DEFAULT_ELEMENT_TYPE_RULES,
  PARSER_VERSION,
  parseOrderDocument,
  kindLabel,
  parseOrderFileName,
  toSearchChunks,
  type ElementTypeRule,
  type OrderDocument,
  type SearchChunk,
} from "@/lib/orderdoc";
import { applyDocumentChanges, type ApplyResult } from "@/lib/readmodel";
import { getValue, type MasterDataRow } from "@/lib/scans";
import {
  BlobTooLargeError,
  DOCUMENT_TABLE_NAME,
  getOptiCloud,
  type OptiCloudSource,
  type ServiceAccess,
} from "./opticloud-service";
import { handOver } from "./handover";
import { asInt, asIsoTime, asText, failureStatus, recordNoAccess, walkPages } from "./scans";
import {
  appendPending,
  dropPending,
  errorText,
  JOBS,
  PRIVATE,
  readPending,
  readState,
  writeState,
  type JobStatus,
} from "./state";

/** Files parsed per run at most. */
export const DOCUMENT_MAX_FILES = 15;
/** Bytes fetched per run at most (the first file of a run is always taken). */
export const DOCUMENT_MAX_BYTES = 30 * 1024 * 1024;
/** A PDF over this size is not read (OrderDocuments.MaxPdfBytes on the station). */
export const DOCUMENT_MAX_PDF_BYTES = 50 * 1024 * 1024;
/** The list is read again when the last read is this old. */
export const DOCUMENT_LIST_INTERVAL_MS = 5 * 60_000;
/** Pages of the list read at most (500 rows each). */
export const DOCUMENT_LIST_MAX_PAGES = 40;

const RETRY_FIRST_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
/** Failing files remembered at most. */
const MAX_RETRY_NOTES = 200;

/**
 * How to pick the newest document of an order, as an `order by` for
 * raw.order_documents: the rule of the station's OrderDocumentLocator
 * (newest date in the name, then the newest row).
 */
export const NEWEST_DOCUMENT_ORDER =
  "print_date desc nulls last, claimed_at desc nulls last, file_name desc";

// --- element type rules ---

const RULE_KEYS = ["anyOpeningContains", "noOpeningContains", "minFields", "maxFields"] as const;

function asRule(value: unknown, typeId: string): ElementTypeRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  // A rule stored on a type's row gives that type unless it names another.
  const rule: ElementTypeRule = { type: typeof v.type === "string" && v.type.length > 0 ? v.type : typeId };
  for (const key of RULE_KEYS) {
    if (v[key] !== undefined && v[key] !== null) (rule as unknown as Record<string, unknown>)[key] = v[key];
  }
  return rule;
}

/**
 * The rules in config.element_types, in sort order (the first rule that
 * matches wins). `recognition` may be one rule object, a list of them, or
 * `{ rules: [...] }`. Without any usable rule: the built-in defaults.
 */
export async function loadElementTypeRules(db: Db): Promise<ElementTypeRule[]> {
  const rows = await db.query<{ id: string; recognition: unknown }>(
    "select id, recognition from config.element_types where active order by sort_order, id"
  );
  const rules: ElementTypeRule[] = [];
  for (const row of rows) {
    const r = row.recognition;
    const list = Array.isArray(r)
      ? r
      : r && typeof r === "object" && Array.isArray((r as { rules?: unknown }).rules)
        ? (r as { rules: unknown[] }).rules
        : [r];
    for (const item of list) {
      const rule = asRule(item, row.id);
      if (rule) rules.push(rule);
    }
  }
  return rules.length > 0 ? rules : DEFAULT_ELEMENT_TYPE_RULES;
}

// --- the list ---

interface RawDocument {
  file_name: string;
  order_no: number | null;
  prefix: string | null;
  print_date: string | null;
  blob_reference: string | null;
  blob_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  device: string | null;
  claimed_at: string | null;
  row_id: string | null;
}

/** One list row to one mirror row. Null without a file name. */
export function toRawDocument(row: MasterDataRow): RawDocument | null {
  const v = row.values ?? {};
  const fileName = asText(getValue(v, "FileName"));
  if (!fileName) return null;
  const name = parseOrderFileName(fileName);
  // The Blob column: { name, contentType, reference }, or a bare reference.
  const file = getValue(v, "File");
  const blob =
    file && typeof file === "object"
      ? (file as Record<string, unknown>)
      : typeof file === "string"
        ? { reference: file }
        : {};
  // A BS file has no print_date (see BS FILES above): the station writes one, the readers must not see it.
  const bs = name !== null && name.kind !== "list";
  const printDate = bs ? null : (asIsoTime(getValue(v, "PrintDate"))?.slice(0, 10) ?? name?.printDate ?? null);
  const namePrefix = name ? [name.prefix, kindLabel(name.kind)].filter((p) => p.length > 0).join("_") : "";
  return {
    file_name: fileName,
    order_no: asInt(getValue(v, "OrderNo")) ?? name?.orderNumber ?? null,
    // Rows put up before the BS names were known have an empty Prefix: the name gives it.
    prefix: (bs ? null : asText(getValue(v, "Prefix"))) ?? (namePrefix || null),
    print_date: printDate,
    blob_reference: asText(getValue(blob, "reference")),
    blob_name: asText(getValue(blob, "name")),
    content_type: asText(getValue(blob, "contentType")),
    size_bytes: asInt(getValue(v, "SizeBytes")),
    sha256: asText(getValue(v, "Sha256"))?.toLowerCase() ?? null,
    device: asText(getValue(v, "Device")),
    claimed_at: asIsoTime(getValue(v, "ClaimedAt")),
    row_id: asText(row.id),
  };
}

const DOC_COLUMNS = [
  "file_name",
  "order_no",
  "prefix",
  "print_date",
  "blob_reference",
  "blob_name",
  "content_type",
  "size_bytes",
  "sha256",
  "device",
  "claimed_at",
  "row_id",
] as const;
const DOC_VALUE_COLUMNS = DOC_COLUMNS.filter((c) => c !== "file_name");

// One statement per batch. A changed hash or file reference clears parsed_at,
// which puts the row in the queue; the old `parsed` stays until the new one
// replaces it.
const UPSERT_DOCS_SQL = `
  insert into raw.order_documents as d (${DOC_COLUMNS.join(", ")}, synced_at)
  select ${DOC_COLUMNS.map((c) => `r.${c}`).join(", ")}, $2::timestamptz
    from jsonb_to_recordset($1::jsonb) as r(
      file_name text, order_no integer, prefix text, print_date date, blob_reference text,
      blob_name text, content_type text, size_bytes integer, sha256 text, device text,
      claimed_at timestamptz, row_id text)
  on conflict (file_name) do update set
    ${DOC_VALUE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")},
    synced_at = excluded.synced_at,
    parsed_at = case
      when d.sha256 is distinct from excluded.sha256
        or d.blob_reference is distinct from excluded.blob_reference then null
      else d.parsed_at end
  where (${DOC_VALUE_COLUMNS.map((c) => `d.${c}`).join(", ")})
    is distinct from (${DOC_VALUE_COLUMNS.map((c) => `excluded.${c}`).join(", ")})
  returning d.file_name, (d.xmax = 0) as inserted`;

async function upsertDocuments(
  db: Db,
  docs: RawDocument[],
  now: number
): Promise<{ inserted: number; changed: number }> {
  if (docs.length === 0) return { inserted: 0, changed: 0 };
  const rows = await db.query<{ inserted: boolean }>(UPSERT_DOCS_SQL, [
    JSON.stringify(docs),
    new Date(now).toISOString(),
  ]);
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, changed: rows.length - inserted };
}

interface ListOutcome {
  listed: number;
  inserted: number;
  changed: number;
  removed: number;
  /** Every page was read. */
  complete: boolean;
  /** Stored rows the list no longer holds were left alone: too many at once. */
  removalRefused: boolean;
}

async function mirrorList(
  source: OptiCloudSource,
  tableId: string,
  now: number,
  deadline: number
): Promise<ListOutcome> {
  const docs = new Map<string, RawDocument>();
  const walk = await walkPages({
    load: (page) => source.loadRowsPage(tableId, page, { orderBy: "FileName", ascending: true }),
    startPage: 1,
    maxPages: DOCUMENT_LIST_MAX_PAGES,
    deadline,
    onPage: async (_page, rows) => {
      for (const row of rows) {
        const doc = toRawDocument(row);
        if (doc) docs.set(doc.file_name, doc);
      }
      return "continue";
    },
  });
  const outcome: ListOutcome = {
    listed: docs.size,
    inserted: 0,
    changed: 0,
    removed: 0,
    complete: walk.reason === "end",
    removalRefused: false,
  };

  await withService(async (db) => {
    const all = [...docs.values()];
    for (let i = 0; i < all.length; i += 500) {
      const batch = await upsertDocuments(db, all.slice(i, i + 500), now);
      outcome.inserted += batch.inserted;
      outcome.changed += batch.changed;
    }
    if (!outcome.complete || source.partialDocumentList) return;
    const stored = await db.query<{ file_name: string; order_no: number | null }>(
      "select file_name, order_no from raw.order_documents"
    );
    const gone = stored.filter((r) => !docs.has(r.file_name));
    if (gone.length === 0) return;
    if (gone.length > Math.max(5, stored.length / 5)) {
      outcome.removalRefused = true;
      return;
    }
    // doc.document_chunks follows by its foreign key.
    await db.query("delete from raw.order_documents where file_name = any($1::text[])", [
      gone.map((r) => r.file_name),
    ]);
    outcome.removed = gone.length;
    await appendPending(
      db,
      PRIVATE.pendingOrders,
      gone.map((r) => r.order_no).filter((n) => n != null)
    );
  });
  return outcome;
}

// --- chunks ---

/**
 * Makes the chunks of one file equal to `chunks`, in this order. A chunk
 * whose text is unchanged keeps its embedding; one whose text changed gets a
 * null embedding; chunks beyond the new count are deleted. New chunks have a
 * null embedding: fill them in later with `where embedding is null`.
 */
export async function writeChunks(
  db: Db,
  fileName: string,
  orderNo: number | null,
  chunks: Pick<SearchChunk, "position" | "content">[]
): Promise<void> {
  await db.query(
    `insert into doc.document_chunks as c (file_name, order_no, "position", chunk_index, content)
     select $1, $2::integer, t.pos, (t.n - 1)::integer, t.content
       from unnest($3::integer[], $4::text[]) with ordinality as t(pos, content, n)
     on conflict (file_name, chunk_index) do update set
       order_no = excluded.order_no,
       "position" = excluded."position",
       content = excluded.content,
       embedding = case when c.content is distinct from excluded.content then null else c.embedding end`,
    [fileName, orderNo, chunks.map((c) => c.position), chunks.map((c) => c.content)]
  );
  await db.query("delete from doc.document_chunks where file_name = $1 and chunk_index >= $2", [
    fileName,
    chunks.length,
  ]);
}

/**
 * Writes the chunks of every parsed document again from the stored `parsed`
 * JSON, without fetching a file. For when the element type rules changed
 * (the type name is part of the chunk text). Returns the number of files.
 */
export async function rebuildDocumentChunks(): Promise<number> {
  let after = "";
  let files = 0;
  for (;;) {
    const batch = await withService(async (db) => {
      const rules = await loadElementTypeRules(db);
      const rows = await db.query<{ file_name: string; order_no: number | null; parsed: OrderDocument }>(
        `select file_name, order_no, parsed from raw.order_documents
          where parsed is not null and file_name > $1
          order by file_name limit 50`,
        [after]
      );
      for (const row of rows) {
        await writeChunks(db, row.file_name, row.order_no, toSearchChunks(row.parsed, rules));
      }
      return rows;
    });
    if (batch.length === 0) return files;
    files += batch.length;
    after = batch[batch.length - 1].file_name;
  }
}

// --- the queue ---

interface QueuedDocument {
  file_name: string;
  order_no: number | null;
  blob_reference: string;
  size_bytes: number | null;
  sha256: string | null;
}

interface RetryNote {
  attempts: number;
  retryAt: number;
  error: string;
}

function asRetryNotes(value: unknown): Record<string, RetryNote> {
  const out: Record<string, RetryNote> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, note] of Object.entries(value as Record<string, Partial<RetryNote>>)) {
      if (note && typeof note.retryAt === "number") {
        out[name] = { attempts: Number(note.attempts) || 1, retryAt: note.retryAt, error: String(note.error ?? "") };
      }
    }
  }
  return out;
}

const QUEUE_WHERE = `blob_reference is not null
  and (parsed_at is null or parser_version is distinct from $1)`;

async function storeParsed(
  db: Db,
  doc: QueuedDocument,
  parsed: OrderDocument | null,
  problems: string[],
  parserVersion: string,
  now: number
): Promise<void> {
  const orderNo = doc.order_no ?? parsed?.header.orderNumber ?? null;
  await db.query(
    `update raw.order_documents
        set parsed = $2::jsonb, parsed_at = $3::timestamptz, parser_version = $4,
            parse_problems = $5::jsonb, order_no = $6::integer
      where file_name = $1`,
    [
      doc.file_name,
      parsed === null ? null : JSON.stringify(parsed),
      new Date(now).toISOString(),
      parserVersion,
      JSON.stringify(problems),
      orderNo,
    ]
  );
  const rules = await loadElementTypeRules(db);
  await writeChunks(db, doc.file_name, orderNo, parsed === null ? [] : toSearchChunks(parsed, rules));
  if (orderNo != null) await appendPending(db, PRIVATE.pendingOrders, [orderNo]);
}

/**
 * Hands the queued order numbers to applyDocumentChanges and takes them off
 * the queue once the writer has returned. An order the writer keeps failing
 * on is set aside (handover.ts) and the rest goes on; the queue is only kept
 * when the writer fails as a whole. Null when nothing was queued.
 */
export async function flushDocumentChanges(now: number): Promise<ApplyResult | null> {
  const pending = await withService((db) => readPending<number>(db, PRIVATE.pendingOrders));
  if (pending.length === 0) return null;
  const orders = [...new Set(pending)].sort((a, b) => a - b);
  const result = await handOver({
    source: "documents",
    items: orders,
    orderOf: (orderNo) => orderNo,
    apply: (items) => applyDocumentChanges(items, now),
    now,
  });
  await withService((db) => dropPending(db, PRIVATE.pendingOrders, pending.length));
  return result;
}

// --- the run ---

export interface DocumentSyncOptions {
  now: number;
  access?: ServiceAccess;
  /** Read the list even when the last read is recent. */
  forceList?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  /** Date.now() after which no further file is started. */
  deadline?: number;
  /** For tests: stands in for PARSER_VERSION and parseOrderDocument. */
  parserVersion?: string;
  parse?: (bytes: Uint8Array, fileName: string) => Promise<OrderDocument>;
}

export interface DocumentSyncResult {
  status: JobStatus;
  /** The list was read in this run. */
  listRead: boolean;
  listed: number;
  inserted: number;
  changed: number;
  removed: number;
  parsed: number;
  /** Parsed files that left something in parse_problems. */
  withProblems: number;
  /** Files that could not be fetched this time. */
  failed: number;
  bytes: number;
  /** Files still waiting to be parsed after this run. */
  queued: number;
  durationMs: number;
  error?: string;
}

/** One document sync run. Never throws: how it went is in the result and in app.sync_state ("documents"). */
export async function runDocumentSync(options: DocumentSyncOptions): Promise<DocumentSyncResult> {
  const { now } = options;
  const started = Date.now();
  const parserVersion = options.parserVersion ?? PARSER_VERSION;
  const parse = options.parse ?? parseOrderDocument;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const result: DocumentSyncResult = {
    status: "ok",
    listRead: false,
    listed: 0,
    inserted: 0,
    changed: 0,
    removed: 0,
    parsed: 0,
    withProblems: 0,
    failed: 0,
    bytes: 0,
    queued: 0,
    durationMs: 0,
  };
  const done = () => ({ ...result, durationMs: Date.now() - started });

  const access = options.access ?? (await getOptiCloud(now));
  if (access.status !== "ok") {
    await recordNoAccess(JOBS.documents, access, now);
    result.status = access.status;
    return done();
  }
  const source = access.source;

  const before = await withService((db) => readState(db, JOBS.documents));
  const retry = asRetryNotes(before?.detail.retry);
  let listReadAt: string | undefined;
  let removalRefused: boolean | undefined;
  let noTable = false;
  let failure: unknown = null;

  try {
    // 1. The list.
    const lastList = Date.parse(String(before?.detail.listReadAt ?? ""));
    if (options.forceList || Number.isNaN(lastList) || now - lastList >= DOCUMENT_LIST_INTERVAL_MS) {
      const tableId = await source.findTableId(DOCUMENT_TABLE_NAME);
      if (!tableId) {
        noTable = true;
      } else {
        const list = await mirrorList(source, tableId, now, deadline);
        result.listRead = true;
        result.listed = list.listed;
        result.inserted = list.inserted;
        result.changed = list.changed;
        result.removed = list.removed;
        removalRefused = list.removalRefused;
        if (list.complete) listReadAt = new Date(now).toISOString();
      }
    }

    // 2. The queue.
    const maxFiles = options.maxFiles ?? DOCUMENT_MAX_FILES;
    const maxBytes = options.maxBytes ?? DOCUMENT_MAX_BYTES;
    const waiting = Object.keys(retry).filter((name) => retry[name].retryAt > now);
    const queue = await withService((db) =>
      db.query<QueuedDocument>(
        `select file_name, order_no, blob_reference, size_bytes, sha256
           from raw.order_documents
          where ${QUEUE_WHERE} and file_name <> all($2::text[])
          order by ${NEWEST_DOCUMENT_ORDER}
          limit $3`,
        [parserVersion, waiting, maxFiles]
      )
    );

    for (const doc of queue) {
      if (Date.now() >= deadline) break;
      // The first file of a run always goes, or one big file would block the queue for good.
      if (result.parsed + result.failed > 0 && result.bytes + (doc.size_bytes ?? 0) > maxBytes) break;

      if ((doc.size_bytes ?? 0) > DOCUMENT_MAX_PDF_BYTES) {
        await withService((db) =>
          storeParsed(db, doc, null, ["The file is over 50 MB and was not read."], parserVersion, now)
        );
        result.parsed++;
        result.withProblems++;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await source.getBlob(doc.blob_reference, DOCUMENT_MAX_PDF_BYTES);
      } catch (err) {
        if (err instanceof BlobTooLargeError) {
          await withService((db) =>
            storeParsed(db, doc, null, ["The file is over 50 MB and was not read."], parserVersion, now)
          );
          result.parsed++;
          result.withProblems++;
          continue;
        }
        // A rejected login or an unreachable OptiCloud ends the run: the next file would fail the same way.
        if (failureStatus(err) !== "error") throw err;
        const attempts = (retry[doc.file_name]?.attempts ?? 0) + 1;
        retry[doc.file_name] = {
          attempts,
          retryAt: now + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (attempts - 1)),
          error: errorText(err),
        };
        result.failed++;
        continue;
      }
      result.bytes += bytes.byteLength;

      const parsed = await parse(bytes, doc.file_name);
      const problems = [...parsed.problems];
      if (doc.sha256) {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== doc.sha256) problems.push("The file's SHA-256 is not the one in the list row.");
      }
      await withService((db) => storeParsed(db, doc, parsed, problems, parserVersion, now));
      delete retry[doc.file_name];
      result.parsed++;
      if (problems.length > 0) result.withProblems++;
    }
  } catch (err) {
    failure = err;
  }

  try {
    await flushDocumentChanges(now);
  } catch (err) {
    failure ??= err;
  }

  if (failure) {
    result.status = failureStatus(failure);
    result.error = errorText(failure);
    if (result.status === "error") console.error("Document sync failed:", result.error);
  } else if (noTable) {
    result.status = "no_table";
  }

  // Notes for files that are parsed or gone are dropped, and the list is kept short.
  const notes = Object.entries(retry)
    .sort((a, b) => b[1].retryAt - a[1].retryAt)
    .slice(0, MAX_RETRY_NOTES);

  await withService(async (db) => {
    const totals = await db.query<{ count: number; queued: number; newest: Date | null }>(
      `select count(*) as count,
              count(*) filter (where ${QUEUE_WHERE}) as queued,
              max(claimed_at) as newest
         from raw.order_documents`,
      [parserVersion]
    );
    result.queued = Number(totals[0]?.queued ?? 0);
    const finished = done();
    await writeState(db, JOBS.documents, {
      watermark: totals[0]?.newest ? new Date(totals[0].newest).toISOString() : undefined,
      lastRunAt: now,
      lastSuccessAt: failure ? undefined : now,
      lastError: failure
        ? finished.error!
        : removalRefused
          ? "Many stored documents are missing from the list. Nothing was removed."
          : null,
      rowsTotal: Number(totals[0]?.count ?? 0),
      detail: {
        status: finished.status,
        configured: true,
        listReadAt,
        listRead: finished.listRead,
        listed: finished.listRead ? finished.listed : undefined,
        inserted: finished.inserted,
        changed: finished.changed,
        removed: finished.removed,
        parsed: finished.parsed,
        withProblems: finished.withProblems,
        failed: finished.failed,
        bytes: finished.bytes,
        queued: finished.queued,
        parserVersion,
        durationMs: finished.durationMs,
        retry: Object.fromEntries(notes),
        retryAt: null,
        missingEnv: null,
      },
    });
  });
  return done();
}
