import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { bsListDate, kindOfPrefix, mergeBsPositions, pickOrderLists, type ListCandidate } from "./order-lists";

const file = (fileName: string, prefix: string | null, more: Partial<ListCandidate> = {}): ListCandidate => ({
  fileName,
  prefix,
  printDate: null,
  syncedAt: "2026-11-27T08:00:00Z",
  headerDate: null,
  parsed: true,
  ...more,
});

describe("kindOfPrefix", () => {
  it("reads the kind the sync stored", () => {
    expect(kindOfPrefix(null)).toBe("list");
    expect(kindOfPrefix("")).toBe("list");
    expect(kindOfPrefix("BE")).toBe("list");
    expect(kindOfPrefix("ABS")).toBe("list");
    expect(kindOfPrefix("BS")).toBe("bs");
    expect(kindOfPrefix("BE_BS")).toBe("bs");
    expect(kindOfPrefix("BS tegninger")).toBe("bs-drawings");
    expect(kindOfPrefix("BE_BS tegninger")).toBe("bs-drawings");
  });
});

describe("bsListDate", () => {
  it("takes the date in the name, else the header's", () => {
    expect(bsListDate("58931_20261127BS.pdf", "2026-11-01")).toBe("2026-11-27");
    expect(bsListDate("B S 58931_20261112.pdf", null)).toBe("2026-11-12");
    expect(bsListDate("58925_20261112_BS.pdf", null)).toBe("2026-11-12");
    expect(bsListDate("8931_20261127BS (1).pdf", null)).toBe("2026-11-27");
    // No date in the name, or none that is a date.
    expect(bsListDate("BS_58931_x.pdf", "2026-11-01")).toBe("2026-11-01");
    expect(bsListDate("58931_20261340BS.pdf", "2026-11-01")).toBe("2026-11-01");
    expect(bsListDate("58931_20261340BS.pdf", "2026-02-30")).toBeNull();
    expect(bsListDate("58931_202611270BS.pdf", 5)).toBeNull();
  });
});

describe("pickOrderLists", () => {
  it("the newest list by print date, the newest BS list by the date in its name", () => {
    const picked = pickOrderLists([
      file("58931_20261112.pdf", null, { printDate: "2026-11-12", syncedAt: "2026-11-27T12:00:00Z" }),
      file("58931_20261127.pdf", null, { printDate: "2026-11-27" }),
      file("58931_20261128.pdf", null, { printDate: "2026-11-28", parsed: false }),
      file("B S 58931_20261112.pdf", "BS", { syncedAt: "2026-11-27T12:00:00Z" }),
      file("58931_20261127BS.pdf", "BS"),
      file("58931_20261127BS tegninger.pdf", "BS tegninger", { syncedAt: "2026-11-27T13:00:00Z" }),
    ]);
    expect(picked.list?.fileName).toBe("58931_20261127.pdf");
    expect(picked.bs?.fileName).toBe("58931_20261127BS.pdf");
  });
  it("a BS list without a date comes last; the same date: the one synced last", () => {
    expect(
      pickOrderLists([file("58931_x_BS.pdf", "BS", { syncedAt: "2026-11-28T00:00:00Z" }), file("58931_20261101BS.pdf", "BS")]).bs
        ?.fileName
    ).toBe("58931_20261101BS.pdf");
    expect(
      pickOrderLists([
        file("58931_20261127BS.pdf", "BS"),
        file("58931_20261127BS (1).pdf", "BS", { syncedAt: "2026-11-27T09:00:00Z" }),
      ]).bs?.fileName
    ).toBe("58931_20261127BS (1).pdf");
    expect(pickOrderLists([file("58931_20261127BS tegninger.pdf", "BS tegninger")])).toEqual({ list: null, bs: null });
  });
});

describe("mergeBsPositions", () => {
  it("keeps the list's positions and adds the BS positions it does not have", () => {
    const list = [{ number: 1, subNumber: null, q: "list" }, { number: 3, subNumber: 1, q: "list" }];
    const bs = [
      { number: 2, subNumber: null, q: "bs" },
      { number: 1, subNumber: null, q: "bs" },
      { number: 3, subNumber: 1, q: "bs" },
      { number: 3, subNumber: 2, q: "bs" },
    ];
    expect(mergeBsPositions(list, bs).map((p) => `${p.number}.${p.subNumber ?? ""}${p.q}`)).toEqual([
      "1.list",
      "3.1list",
      "2.bs",
      "3.2bs",
    ]);
    expect(mergeBsPositions([], bs)).toHaveLength(4);
  });
});

// The same rules in SQL (migration 20261127100000_bs_positions.sql).
describe("the SQL helpers", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.close());
  const value = async <T>(sql: string, params: unknown[] = []) =>
    (await db.withService((tx) => tx.query<{ v: T }>(`select ${sql} as v`, params)))[0].v;

  it("agree with the TypeScript ones", async () => {
    for (const prefix of [null, "", "BE", "ABS", "BS", "BE_BS", "BS tegninger", "BE_BS tegninger"]) {
      const kind = await value<number>("rpt.document_kind($1::text)", [prefix]);
      expect(["list", "bs", "bs-drawings"][kind], String(prefix)).toBe(kindOfPrefix(prefix));
    }
    const dates: [string, string | null][] = [
      ["58931_20261127BS.pdf", "2026-11-01"],
      ["B S 58931_20261112.pdf", null],
      ["58925_20261112_BS.pdf", null],
      ["BS_58931_x.pdf", "2026-11-01"],
      ["58931_20261340BS.pdf", "2026-11-01"],
      ["58931_20261340BS.pdf", "2026-02-30"],
      ["58931_202611270BS.pdf", "x"],
    ];
    for (const [name, header] of dates) {
      const date = await value<string | null>("rpt.bs_list_date($1::text, $2::text)::text", [name, header]);
      expect(date, name).toBe(bsListDate(name, header));
    }
    const list = [{ number: 1, subNumber: null }, { number: 3, subNumber: 1 }, "odd"];
    const bs = [{ number: 2 }, { number: 1, subNumber: null }, { number: 3, subNumber: 1 }, { number: 3, subNumber: 2 }, 7];
    const merged = await value<unknown[]>("rpt.merged_positions($1::jsonb, $2::jsonb)", [
      JSON.stringify(list),
      JSON.stringify(bs),
    ]);
    expect(merged).toEqual([...list, { number: 2 }, { number: 3, subNumber: 2 }]);
    expect(await value<unknown[]>("rpt.merged_positions(null, '{}'::jsonb)")).toEqual([]);
  });
});
