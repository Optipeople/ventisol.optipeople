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

export const FIXTURE_USER = {
  id: "fixture-user",
  email: "demo@ventisol.dk",
  name: "Demo (fixtures)",
  roleName: "Fixture-tilstand",
  permissionName: null,
  accountId: null,
  accountName: "Ventisol (eksempeldata)",
};
