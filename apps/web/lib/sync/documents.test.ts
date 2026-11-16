import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { DEFAULT_ELEMENT_TYPE_RULES, PARSER_VERSION } from "@/lib/orderdoc";

const applyDocumentChanges = vi.fn(async (orderNos: number[], now: number) => {
  void orderNos;
  void now;
  return { orders: 1, stationDays: 0 };
});
vi.mock("@/lib/readmodel", () => ({
  applyScanChanges: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
  applyDocumentChanges: (orderNos: number[], now: number) => applyDocumentChanges(orderNos, now),
  rebuildAll: vi.fn(async () => ({ orders: 0, stationDays: 0 })),
}));

import {
  loadElementTypeRules,
  NEWEST_DOCUMENT_ORDER,
  runDocumentSync,
  writeChunks,
  type DocumentSyncOptions,
} from "./documents";
import { resetServiceMemory } from "./opticloud-service";
import { JOBS, PRIVATE, readDeadLetters, readPending, readState } from "./state";
import { fakeParse, FakeOptiCloud, HOUR, NOW } from "./test-fakes";

let db: TestDb;
let cloud: FakeOptiCloud;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  resetServiceMemory();
  // Back to the default implementation as well: some tests make the writer fail.
  applyDocumentChanges.mockReset();
  cloud = new FakeOptiCloud();
});
afterAll(() => db.close());

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const run = (now: number, extra: Partial<DocumentSyncOptions> = {}) =>
  runDocumentSync({ now, access: cloud.access, forceList: true, parse: fakeParse, ...extra });
const docs = () => db.withService((q) => q.query("select * from raw.order_documents order by file_name"));
const chunks = (fileName: string) =>
  db.withService((q) =>
    q.query<{ chunk_index: number; content: string; order_no: number; has_embedding: boolean }>(
      `select chunk_index, content, order_no, embedding is not null as has_embedding
         from doc.document_chunks where file_name = $1 order by chunk_index`,
      [fileName]
    )
  );
const state = () => db.withService((q) => readState(q, JOBS.documents));

const FILE = "58556_20261110.pdf";

