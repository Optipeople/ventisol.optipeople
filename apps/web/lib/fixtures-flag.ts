// Dev-only fixture mode: VENTISOL_FIXTURES=1 with `next dev` serves sample
// scans from fixtures/scans.json instead of OptiCloud, and skips the login on
// the report pages, so the pages can be looked at without credentials.
//
// It can never switch on in a production build: `next build`/`next start`
// run with NODE_ENV=production, and both conditions are checked on every call.
// Kept dependency-free so proxy.ts can import it.

export function fixturesEnabled(): boolean {
  return (
    process.env.VENTISOL_FIXTURES === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * The made-up OptiCloud account of fixture mode, as the account claim of the
 * fixture user. A real uuid shape, because the database compares the claim
 * with app.instance.account_id (uuid): the fixture database has to hold this
 * id there for row level security to let the fixture user in.
 */
export const FIXTURE_ACCOUNT_ID = "00000000-0000-4000-8000-00000000f1c5";

/** The fixture user's portal role: admin, so every page can be looked at. */
export const FIXTURE_ROLE = "admin" as const;

export const FIXTURE_USER = {
  id: "fixture-user",
  email: "demo@ventisol.dk",
  name: "Demo (fixtures)",
  roleName: "Fixture-tilstand",
  permissionName: null,
  accountId: null,
  accountName: "Ventisol (eksempeldata)",
};
