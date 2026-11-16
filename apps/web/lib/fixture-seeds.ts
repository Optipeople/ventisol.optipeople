// For their side effects: register the seeds that fill the in-process
// fixture database (VENTISOL_FIXTURES=1). Each seed only runs when that
// database is first opened, so importing this costs nothing in production.
//
// Imported by lib/auth.ts, which every page, route and server action passes
// through, so the fixture database is full whichever page is opened first.

import "@/lib/readmodel/fixture-seed";
import "@/lib/sync/fixture-seed";