describe("runDocumentSync", () => {
  it("mirrors a new row, parses its file once and writes the chunks", async () => {
    cloud.addDocument(FILE, "Dreje-kip\nFast", { sha256: sha("Dreje-kip\nFast") });
    const result = await run(NOW);

    expect(result).toMatchObject({
      status: "ok",
      listRead: true,
      listed: 1,
      inserted: 1,
      parsed: 1,
      withProblems: 0,
      failed: 0,
      queued: 0,
    });
    const [row] = await docs();
    expect(row).toMatchObject({
      file_name: FILE,
      order_no: 58556,
      print_date: "2026-11-10",
      blob_reference: `masterdata/acc/tbl/${FILE}`,
      content_type: "application/pdf",
      parser_version: PARSER_VERSION,
      parse_problems: [],
    });
    expect((row.parsed as { positions: unknown[] }).positions).toHaveLength(2);
    expect((row.parsed_at as Date).getTime()).toBe(NOW);

    const stored = await chunks(FILE);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((c) => c.chunk_index)).toEqual(stored.map((_, i) => i));
    expect(stored.every((c) => c.order_no === 58556 && !c.has_embedding)).toBe(true);

    expect(applyDocumentChanges).toHaveBeenCalledTimes(1);
    expect(applyDocumentChanges).toHaveBeenCalledWith([58556], NOW);
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingOrders))).toEqual([]);

    const job = await state();
    expect(job?.rowsTotal).toBe(1);
    expect(job?.lastSuccessAt?.getTime()).toBe(NOW);
    expect(job?.detail).toMatchObject({ status: "ok", parsed: 1, queued: 0, parserVersion: PARSER_VERSION });
  });

  it("does nothing the second time: no fetch, no parse, no writer call", async () => {
    cloud.addDocument(FILE, "Fast");
    await run(NOW);
    cloud.blobCalls = [];
    applyDocumentChanges.mockClear();

    const again = await run(NOW + 60_000);
    expect(again).toMatchObject({ status: "ok", inserted: 0, changed: 0, parsed: 0 });
    expect(cloud.blobCalls).toEqual([]);
    expect(applyDocumentChanges).not.toHaveBeenCalled();
  });

  it("reads the list at most every five minutes unless told to", async () => {
    cloud.addDocument(FILE, "Fast");
    await runDocumentSync({ now: NOW, access: cloud.access, parse: fakeParse });
    cloud.pageCalls = [];
    const soon = await runDocumentSync({ now: NOW + 60_000, access: cloud.access, parse: fakeParse });
    expect(soon.listRead).toBe(false);
    expect(cloud.pageCalls).toEqual([]);
    const later = await runDocumentSync({ now: NOW + 5 * 60_000, access: cloud.access, parse: fakeParse });
    expect(later.listRead).toBe(true);
  });

  it("parses again when the Sha256 of the row changed, and replaces the chunks", async () => {
    cloud.addDocument(FILE, "Fast\nDreje-kip\nTophængt", { sha256: sha("Fast\nDreje-kip\nTophængt") });
    await run(NOW);
    const before = await chunks(FILE);
    applyDocumentChanges.mockClear();

    cloud.addDocument(FILE, "Fast", { sha256: sha("Fast") });
    const result = await run(NOW + HOUR);
    expect(result).toMatchObject({ inserted: 0, changed: 1, parsed: 1 });

    const [row] = await docs();
    expect((row.parsed as { positions: unknown[] }).positions).toHaveLength(1);
    expect((row.parsed_at as Date).getTime()).toBe(NOW + HOUR);
    const after = await chunks(FILE);
    expect(after.length).toBeLessThan(before.length);
    expect(after.map((c) => c.chunk_index)).toEqual(after.map((_, i) => i));
    expect(after.map((c) => c.content).join("\n")).not.toContain("Tophængt");
    expect(applyDocumentChanges).toHaveBeenCalledWith([58556], NOW + HOUR);
  });

  it("parses again when the parser version differs from the stored one", async () => {
    cloud.addDocument(FILE, "Fast");
    await run(NOW);
    applyDocumentChanges.mockClear();

    const same = await run(NOW + 60_000);
    expect(same.parsed).toBe(0);
    const bumped = await run(NOW + 120_000, { parserVersion: "9.9.9" });
    expect(bumped).toMatchObject({ changed: 0, parsed: 1 });
    expect((await docs())[0].parser_version).toBe("9.9.9");
    expect(applyDocumentChanges).toHaveBeenCalledTimes(1);
  });

  it("stores a row without a file and parses it once the file is there", async () => {
    cloud.addDocument(FILE, "", { reference: null });
    const first = await run(NOW);
    expect(first).toMatchObject({ status: "ok", inserted: 1, parsed: 0, failed: 0, queued: 0 });
    expect((await docs())[0]).toMatchObject({ file_name: FILE, blob_reference: null, parsed_at: null });
    expect(cloud.blobCalls).toEqual([]);
    expect(applyDocumentChanges).not.toHaveBeenCalled();

    // The station finished the upload.
    cloud.addDocument(FILE, "Fast");
    const second = await run(NOW + 60_000);
    expect(second).toMatchObject({ changed: 1, parsed: 1 });
    expect((await docs())[0].parsed_at).not.toBeNull();
  });

  it("stores what the parser could not read", async () => {
    cloud.addDocument(FILE, "Fast\n!Page 2: no position table found");
    const result = await run(NOW);
    expect(result).toMatchObject({ status: "ok", parsed: 1, withProblems: 1 });
    expect((await docs())[0].parse_problems).toEqual(["Page 2: no position table found"]);
    expect((await state())?.detail.withProblems).toBe(1);
  });

  it("notes a file whose bytes are not the ones the row promised", async () => {
    cloud.addDocument(FILE, "Fast", { sha256: sha("something else") });
    const result = await run(NOW);
    expect(result.withProblems).toBe(1);
    expect((await docs())[0].parse_problems).toEqual(["The file's SHA-256 is not the one in the list row."]);
  });

  it("takes at most the files of one run and leaves the rest queued, newest print date first", async () => {
    for (const day of ["01", "02", "03", "04", "05"]) cloud.addDocument(`5860${day[1]}_202611${day}.pdf`, "Fast");
    const first = await run(NOW, { maxFiles: 2 });
    expect(first).toMatchObject({ inserted: 5, parsed: 2, queued: 3 });
    expect(cloud.blobCalls).toEqual([
      "masterdata/acc/tbl/58605_20261105.pdf",
      "masterdata/acc/tbl/58604_20261104.pdf",
    ]);
    expect((await state())?.detail.queued).toBe(3);

    const second = await run(NOW + 60_000, { maxFiles: 2 });
    expect(second).toMatchObject({ parsed: 2, queued: 1 });
    const third = await run(NOW + 120_000, { maxFiles: 2 });
    expect(third).toMatchObject({ parsed: 1, queued: 0 });
    expect(cloud.blobCalls).toHaveLength(5);
  });

  it("stops at the byte limit, but always takes the first file", async () => {
    for (const day of ["01", "02", "03"]) {
      cloud.addDocument(`5860${day[1]}_202611${day}.pdf`, "Fast", { size: 1000 });
    }
    const result = await run(NOW, { maxBytes: 500 });
    expect(result).toMatchObject({ parsed: 1, queued: 2 });
  });

  it("starts no file after the deadline", async () => {
    cloud.addDocument(FILE, "Fast");
    await run(NOW, { maxFiles: 0 });
    const result = await run(NOW + 1000, { deadline: Date.now() - 1 });
    expect(result).toMatchObject({ parsed: 0, queued: 1 });
    expect(cloud.blobCalls).toEqual([]);
  });

  it("tries a file that cannot be fetched again later, without holding up the others", async () => {
    cloud.addDocument("58601_20261101.pdf", "Fast");
    cloud.addDocument("58602_20261102.pdf", "Fast");
    cloud.brokenBlobs.add("masterdata/acc/tbl/58602_20261102.pdf");

    const first = await run(NOW);
    expect(first).toMatchObject({ status: "ok", parsed: 1, failed: 1, queued: 1 });
    expect((await state())?.detail.retry).toMatchObject({
      "58602_20261102.pdf": { attempts: 1, retryAt: NOW + 5 * 60_000 },
    });

    // Not before its time.
    cloud.blobCalls = [];
    await run(NOW + 60_000);
    expect(cloud.blobCalls).toEqual([]);

    await run(NOW + 6 * 60_000);
    expect(cloud.blobCalls).toHaveLength(1);
    expect((await state())?.detail.retry).toMatchObject({ "58602_20261102.pdf": { attempts: 2 } });

    cloud.brokenBlobs.clear();
    const healed = await run(NOW + HOUR);
    expect(healed).toMatchObject({ parsed: 1, failed: 0, queued: 0 });
    expect((await state())?.detail.retry).toEqual({});
  });

  it("removes a stored row the list no longer holds, with its chunks", async () => {
    for (const day of ["01", "02", "03", "04", "05", "06"]) {
      cloud.addDocument(`5860${day[1]}_202611${day}.pdf`, "Fast");
    }
    await run(NOW);
    applyDocumentChanges.mockClear();
    cloud.documents = cloud.documents.filter((d) => d.id !== "row-58603_20261103.pdf");

    const result = await run(NOW + HOUR);
    expect(result.removed).toBe(1);
    expect(await docs()).toHaveLength(5);
    expect(await chunks("58603_20261103.pdf")).toEqual([]);
    expect(applyDocumentChanges).toHaveBeenCalledWith([58603], NOW + HOUR);
  });

  it("removes nothing when most of the list is suddenly gone", async () => {
    for (let i = 1; i <= 9; i++) cloud.addDocument(`5860${i}_2026110${i}.pdf`, "Fast");
    await run(NOW);
    cloud.documents = cloud.documents.slice(0, 2);
    const result = await run(NOW + HOUR);
    expect(result.removed).toBe(0);
    expect(await docs()).toHaveLength(9);
    expect((await state())?.lastError).toContain("Nothing was removed");
  });

  it("files a missing list without an error", async () => {
    cloud.hasDocumentTable = false;
    const result = await run(NOW);
    expect(result.status).toBe("no_table");
    expect((await state())?.lastError).toBeNull();
  });

  it("keeps the order queued when the writer fails, and hands it over next time", async () => {
    cloud.addDocument(FILE, "Fast");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The writer is down: the batch, the retry per order and the empty probe all fail.
    applyDocumentChanges.mockRejectedValue(new Error("writer down"));
    const first = await run(NOW);
    expect(first).toMatchObject({ status: "error", parsed: 1 });
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingOrders))).toEqual([58556]);
    expect(await db.withService((q) => readDeadLetters(q))).toEqual([]);

    applyDocumentChanges.mockReset();
    const second = await run(NOW + 60_000);
    expect(second).toMatchObject({ status: "ok", parsed: 0 });
    expect(applyDocumentChanges).toHaveBeenLastCalledWith([58556], NOW + 60_000);
    vi.restoreAllMocks();
  });

  it("retries per order once a batch fails, and sets aside an order that keeps failing", async () => {
    cloud.addDocument(FILE, "Fast");
    cloud.addDocument("58557_20261110.pdf", "Fast");
    applyDocumentChanges.mockImplementation(async (orderNos: number[]) => {
      if (orderNos.includes(58557)) throw new Error("order 58557 is broken");
      return { orders: orderNos.length, stationDays: 0 };
    });
    const result = await run(NOW);

    expect(result).toMatchObject({ status: "ok", parsed: 2 });
    expect(applyDocumentChanges.mock.calls.map((c) => c[0])).toEqual([[58556, 58557], [58556], [58557]]);
    expect(await db.withService((q) => readPending(q, PRIVATE.pendingOrders))).toEqual([]);
    expect(await db.withService((q) => readDeadLetters(q))).toEqual([
      expect.objectContaining({ orderNo: 58557, source: "documents", error: "order 58557 is broken", failures: 1 }),
    ]);
  });
});

