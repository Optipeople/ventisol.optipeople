// What the rate limiter does without a database: it must never break login.
// The database module is mocked to fail or hang; the in-memory counters of
// the instance have to answer instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const withService = vi.fn<(fn: unknown) => Promise<unknown>>();

vi.mock("@/lib/db", () => ({
  withService: (fn: unknown) => withService(fn),
}));

const { allowAttempt, createAttemptLimits, DB_TIMEOUT_MS, forgetAccountAttempts } =
  await import("@/lib/rate-limit");

const MINUTE = 60_000;
const make = () =>
  createAttemptLimits({ name: "test", windowMs: MINUTE, ipLimit: 3, accountLimit: 2 });

describe("allowAttempt without a database", () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    withService.mockReset();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
  });

  it("counts in memory when the database is not configured or fails", async () => {
    withService.mockRejectedValue(new Error("DATABASE_URL is not set"));
    const limits = make();
    expect(await allowAttempt(limits, "1.1.1.1", "anna", 0)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "anna", 1)).toBe(true);
    expect(await allowAttempt(limits, "1.1.1.1", "anna", 2)).toBe(false);
    expect(limits.account.size()).toBe(1);
  });

  it("also when the failure is a synchronous throw", async () => {
    withService.mockImplementation(() => {
      throw new Error("no driver");
    });
    const limits = make();
    expect(await allowAttempt(limits, "1.1.1.1", "anna", 0)).toBe(true);
  });

  it("does not wait for a database that hangs", async () => {
    vi.useFakeTimers();
    withService.mockReturnValue(new Promise(() => {}));
    const limits = make();
    const answer = allowAttempt(limits, "1.1.1.1", "anna", 0);
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    expect(await answer).toBe(true);
    expect(limits.ip.size()).toBe(1);
  });

  it("logs the failure, but not once per try", async () => {
    vi.useFakeTimers();
    // Past the minute of silence an earlier test may have started.
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    withService.mockRejectedValue(new Error("down"));
    const limits = make();
    for (let i = 0; i < 5; i++) await allowAttempt(limits, `10.0.0.${i}`, "anna", i);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("forgetAccountAttempts never throws and still clears the memory counter", async () => {
    withService.mockRejectedValue(new Error("down"));
    const limits = make();
    await allowAttempt(limits, "1.1.1.1", "anna", 0);
    await allowAttempt(limits, "1.1.1.1", "anna", 1);
    await expect(forgetAccountAttempts(limits, "1.1.1.1", "anna")).resolves.toBeUndefined();
    expect(await allowAttempt(limits, "1.1.1.1", "anna", 2)).toBe(true);
  });
});
