import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNextPath, siteUrl } from "@/lib/site";

const BASE = "https://ventisol.optipeople.dk/auth/refresh?next=x";

describe("safeNextPath", () => {
  it("keeps a path and query on this site", () => {
    expect(safeNextPath("/periode?fra=2026-10-01&til=2026-10-21", BASE)).toBe(
      "/periode?fra=2026-10-01&til=2026-10-21"
    );
    expect(safeNextPath("/ordre/58556", BASE)).toBe("/ordre/58556");
  });

  it("falls back to / for nothing", () => {
    expect(safeNextPath(null, BASE)).toBe("/");
    expect(safeNextPath("", BASE)).toBe("/");
  });

  it.each([
    "/\\evil.com",
    "\\\\evil.com",
    "//evil.com",
    "///evil.com",
    "https://evil.com/",
    "https:evil.com",
    "http://ventisol.optipeople.dk/",
    "javascript:alert(1)",
    "/\t/evil.com",
  ])("never leaves the site for %j", (next) => {
    const path = safeNextPath(next, BASE);
    expect(path.startsWith("/")).toBe(true);
    expect(path.startsWith("//")).toBe(false);
    expect(new URL(path, BASE).origin).toBe("https://ventisol.optipeople.dk");
  });

  it("sends the reported /\\evil.com to /", () => {
    // new URL resolves it to https://evil.com/.
    expect(safeNextPath("/\\evil.com", BASE)).toBe("/");
    expect(safeNextPath("//evil.com/x", BASE)).toBe("/");
  });

  it("never returns a protocol-relative path", () => {
    // "/.//evil.com" resolves to pathname "//evil.com" on this origin.
    const path = safeNextPath("/.//evil.com", BASE);
    expect(path.startsWith("//")).toBe(false);
    expect(new URL(path, BASE).origin).toBe("https://ventisol.optipeople.dk");
  });

  it("drops the fragment", () => {
    expect(safeNextPath("/?dato=2026-10-20#x", BASE)).toBe("/?dato=2026-10-20");
  });
});

describe("siteUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the production address", () => {
    vi.stubEnv("SITE_URL", "");
    expect(siteUrl()).toBe("https://ventisol.optipeople.dk");
  });

  it("uses SITE_URL without a trailing slash or path", () => {
    vi.stubEnv("SITE_URL", "http://localhost:3000/");
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});