describe("the newest document of an order", () => {
  it("is the one with the newest print date, then the newest row", async () => {
    cloud.addDocument("58556_20261101.pdf", "Fast");
    cloud.addDocument("58556_20261110.pdf", "Fast");
    cloud.addDocument("A58556_20261105.pdf", "Fast", { orderNo: 58556 });
    await run(NOW);
    const rows = await db.withService((q) =>
      q.query(`select file_name from raw.order_documents where order_no = 58556 order by ${NEWEST_DOCUMENT_ORDER}`)
    );
    expect(rows.map((r) => r.file_name)).toEqual([
      "58556_20261110.pdf",
      "A58556_20261105.pdf",
      "58556_20261101.pdf",
    ]);
  });
});

describe("writeChunks", () => {
  const embed = (fileName: string) =>
    db.withService((q) =>
      q.query(
        "update doc.document_chunks set embedding = array_fill(0.5::real, array[1536])::vector where file_name = $1",
        [fileName]
      )
    );

  beforeEach(async () => {
    cloud.addDocument(FILE, "Fast", { reference: null });
    await run(NOW);
  });

  it("keeps the embedding of an unchanged chunk, clears a changed one, and drops the surplus", async () => {
    const write = (texts: string[]) =>
      db.withService((q) =>
        writeChunks(
          q,
          FILE,
          58556,
          texts.map((content, i) => ({ position: i + 1, content }))
        )
      );
    await write(["one", "two", "three", "four"]);
    await embed(FILE);
    expect((await chunks(FILE)).every((c) => c.has_embedding)).toBe(true);

    await write(["one", "TWO"]);
    expect(await chunks(FILE)).toEqual([
      { chunk_index: 0, content: "one", order_no: 58556, has_embedding: true },
      { chunk_index: 1, content: "TWO", order_no: 58556, has_embedding: false },
    ]);

    await write([]);
    expect(await chunks(FILE)).toEqual([]);
  });
});

