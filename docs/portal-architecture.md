# Ventisol portal: build contract

How the portal in `apps/web` is put together. `docs/web-portal-plan.md` says what is built and why; this file says where each part lives and what the parts promise each other. Read both before you change portal code. When the code and this file disagree, fix one of them in the same change.

Decided 2026-11-16: **option C, the Supabase read model** (plan §3.1).

## 1. The shape

```
OptiCloud (system of record)
   │  lib/sync      service login, pages GetRowsPaged, writes raw.*
   ▼
raw.scans, raw.order_documents            mirror, never hand-edited
   │  lib/derive    pure pairing and facts (same rules as the station)
   │  lib/orderdoc  pure 3E PDF parser
   ▼
core.*  doc.*                             derived, can always be rebuilt from raw.*
   │  rpt.* SQL functions (security invoker)
   ▼
lib/reports  →  pages in app/(app), app/(detail)    lib/tools  →  chat
```

Portal-owned data (`config.*`, `app.*`, `ai.*`, `rpt.snapshots`) lives only in Supabase.

## 2. Database access

- **Plain Postgres, not supabase-js.** Server code talks to the database over a pooled Postgres connection with `pg`. The browser never talks to the database and never holds a key.
- Env: `DATABASE_URL`, falling back to `POSTGRES_URL` (the name the Vercel Supabase integration sets). Transaction pooler, so no session state and no named prepared statements.
- **Every user query runs inside a transaction that drops to the `authenticated` role with the user's claims**, the same thing PostgREST does:

  ```sql
  begin;
  select set_config('request.jwt.claims', '{"account_id":"…","opti_user_id":"…","role":"planner"}', true);
  set local role authenticated;
  -- queries
  commit;
  ```

- `lib/db` is the only module that opens connections. Its API:

  ```ts
  export interface Db {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  }
  export interface Claims { accountId: string; optiUserId: string; role: PortalRole; }
  export type PortalRole = "admin" | "ledelse" | "planner" | "viewer";

  /** One transaction as `authenticated` with these claims. RLS applies. */
  export function withUser<T>(claims: Claims, fn: (db: Db) => Promise<T>): Promise<T>;
  /** One transaction as the connection's own role. RLS does not apply. Sync jobs, first-login row, cron. */
  export function withService<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  ```

  Always pass values as parameters (`$1`), never build SQL from input.
- **Tests and fixture mode run the same SQL on PGlite** (`@electric-sql/pglite`, Postgres in WASM, in process). `lib/db/testing.ts` exports `createTestDb()`: a fresh PGlite with the Supabase roles created, every file in `supabase/migrations` applied in name order, and `withUser` / `withService` bound to it. No Docker and no network in tests. `VENTISOL_FIXTURES=1` under `next dev` uses the same PGlite, seeded from `fixtures/` through the real sync and derive code.
- So migrations use only what both Postgres 17 on Supabase and PGlite have: plain SQL, plpgsql, `vector`, `pg_trgm`. No `pg_cron`, no Vault, no `auth.*` or `storage.*` references.

## 3. Migrations

- Folder `supabase/migrations/` at the repo root, files `<yyyymmddhhmmss>_<name>.sql`, applied in name order. A file that has been applied to the hosted project is never edited: add a new one.
- Hosted project: **`ventisol-portal`**, ref `cjfomgjoyshusxwjxrzp`, Frankfurt, in the Optipeople Supabase organisation.
- Every table gets `enable row level security` and explicit policies in the migration that creates it. A table without policies is a bug. No grants to `anon` anywhere.
- Schemas: `raw`, `core`, `doc`, `config`, `app`, `ai`, `rpt`. Nothing of ours in `public`.

### Claim helpers (in `app`, made by the foundation migration)

| Function | Returns |
|---|---|
| `app.claims()` | `jsonb` from `request.jwt.claims`, `{}` when unset |
| `app.current_role()` | `text`, the portal role claim, or null |
| `app.current_user_id()` | `text`, the OptiCloud user id claim |
| `app.current_account_id()` | `uuid`, the account claim |
| `app.has_role(variadic text[])` | `boolean`: the role claim is one of these **and** the account claim equals `app.instance.account_id` |

`app.instance` is a one-row table holding this deployment's OptiCloud account id (written from `VENTISOL_ACCOUNT_ID` by service code at first use). The database is single-tenant: tables carry no account column, and the account check lives in `app.has_role`.

### Who reads and writes what

| Tables | Select | Insert, update, delete |
|---|---|---|
| `raw.*`, `app.sync_state` | `admin` (`app.sync_state` only) | service only |
| `core.*`, `doc.*` | all four roles | service only |
| `config.stations`, `config.element_types`, `config.calendar`, `config.settings` | all four roles | `admin`; `planner` too for `calendar` and `settings` |
| `config.normal_times` | all four roles | `admin`, `planner` |
| `config.calculated_times` | `admin`, `ledelse`, `planner` (never `viewer`: it is a cost figure) | `admin`, `planner` |
| `app.portal_users` | own row; every row for `admin` | `admin` (first-login row by service) |
| `app.audit_log` | `admin` | insert by any role for its own user id; never update or delete |
| `app.rate_limits` | none | service only |
| `ai.*` | own conversations (by `opti_user_id`); `admin` reads `ai.usage_events` | own conversations |
| `rpt.snapshots`, `rpt.management_notes` | `admin`, `ledelse` | notes by `admin`, `ledelse`; snapshots by service |

