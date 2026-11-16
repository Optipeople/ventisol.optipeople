// Fixture mode (VENTISOL_FIXTURES=1 under `next dev`): fills the in-process
// database through the real pipeline, so a developer sees data that went the
// same way as production data: fixture rows -> scan sync -> raw.scans -> read
// model writer.
//
// The seed runs once per process, before the first query from anywhere else
// is answered (onFixtureDbReady in lib/db). It only registers when this file
// is imported: lib/sync/status.ts and lib/sync/run.ts import it, so any page
// that shows the sync status or asks for a sync, and both cron routes, bring
// it in. Registering does nothing outside fixture mode.

import { onFixtureDbReady } from "@/lib/db";

/** Rounds of document parsing after the seed. 15 files a round covers the sample folder with room to spare. */
const DOCUMENT_ROUNDS = 8;

onFixtureDbReady("sync", async () => {
  const { runSync } = await import("./run");
  // The scans first, and only them: this is what the first page waits for.
  await runSync({ now: Date.now(), budgetMs: 60_000, skipDocuments: true });

  // The sample PDFs (when the untracked folder orderdocs/ exists) are parsed
  // behind the first page, a few at a time. Started here so that it runs as
  // part of the seed and is let through to the database; not awaited.
  void (async () => {
    for (let round = 0; round < DOCUMENT_ROUNDS; round++) {
      const result = await runSync({ now: Date.now(), budgetMs: 60_000 });
      if (result.status !== "done" || result.documents.queued === 0) return;
    }
  })();
});
