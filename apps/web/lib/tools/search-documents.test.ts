// search_documents on PGlite: full-text and trigram hits, the order filter,
// and that row level security keeps another account out.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { findDocuments, runChatTool, searchDocuments } from "./index";

const NOW = Date.parse("2026-11-16T12:00:00+01:00");
const viewer = testClaims("viewer");

let db: TestDb;

async function seedDocuments(): Promise<void> {
  await db.withService(async (tx) => {
    await tx.query(
      `insert into raw.order_documents (file_name, order_no) values ('1042.pdf', 1042), ('1043.pdf', 1043)`
    );
    await tx.query(
      `insert into doc.document_chunks (file_name, order_no, "position", chunk_index, content) values
         ('1042.pdf', 1042, 1, 0, 'Ordre 1042 Hansen Byg, Lev. uge 48
Pos. 1 Terrassedør 2 fløjet, hvid
Glas 4-16-4 energi'),
         ('1042.pdf', 1042, 2, 1, 'Ordre 1042 Hansen Byg, Lev. uge 48
Pos. 2 Vindue 1 fag, karm 68 mm'),
         ('1043.pdf', 1043, 1, 2, 'Ordre 1043 Jensen Tømrer, Lev. uge 49
Pos. 1 Vindue 2 fag med sprosser')`
    );
  });
}

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedDocuments();
});
afterAll(() => db.close());

describe("searchDocuments", () => {
  it("finds a word through Danish full-text search", async () => {
    const hits = await searchDocuments({ claims: viewer, now: NOW }, { query: "terrassedør" });
    expect(hits.map((h) => [h.orderNo, h.position])).toEqual([[1042, 1]]);
  });

  it("finds a name with a typo through trigram similarity", async () => {
    const hits = await searchDocuments({ claims: viewer, now: NOW }, { query: "Jensen Tømer" });
    expect(hits[0]).toMatchObject({ orderNo: 1043 });
  });

  it("filters on the order", async () => {
    const all = await searchDocuments({ claims: viewer, now: NOW }, { query: "vindue" });
    expect(new Set(all.map((h) => h.orderNo))).toEqual(new Set([1042, 1043]));
    const one = await searchDocuments({ claims: viewer, now: NOW }, { query: "vindue", orderNo: 1043 });
    expect(one.map((h) => h.orderNo)).toEqual([1043]);
  });

  it("lists an order's positions without a query", async () => {
    const hits = await searchDocuments({ claims: viewer, now: NOW }, { orderNo: 1042 });
    expect(hits.map((h) => h.position)).toEqual([1, 2]);
  });

  it("with every word in one chunk, only such chunks are hits", async () => {
    const found = await findDocuments({ claims: viewer, now: NOW }, { query: "vindue sprosser" });
    expect(found.hits.map((h) => [h.orderNo, h.position])).toEqual([[1043, 1]]);
    expect(found).toMatchObject({ total: 1, matched: "all" });
  });

  it("without such a chunk, those with some of the words, most words first", async () => {
    const found = await findDocuments({ claims: viewer, now: NOW }, { query: "vindue sprosser hvid" });
    expect(found.matched).toBe("some");
    expect(found.total).toBe(3);
    expect(found.hits[0]).toMatchObject({ orderNo: 1043, position: 1 });
  });

  it("tells the total and reads on from an offset", async () => {
    const ctx = { claims: viewer, now: NOW };
    const first = await findDocuments(ctx, { query: "vindue", limit: 1 });
    expect(first).toMatchObject({ total: 2, offset: 0 });
    expect(first.hits).toHaveLength(1);
    const second = await findDocuments(ctx, { query: "vindue", limit: 1, offset: 1 });
    expect(second.total).toBe(2);
    expect(second.hits[0].orderNo).not.toBe(first.hits[0].orderNo);

    const listed = await findDocuments(ctx, { orderNo: 1042, limit: 1 });
    expect(listed).toMatchObject({ total: 2, offset: 0 });
    expect(listed.hits.map((h) => h.position)).toEqual([1]);
  });

  it("keeps the total when the offset is past the last hit", async () => {
    const found = await findDocuments({ claims: viewer, now: NOW }, { query: "vindue", offset: 50 });
    expect(found).toMatchObject({ hits: [], total: 2, offset: 50 });
  });

  it("one misspelt word found by trigram alone is not called a partial match", async () => {
    const found = await findDocuments({ claims: viewer, now: NOW }, { query: "Jensn" });
    expect(found.hits[0]).toMatchObject({ orderNo: 1043 });
    expect(found.matched).toBe("all");
  });

  it("reads a minus as a plain word, not as 'without'", async () => {
    const found = await findDocuments({ claims: viewer, now: NOW }, { query: "vindue -sprosser" });
    expect(found.hits.map((h) => h.orderNo)).toEqual([1043]);
  });

  it("only stop words or punctuation find nothing and do not fail", async () => {
    for (const query of ["og i", "???"]) {
      expect(await findDocuments({ claims: viewer, now: NOW }, { query })).toMatchObject({ hits: [], total: 0 });
    }
  });

  it("an empty query without an order finds nothing", async () => {
    expect(await searchDocuments({ claims: viewer, now: NOW }, {})).toEqual([]);
  });

  it("a user of another account reads nothing", async () => {
    const stranger = { ...viewer, accountId: "99999999-9999-4999-8999-999999999999" };
    expect(await searchDocuments({ claims: stranger, now: NOW }, { query: "terrassedør" })).toEqual([]);
  });

  it("as a tool: compact hits and a table view", async () => {
    const result = await runChatTool({ claims: viewer, now: NOW }, "search_documents", { query: "terrassedør" });
    expect(result.data).toMatchObject({ count: 1, total: 1, offset: 0, more: false });

    const cut = await runChatTool({ claims: viewer, now: NOW }, "search_documents", { query: "vindue", limit: 1 });
    expect(cut.data).toMatchObject({ count: 1, total: 2, more: true });
    expect(cut.data).not.toHaveProperty("matched");

    const some = await runChatTool({ claims: viewer, now: NOW }, "search_documents", { query: "vindue sprosser hvid" });
    expect(some.data).toMatchObject({ matched: "some" });
    expect(result.views[0]).toMatchObject({ kind: "table" });
  });
});
