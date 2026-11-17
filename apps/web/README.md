# Ventisol portal

Production portal for our customer **Ventisol**, at `ventisol.optipeople.dk`.
It shows how orders move through the factory, how the stations perform and
what management needs each month, worked out from the scan-in / scan-out rows
the station app (`apps/station`) writes to OptiCloud and from the 3E
production lists (PDF) attached to each order. Built like `optipeople.vola`:
same login, same look (`@optipeople/ui`).

How it is put together, and the rules every part follows:
`docs/portal-architecture.md` (the build contract) and `docs/web-portal-plan.md`
(what is built and why). Report definitions: `docs/reports.md`.

## The tabs (Danish UI)

Every filter lives in the URL, every table has an Excel export and every
report page a PDF export.

- **Overblik** (`/`): KPIs, lead time trend, the bottleneck and today's strip.
- **Stationer** (`/stationer`): every station for a day or a period;
  `/stationer/{stationNo}` is one station's day, its 12 week trend and its
  times per element type.
- **Ordrer** (`/ordrer`): orders in progress and finished orders;
  `/ordre/{orderNo}` is one order with its route through the seven steps,
  forecast, deviation notes, passes, elements and the 3E list. Old
  `/periode` links redirect here.
- **Ledelse** (`/ledelse`): the month report with notes; a month can be frozen
  into a snapshot.
- **Chat** (`/chat`): an AI assistant that answers from the report functions
  and the order documents, with stored conversations.
- **Indstillinger** (`/indstillinger`): users and roles, stations, element
  types, normal times, calendar, thresholds, sync status and the audit log.

Which tabs a user sees depends on the portal role (`admin`, `ledelse`,
`planner`, `viewer`, `lib/portal/roles.ts`); every page checks it itself.

## Stack

- Next.js 16 (App Router, server components, `proxy.ts`), React 19,
  TypeScript, Tailwind CSS 4. Danish only, no i18n library.
- Supabase Postgres (project `ventisol-portal`), reached with plain `pg` over
  the transaction pooler. Every user query runs as `authenticated` with the
  user's claims, so row level security applies (`lib/db`).
- Sync jobs (Vercel Cron, `vercel.json`) read OptiCloud with a service account
  into `raw.*`, derive `core.*` and `doc.*`, and the pages read `rpt.*` SQL
  functions through `lib/reports`.
- AI SDK with the Anthropic API (`@ai-sdk/anthropic`) for the chat and the Ledelse draft.
- Vitest for unit and database tests (PGlite, Postgres in WASM, in process:
  no Docker, no network).

## Run locally

```
cp .env.example .env.local     # then fill it in, see below
npm install                    # needs the GitHub Packages token, see .npmrc
npm run dev                    # http://localhost:3000
```

### Without credentials: fixture mode

```
VENTISOL_FIXTURES=1 npm run dev
```

No login, no database and no OptiCloud: the server signs you in as a fixture
admin and opens an in-process PGlite with every migration applied, filled
from `fixtures/` through the real sync and derive code. That is about 13
weeks of made-up scans and 3E lists ending today (`fixtures/history.json`,
written by `node scripts/make-fixtures.mjs`, as is `fixtures/scans.json`,
five sample days that only the tests read).
Order PDFs come from the untracked `orderdocs/` folder at the repo root when
it is there. The header says "Eksempeldata". It only works under `next dev`:
with `NODE_ENV=production` (`next build`, `next start`, Vercel) the flag is
ignored.

### A second dev server

Next allows one `next dev` per build folder. To run another server beside the
one on port 3000 (fixture mode, a test run, another agent), give it its own
folder named `.next-<name>`:

```
VENTISOL_FIXTURES=1 VENTISOL_DIST_DIR=.next-fixtures npx next dev -p 3107
```

`next.config.ts` then points that server at its own `tsconfig.next-<name>.json`
(written on first start, extends `tsconfig.json`, ignored by git), so
`tsconfig.json` is never changed by it. Stop the server when done; on
Windows, `npx` can leave a node process holding the port, so kill the process
on that port too. The end to end tests (`npm run test:e2e`) start their own
server this way, on port 3210 with `.next-e2e`.

## Tests and checks

```
npm test               # unit and database tests (vitest)
npm run typecheck      # tsc
npm run lint           # eslint
npm run build          # production build
npm run test:e2e       # Playwright against a fixture server
```

CI (`.github/workflows/web-ci.yml`) runs `next typegen`, typecheck, lint,
tests and build. After moving a page, a stale `.next/types` can make `tsc`
fail until `next typegen`, a dev server or a build regenerates it. The model
evals in `lib/tools/evals` skip unless `ANTHROPIC_API_KEY` is exported in the
shell (vitest does not read `.env.local`). `VENTISOL_TEST_DB_CACHE=0` turns
off the cached migrated PGlite the database tests start from.

## Environment variables

