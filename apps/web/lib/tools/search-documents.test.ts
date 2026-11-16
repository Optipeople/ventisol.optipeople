// search_documents on PGlite: full-text and trigram hits, the order filter,
// and that row level security keeps another account out.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { runChatTool, searchDocuments } from "./index";

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

  it("an empty query without an order finds nothing", async () => {
    expect(await searchDocuments({ claims: viewer, now: NOW }, {})).toEqual([]);
  });

  it("a user of another account reads nothing", async () => {
    const stranger = { ...viewer, accountId: "99999999-9999-4999-8999-999999999999" };
    expect(await searchDocuments({ claims: stranger, now: NOW }, { query: "terrassedør" })).toEqual([]);
  });

  it("as a tool: compact hits and a table view", async () => {
    const result = await runChatTool({ claims: viewer, now: NOW }, "search_documents", { query: "terrassedør" });
    expect(result.data).toMatchObject({ count: 1 });
    expect(result.views[0]).toMatchObject({ kind: "table" });
  });
});
