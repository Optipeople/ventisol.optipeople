# Ventisol Reports

Reports site for our customer **Ventisol**, at `ventisol.optipeople.dk`. It
shows the time spent per order, per element and per station, worked out from
the scan-in / scan-out rows the station app (`apps/station`) writes to
OptiCloud. Built like `optipeople.vola`: same stack, auth flow and look.

Three views (Danish UI):

- **Dagsoverblik** (`/`, `?dato=yyyy-MM-dd`): one day, today by default. KPIs
  (elements, orders packed, average time per element per station, total
  worked time), the day's orders and the stations (done, average, utilisation).
- **Ordre** (`/ordre/{orderNo}`): one order across the last 30 days. Total
  time, every element (barcode, position, piece) and a **timeline**: a block
  per day worked, a lane per station, a bar from In to Out.
- **Periode** (`/periode?fra=&til=&sort=&retning=`): time per order across a
  date range (this week by default, at most 62 days), sortable by every column.

## Stack

- Next.js 16.3 (App Router, server components, `proxy.ts`) + React 19.2 +
  TypeScript + Tailwind CSS 4, as in vola. No i18n library: Danish only.
- Vitest for the unit tests of the computation.
- No database. OptiCloud is the single source of truth; everything is read
  server-side, so the user's token never reaches the browser.

## Run locally

```
cp .env.example .env.local     # then fill in VENTISOL_ACCOUNT_ID
npm install
npm run dev                    # http://localhost:3000
npm test                       # unit tests
npm run build                  # production build
```

### Without credentials: fixture mode

```
VENTISOL_FIXTURES=1 npm run dev
```

Serves the sample rows in `fixtures/scans.json` (same shape as
`GetRowsPaged`, run through the same paging and parsing code) and skips the
login on the report pages. The rows are moved in time so their reference day
is today, and rows later than now are left out, so the last elements of the
day show as in progress. The header says "Eksempeldata". It only works under
`next dev`: with `NODE_ENV=production` (`next build`, `next start`, Vercel)
the flag is ignored. Regenerate the file with `node scripts/make-fixtures.mjs`.

## Environment variables

| Name | Required | What |
|---|---|---|
| `OPTIPEOPLE_API_URL` | no | Optipeople API base, default `https://api.optipeople.dk`. Login and data. |
| `VENTISOL_ACCOUNT_ID` | yes | Ventisol's OptiCloud account id. Gates access and is the account read. |
| `VENTISOL_FIXTURES` | no | `1` turns on fixture mode in `next dev` only. |

There is no cookie secret: as in vola, the cookies hold the Optipeople tokens
themselves (httpOnly, `secure` in production), and the API validates them.

## How it works

### Auth (`lib/auth.ts`, `app/login`, `app/auth/refresh`, `proxy.ts`)

Copied from vola:

1. `POST /api/Authentication/login` (`grant_type=password`) from a server
   action. The response is not wrapped in `{data, errors, meta}`.
2. `GET /api/User/GetCurrentUser` with the new token. Only users whose
   `accountId` is `VENTISOL_ACCOUNT_ID`, or super admins
   (`permissionName === "SuperAdministrator"`), get a session.
3. Tokens and the login email go into httpOnly cookies (`ventisol_*`); "Husk
   mig" makes them last 30 days.
4. `proxy.ts` sends anyone without a token cookie to `/login` (a quick
   pre-filter). Every page calls `requireUser()`, which validates the token
   against `GetCurrentUser`.
5. A rejected token with a refresh token present goes to `/auth/refresh`,
   which uses `grant_type=refresh_token` (with the username) and sends the
   user back. A 401 on a data read takes the same route.

Forgot / reset password use the same endpoints as vola.

### Reading the scans (`lib/opticloud.ts`, `lib/paging.ts`)

Unlike vola (External API with an access key), the scans are read with the
**signed-in user's bearer token**, following `docs/opticloud-scans.md`:

1. `GET /api/MasterData/GetTables/{accountId}` and find the table named
   `VentisolScans` (case-insensitive). A super admin from another account
   reads `VENTISOL_ACCOUNT_ID`.
2. `GET /api/MasterData/GetRowsPaged/{tableId}?page=N&pageSize=500&Orderby=ScanTime&IsAscending=false`.
   There is no date filter, so pages are read newest first until a row is
   older than the period. If a page comes back out of order, every page is
   read and the period is filtered in memory (and the page says so).
3. `errors[]` is checked on every response, since errors can come with HTTP 200.
4. Row values are matched to column names case-insensitively; order and
   position fall back to the barcode (`0 58556 05 01 03`) when empty.

Reads are cached in process memory (`lib/api-cache.ts`, from vola): 30 s when
the period includes today, 300 s for past days, 300 s for the table list.

### The computation (`lib/report.ts`, unit tested)

- In and Out are paired per station and barcode. A rework re-scan is another
  pair, so it adds time; it is marked as pass 2, 3 ... at that station.
- An Out without an In (the In fell before the period read) gets its start
  back from `DurationSec`. A second In without an Out drops the first.
- An element in progress counts up to now; an In left open more than 12 hours
  is treated as a missed scan and does not count.
- An order is **packed** when its last scan is an Out at a Packing station
  and nothing on it is in progress; **I gang** when something is in progress;
  otherwise **Afventer**.
- A pass belongs to the (Copenhagen) day it started.
- Station utilisation: time worked / time from the day's first scan to now
  (today) or to the last scan (past days). Same rules as `DayReport` in the
  station app.

## Files

```
app/
  login/, forgot-password/, reset-password/, auth/refresh/   auth (from vola)
  (app)/page.tsx               Dagsoverblik
  (app)/ordre/[orderNo]/       order detail + timeline
  (app)/periode/               period view
components/                    header, tabs, tables, timeline, date pickers; ui/ from vola
lib/
  auth.ts, auth-cookies.ts     session and access
  opticloud.ts                 API client (bearer token, envelope, 401)
  paging.ts                    newest-first paging with the stop rules
  scans.ts                     row -> Scan, barcode, position label
  report.ts                    pairing, orders, stations, KPIs, timeline
  views.ts                     what each page loads
  time.ts                      Copenhagen days, Danish formats
  fixtures.ts, fixtures-flag.ts  dev-only fixture mode
fixtures/scans.json            sample rows (generated by scripts/make-fixtures.mjs)
```

## Deploy (Vercel)

A Vercel project with **Root Directory `apps/web`** (framework Next.js,
default build command), the GitHub integration for a preview per pull request,
the env vars above set for Production and Preview, and the domain
`ventisol.optipeople.dk`. Do not set `VENTISOL_FIXTURES` there (it is ignored
in production builds anyway).