describe("loadElementTypeRules", () => {
  const setTypes = (rows: [string, unknown, number][]) =>
    db.withService(async (q) => {
      await q.query("delete from config.element_types");
      for (const [id, recognition, sort] of rows) {
        await q.query(
          "insert into config.element_types (id, name, recognition, sort_order) values ($1, $1, $2::jsonb, $3)",
          [id, JSON.stringify(recognition), sort]
        );
      }
    });

  it("uses the built-in rules when the table has none", async () => {
    await setTypes([]);
    expect(await db.withService(loadElementTypeRules)).toBe(DEFAULT_ELEMENT_TYPE_RULES);
    await setTypes([["door", null, 1]]);
    expect(await db.withService(loadElementTypeRules)).toBe(DEFAULT_ELEMENT_TYPE_RULES);
  });

  it("reads one rule object or a list per type, in sort order", async () => {
    await setTypes([
      ["window", [{ anyOpeningContains: ["dreje"] }, { type: "fixed", maxFields: 1 }], 2],
      ["door", { anyOpeningContains: ["dør"], minFields: 1 }, 1],
    ]);
    expect(await db.withService(loadElementTypeRules)).toEqual([
      { type: "door", anyOpeningContains: ["dør"], minFields: 1 },
      { type: "window", anyOpeningContains: ["dreje"] },
      { type: "fixed", maxFields: 1 },
    ]);
  });
});