| Name | Required | What |
|---|---|---|
| `VENTISOL_ACCOUNT_ID` | yes | Ventisol's OptiCloud account id. Users in this account get in; super administrators from any account do too. Also written to `app.instance`. |
| `DATABASE_URL` | yes, or `POSTGRES_URL` | Pooled Postgres connection string of `ventisol-portal` (transaction pooler, port 6543). Server only. |
| `POSTGRES_URL` | no | Read when `DATABASE_URL` is empty; the Vercel Supabase integration sets it. |
| `OPTICLOUD_SERVICE_USER`, `OPTICLOUD_SERVICE_PASSWORD` | yes, for the sync | The OptiCloud service account the sync jobs (`lib/sync`) read scans and order documents with. |
| `CRON_SECRET` | yes, for the sync | Vercel Cron sends `Authorization: Bearer <value>` to `app/api/cron/*`. Without it every cron call is refused. Vercel sets it in production; locally any long random string. |
| `ANTHROPIC_API_KEY` | for the chat | Anthropic API key, locally and on Vercel. Without it the chat says "AI er ikke konfigureret". |
| `CHAT_MODEL` | no | Anthropic model id for the chat and the Ledelse draft, default `claude-sonnet-5-5`. |
| `CHAT_DAILY_TOKEN_BUDGET` | no | Tokens one user may spend per Copenhagen day, default 2000000. |
| `OPTIPEOPLE_API_URL` | no | Optipeople API base, default `https://api.optipeople.dk`. Login and the service account. |
| `SITE_URL` | no | Public address, default `https://ventisol.optipeople.dk`. The password-reset email links here; `http://localhost:3000` in dev. Never taken from the Host header. |
| `VENTISOL_FIXTURES` | no | `1` turns on fixture mode, in `next dev` only. |
| `VENTISOL_DIST_DIR` | no | Build folder `.next-<name>` of a second dev server (see above). Unset everywhere else. |

There is no cookie secret: as in vola, the cookies hold the Optipeople tokens
themselves (httpOnly, `secure` in production), and the API validates them.

## How it works

### Login (`lib/auth.ts`, `app/login`, `app/auth/refresh`, `proxy.ts`)

1. `POST /api/Authentication/login` (`grant_type=password`) from a server
   action, then `GET /api/User/GetCurrentUser` with the new token. Only
   users whose `accountId` is `VENTISOL_ACCOUNT_ID`, or super administrators,
   get a session.
2. Tokens and the login email go into httpOnly cookies (`ventisol_*`); "Husk
   mig" makes them last 30 days.
3. `proxy.ts` sends anyone without a token cookie to `/login` (a quick
   pre-filter; the cron routes check `CRON_SECRET` themselves). Every page
   calls `requireUser`, `requireRole` or `requireCapability`, which validate
   the token and resolve the portal role (`lib/portal/users.ts`). An unknown
   user from the account gets a `viewer` row at first login. When the
   database is down, a valid login continues as viewer and role-gated pages
   say so.
4. A rejected token with a refresh token goes to `/auth/refresh`
   (`grant_type=refresh_token`) and back, once; a second refusal within a
   minute ends the session instead of looping. If OptiCloud cannot be
   reached the user lands on `/auth/unavailable`.
5. `next` is only followed when it resolves to this site's origin
   (`lib/site.ts`).

Login, forgot and reset are rate limited per IP and per IP plus account
(`lib/rate-limit.ts`). `next.config.ts` sets the security headers; the full
Content-Security-Policy is report-only until it has been checked in a browser.

### Data

```
OptiCloud ──lib/sync──▶ raw.* ──lib/derive, lib/orderdoc──▶ core.*, doc.* ──rpt.*──▶ lib/reports ──▶ pages, chat tools
```

- `lib/sync` pages `GetRowsPaged` with the service account (newest first,
  `lib/paging.ts`), every minute, and reconciles every night.
- `lib/derive` pairs In and Out scans over the full history with the rules
  in `docs/opticloud-scans.md` ("Rules"), the same as the station app.
  `docs/scan-rules-vectors.json` holds shared cases that this site and the
  station app both run.
- `lib/orderdoc` parses the 3E PDFs into positions and element types.
- `lib/reports` holds one typed wrapper per `rpt.*` function; pages and chat
  tools never write report SQL.

## Files

```
app/
  login/, forgot-password/, reset-password/, auth/   login (from vola)
  (app)/                       the tabs, under app/(app)/loading.tsx
  (detail)/                    /ordre/[orderNo], /stationer/[stationNo]: no
                               loading boundary above them, so notFound() is a 404
  api/chat, api/export, api/cron, api/ordre    route handlers
components/                    page parts by tab; shared UI is @optipeople/ui
lib/
  auth.ts, portal/             session, roles, users, audit, nav
  db/                          pg, withUser / withService, PGlite harness
  sync/, derive/, orderdoc/    OptiCloud mirror, pairing, 3E parser
  readmodel/, reports/         read model writer, rpt.* wrappers
  tools/                       chat tools
  export/                      Excel and PDF
  *-view/, overview/           URL parsing and view logic per tab
  scans.ts, report.ts, time.ts row parsing, the station app's pairing, Copenhagen days
fixtures/                      sample data (scripts/make-fixtures.mjs)
```

## Deploy (Vercel)

A Vercel project with **Root Directory `apps/web`** (framework Next.js,
default build command), the env vars above for Production and Preview, and
the domain `ventisol.optipeople.dk`. `NPM_RC` must hold
`//npm.pkg.github.com/:_authToken=<token>` or `npm install` cannot fetch
`@optipeople/ui`. Do not set `VENTISOL_FIXTURES` or `VENTISOL_DIST_DIR` there.