Report functions in `rpt` are `security invoker`, so these rules hold inside them too. Functions that return cost figures also check `app.has_role` themselves and raise when it fails.

## 4. Auth and roles

- Identity stays OptiCloud: `lib/auth.ts` as today. `requireUser()` keeps working; `AuthContext` gains `role: PortalRole` and `claims: Claims`.
- `app.portal_users (opti_user_id text primary key, email, name, role, created_at, last_seen_at, created_by)`. An unknown user from the Ventisol account gets a `viewer` row at first login. An OptiCloud super administrator is always `admin`, with or without a row.
- `lib/portal/roles.ts` holds the role list, labels and `can(role, capability)`. Pages call `requireRole(path, ...roles)`; nothing checks a role by string compare elsewhere.
- Every write and admin action calls `audit(db, action, subject, detail)` in `lib/portal/audit.ts`.

## 5. Code layout and ownership

Inside `apps/web`:

| Path | Holds | Rule |
|---|---|---|
| `lib/db/` | connection, `withUser`, `withService`, migration runner, PGlite harness | the only place that imports `pg` or PGlite |
| `lib/portal/` | roles, portal users, audit, rate limit | |
| `lib/derive/` | pairing, order steps, order and station facts | **pure**: data in, rows out, no I/O, no `Date.now()` (take `now`) |
| `lib/orderdoc/` | 3E PDF parser, element type rules | **pure** apart from reading bytes handed to it |
| `lib/sync/` | OptiCloud service client, scan and document sync, writers for `raw.*`, `core.*`, `doc.*` | runs as service |
| `lib/reports/` | typed TypeScript wrappers, one per `rpt.*` function | pages and tools import from here, never write report SQL inline |
| `lib/tools/` | chat tools: plain functions with a zod schema and a `Claims` context | no import from the chat route or from `ai` |
| `lib/export/` | Excel and PDF export | |
| `app/(app)/`, `app/(detail)/` | pages (`(detail)`: pages of one order or station, see below) | read through `lib/reports`, never `lib/sync` |
| `app/api/cron/` | Vercel Cron routes | check `Authorization: Bearer ${CRON_SECRET}` |

Outside it: `supabase/migrations/`, `.github/workflows/web-ci.yml`, `docs/`.

The scan rules live in `lib/derive` now: `lib/derive/pairing.ts` pairs the full scan history for the read model, and every page reads its result through `lib/reports`. It still takes its building blocks from two older modules: `lib/scans.ts` (row to `Scan`, barcode, station kind, position label) and `lib/report.ts` (`dedupeScans`, `stationKey`, and `pairScans`, the station app's windowed pairing with its order, station and KPI summaries). No page imports `lib/report.ts` any more; it stays as the reference that `lib/derive/fixture-day.test.ts` checks the read model against. `docs/scan-rules-vectors.json` runs against both `lib/derive/pairing.ts` (`pairing.test.ts`) and `lib/report.ts` (`lib/scan-rules-vectors.test.ts`) and must keep passing.

Pages that answer `notFound()` for an unknown id (`/ordre/[orderNo]`, `/stationer/[stationNo]`) live in the route group `app/(detail)/`, which has the same chrome (`components/portal-chrome.tsx`) but no `loading.tsx`. A loading boundary above a page sends its fallback with HTTP 200 before the page runs, so a `notFound()` under `app/(app)/loading.tsx` would only show the not-found UI with a 200. Such a page checks the id first and puts any `<Suspense>` after that check.

## 6. Conventions

- UI text is Danish, code and comments English. Numbers and dates `da-DK`. All day boundaries are Europe/Copenhagen (`lib/time.ts`).
- Timestamps are `timestamptz` in UTC. Durations are whole seconds in `integer` columns named `*_seconds`.
- A number that cannot be known yet is `null` and shows as "Ingen data endnu", never as 0.
- Shared UI comes from `@optipeople/ui` (`apps/web/AGENTS.md`). This is Next.js 16: read the guide in `node_modules/next/dist/docs/` before using an API from memory.
- No em dashes or en dashes in any text, comment or string.
- Customer PDFs in `orderdocs/` are never committed. Tests that need them skip when the folder is missing.
- Every filter lives in the URL. Every table has an Excel export and every report page a PDF export.

## 7. Environment

Every variable, with defaults and examples, is in `apps/web/README.md` and `apps/web/.env.example`.

| Name | Used by | What |
|---|---|---|
| `OPTIPEOPLE_API_URL`, `VENTISOL_ACCOUNT_ID`, `SITE_URL` | `lib/auth.ts` | login, the account that gets in, links in emails |
| `VENTISOL_FIXTURES` | `next dev` only | sample data in an in-process PGlite, no login |
| `VENTISOL_DIST_DIR` | `next.config.ts` | build folder `.next-<name>` of a second dev server |
| `DATABASE_URL` or `POSTGRES_URL` | `lib/db` | pooled Postgres connection string |
| `OPTICLOUD_SERVICE_USER`, `OPTICLOUD_SERVICE_PASSWORD` | `lib/sync` | the service account that reads scans and documents |
| `CRON_SECRET` | `app/api/cron/*` | Vercel sets and sends it; without it every cron call is refused |
| `AI_GATEWAY_API_KEY` | chat, Ledelse draft | not needed on Vercel, where OIDC is used |
| `CHAT_MODEL`, `CHAT_DAILY_TOKEN_BUDGET` | `app/api/chat/config.ts` | model id (default `anthropic/claude-sonnet-5.5`), tokens per user per day (default 2,000,000) |
