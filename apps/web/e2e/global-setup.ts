import type { FullConfig } from "@playwright/test";

// Warms the fixture server up before the first test:
// - /ordrer imports lib/opticloud, which registers the read model seed, so
//   pages that read only lib/reports (Overblik, Ledelse) are not empty;
// - /indstillinger/synkronisering imports lib/sync/status, whose seed ingests
//   the sample order PDFs (fixtures/orderdocs) the PDF viewer test opens;
// - each route compiles on its first request under `next dev`.
// The first request also seeds the fixture database, which takes a while.
const WARM_PATHS = [
  "/ordrer",
  "/indstillinger/synkronisering",
  "/",
  "/stationer",
  "/ledelse",
  "/indstillinger",
  "/chat",
];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("No baseURL in playwright.config.ts");
  for (const path of WARM_PATHS) {
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        const res = await fetch(new URL(path, baseURL), { signal: AbortSignal.timeout(150_000) });
        await res.text();
        if (res.ok) break;
        throw new Error(`${path} answered ${res.status}`);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
}
