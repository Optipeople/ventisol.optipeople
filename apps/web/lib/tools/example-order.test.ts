// The chat's first suggestion asks about a real order in progress.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, testClaims, type TestDb } from "@/lib/db/testing";
import { IN_PROGRESS_ORDERS, NOW, seedConfig, seedOctober } from "@/lib/reports/test-support";
import { suggestions } from "./suggestions";
import { exampleOrderNo } from "./example-order";

const viewer = testClaims("viewer");
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedConfig(db);
});
afterAll(async () => {
  await db.close();
});

describe("exampleOrderNo", () => {
  it("is an order in progress", async () => {
    await seedOctober(db, IN_PROGRESS_ORDERS);
    expect([50006, 50007, 50008]).toContain(await exampleOrderNo(viewer, NOW));
  });

  it("is null with no order in progress", async () => {
    expect(await exampleOrderNo(viewer, NOW)).toBeNull();
  });
});

describe("suggestions", () => {
  it("asks about the order, and leaves the question out without one", () => {
    expect(suggestions(50006)[0]).toBe("Hvor er ordrenummer 50006, og hvornår er den klar til afsendelse?");
    expect(suggestions(50006)).toHaveLength(6);
    expect(suggestions(null)).toHaveLength(5);
    expect(suggestions(null).join(" ")).not.toMatch(/ordrenummer/);
  });
});
