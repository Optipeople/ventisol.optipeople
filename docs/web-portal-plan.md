# Ventisol web portal: build plan

The customer portal at **ventisol.optipeople.dk**, branded "Opticloud MES" in the proposal. This plan covers everything the portal has to do, how it is built, and the order of work.

Drafted 2026-11-13. Scope source: `context/Ventisol MES.html`, the newest customer version with prices (Nov 13), which replaces `Ventisol_MES_kunde_med_priser.html` (Oct 23). Inspiration: `optipeople.vola` (reporting portal) and `optipeople.ai.chat` (Opti Assist).

## 1. What we promised

The proposal's base subscription (12,500 kr/md) includes, for the portal:

| Promise in the deck | What it means for the portal |
|---|---|
| **Nøglerapporter: Overblik, Stationer, Ordrer, Ledelse** (section 05, "Alle tal og al historik ét sted") | Four report tabs, specified in §4 |
| **AI Agenter og Chat** ("Spørg, og få svar med det samme", section 06) | A chat over Ventisol's own data, with the six demo questions working for real |
| Tid pr. ordre **og pr. batch** | The batch dimension, as soon as batch data exists (§9) |
| Monthly report to the board on the 1st (Ledelse tab) | A generated, sent report |
| Værdimøde (value meeting), weekly for 3 months | Not software, but the portal must give us the numbers for it |

Shown as "Inspiration / Senere" and **not sold**: the 12 agents, Webshop. Options: KMW, 3E and Schirmer connectors. Not promised anywhere: OEE, quality module, TV screens, roles. We build the sold scope fully and design so the agents and connectors plug in without rework (§6, §7).

The deck's AI demo is a contract in practice. These six questions must answer correctly against real data:

1. "Hvor er ordrenummer 1042, og hvornår er den klar til afsendelse?" (status + forecast)
2. "Hvor venter ordrerne mest i denne uge?" (bottleneck)
3. "Holder kalkulen pr. elementtype?" (calculated vs measured)
4. "Passer næste uges batches ind?" (capacity planning)
5. "Hvor mange skal stå ved montagen?" (staffing)
6. "Hvad skal ledelsen vide i dag?" (management summary)

## 2. Where we start from

- **`apps/web`** is a working reports site: Next.js 16.4, `@optipeople/ui` 0.2.2, OptiCloud login with refresh, Danish UI, 94 unit tests. Three views: Dagsoverblik, Ordre (timeline), Periode. Never deployed; only run against fixtures.
- It reads only `VentisolScans`, by paging `MasterData/GetRowsPaged` newest-first in memory (no date filter in the API, up to 600 pages). The cache and the rate limiter live in process memory, which doesn't hold on Vercel.
- The station app writes scans (`VentisolScans`), each element as a machine order (`PartOrderNumber` + custom fields), and every 3E PDF (`VentisolOrderDocuments`). Nothing reads the PDFs yet.
- No Supabase, no Vercel project, no web CI. The `Optipeople` Vercel team (`mortens-projects-37a479c6`) holds `optipeople.dk`, `optipeople-vola` and `optipeople-ai-chat`.

## 3. Architecture

### 3.1 The one big decision: a read model in Supabase

`development-plan.md` says "we build no backend or database of our own". The portal has to break that rule, and should. OptiCloud stays the **system of record** for every scan and order; the station app keeps writing there and nothing changes on the floor. The portal gets its own Supabase Postgres, which holds three things:

1. **A read model.** A mirror of OptiCloud scans and order documents, plus derived facts: paired station intervals, order timelines, lead and waiting times. Every report, the chat and every agent query this, not OptiCloud directly.
2. **Data only the portal owns.** Users and roles, master data the deck needs that OptiCloud doesn't have (normal times, calculated times per element type, shift calendar, closed days, delivery dates), report snapshots, chat history, automations, audit log.
3. **Search.** pgvector over the 3E production lists, so the chat can answer from them.

Why: paging 600 pages per report is too slow and can't serve live screens, monthly trends, a forecast or an AI that runs ad-hoc questions. A Postgres read model makes every report a cheap SQL query, makes history permanent, and gives the AI one well-typed place to look. Ventisol's volume is small (a few thousand scans a day), so Supabase's smallest paid tier is enough.

Rule that keeps us honest: **the read model can always be rebuilt from OptiCloud.** Derived tables are recomputed, never hand-edited. A `rebuild` job replays everything.

### 3.2 Platform

| Concern | Choice | Notes |
|---|---|---|
| App | Keep `apps/web`, Next.js 16 App Router, `@optipeople/ui` | Shared UI goes to `optipeople.ui` per `apps/web/AGENTS.md` |
| Hosting | New Vercel project `ventisol-optipeople` in the Optipeople team, root `apps/web`, domain `ventisol.optipeople.dk` | Fluid compute, preview per PR |
| Database | New Supabase project, EU region (Frankfurt), installed through the Vercel Marketplace integration so env vars sync | Postgres, pgvector, Realtime, Storage, pg_cron |
| Migrations | `supabase/` folder in repo root, Supabase CLI, applied by CI | Branching per PR if the plan allows |
| AI | Vercel AI SDK (`ai`, `@ai-sdk/react`) through **Vercel AI Gateway**, Claude models | Gateway gives one bill, fallbacks and usage per key inside Vercel |
| Durable jobs | **Vercel Workflow** (WDK) for agents and multi-step automations; **Vercel Cron** for triggers | Retries, sleeps and human-approval steps |
| Cache | Vercel Runtime Cache for OptiCloud lookups (machines, users) | Replaces the in-process cache |
| Rate limiting | Vercel Firewall rules on auth routes + a Postgres-backed limiter | Replaces in-memory `lib/rate-limit.ts` |
| Email | Resend (Vercel Marketplace), EU region | Monthly report, alerts |
| Files | Supabase Storage for generated reports; OptiCloud Blob stays the home of 3E PDFs | |
| Observability | Vercel Observability + log drain, Sentry for errors, `usage_events` for AI cost | |

### 3.3 Auth and roles

- **Identity stays OptiCloud.** Same login as today (`lib/auth.ts`): password grant, refresh, `GetCurrentUser`. Users already exist there and the station app's service account lives there.
- **Authorisation moves to the portal.** A `portal_users` table maps OptiCloud user id → portal role. First login of an unknown Ventisol user creates a row with role `viewer`; an admin promotes.
- Roles:

| Role | Who (from the deck) | Can |
|---|---|---|
| `admin` | OptiPeople staff, Ventisol IT | Everything, incl. users, master data, automations |
| `ledelse` (management) | Kim, the board | All tabs incl. Ledelse, monthly reports, cost figures |
| `planner` | Bente | Overblik, Stationer, Ordrer, master data for times and calendar, chat |
| `viewer` | Supervisors, office | Overblik, Stationer, Ordrer, chat without cost figures |
| `screen` | A TV or tablet | Only its assigned live screen; login by device token, no person |

- **Supabase access is server-only.** The browser never holds a Supabase key. Server code uses a client that carries a short-lived JWT minted per request with `account_id`, `opti_user_id` and `role` claims, and **RLS policies enforce role and account on every table**. The service role is used only by sync jobs and migrations. This fixes the weakness in ai.chat, where RLS is on but has no policies and one missed check leaks data.
- Every write and every admin action goes to `audit_log`.

### 3.4 Data flow

```
Station app ──► OptiCloud (VentisolScans, PartOrderNumber, VentisolOrderDocuments)
                    │
                    │  sync (Vercel Cron, every minute; watermark on ScanId / FileName)
                    ▼
      Supabase: raw.scans, raw.order_documents
                    │
                    │  derive (same pairing rules as the station, shared test vectors)
                    ▼
      core.elements, core.station_intervals, core.orders, core.order_steps,
      core.order_facts, core.station_day_facts, core.batches (later)
                    │
        ┌───────────┼───────────────┬─────────────────┐
        ▼           ▼               ▼                 ▼
   Report pages   AI chat tools   Agents/workflows   Live screens (Realtime)
```

- **Sync.** Read `GetRowsPaged` newest-first until we hit the last stored `ScanId`; insert idempotently. Same for the order-document list. A nightly full reconcile catches edits and late offline uploads (the station's outbox sends old scans late, with their own time, so derived facts for past days must be recomputed when a late scan lands).
- **Derive.** Port the pairing rules from `apps/web/lib/report.ts` into a `lib/derive/` module that writes `core.*`, and keep running `docs/scan-rules-vectors.json` against it. The station screen, the old reports and the read model must count the same way.
- **3E documents.** For each new PDF: fetch through `MasterDataBlob/Get`, parse into the `OrderDocument` shape described in `docs/order-documents.md` (customer, delivery address, **Lev. uge**, positions, element system, opening type, dimensions, glass), store the JSON, derive **element type** per position (Vindue 1 fag / 2 fag / Dør / Terrassedør), chunk and embed for search. The station already has a .NET parser; we port it to TypeScript and test both against the same `context/orderfiles` fixtures. Fallback when a PDF won't parse: Claude structured extraction, flagged for review.
- **Freshness.** Cron every minute. Live pages also call a throttled "sync now" when opened, so a scan shows within seconds when someone is looking. If that's not enough later, the station app can ping a portal webhook after each upload (a one-line change there; not needed now).

### 3.5 Data model (first cut)

| Schema.table | Holds |
|---|---|
| `raw.scans` | 1:1 mirror of `VentisolScans` rows |
| `raw.order_documents` | Mirror of `VentisolOrderDocuments` + blob reference |
| `core.orders` | Order no., customer, case name, delivery week, address, first seen, packed at, status |
| `core.elements` | Barcode, order, position, sub-position, piece, element type, dimensions, system |
| `core.station_intervals` | One paired in/out per element per station, with rework flag and visit number |
| `core.order_steps` | Per order per step (Schirmer, wait, KMW, buffer, assembly, wait, packing): start, end, work, wait |
| `core.order_facts` | Lead time, work time, waiting time, on-time flag, rework count, element count |
| `core.station_day_facts` | Per station per day: count, time per piece, normal, deviation, standstill |
| `core.batches`, `core.batch_elements` | When batch data exists (§9) |
| `core.machine_events` | Schirmer / KMW events when connectors deliver; empty until then |
| `doc.document_chunks` | Text chunks + embeddings of 3E production lists |
| `config.stations` | Station no., name, kind, OptiCloud machine id, sort order, active |
| `config.element_types` | Type, how to recognise it in the PDF, **calculated time** per station |
| `config.normal_times` | Normal time per station per element type (manual, or learned from the baseline) |
| `config.calendar` | Shifts per weekday, closed days, holidays |
| `config.settings` | Schirmer assumed time per batch, buffer capacity (40), thresholds |
| `app.portal_users`, `app.screens`, `app.audit_log` | Auth, kiosk devices, audit |
| `ai.conversations`, `ai.messages`, `ai.tool_calls`, `ai.usage_events`, `ai.feedback` | Chat persistence, every tool call stored, cost |
| `auto.automations`, `auto.runs`, `auto.notifications` | Automation definitions, run log, what was sent to whom |
| `rpt.snapshots` | Frozen monthly reports (PDF in Storage + JSON numbers) |

Reports read through SQL views and `security invoker` functions (`rpt.overview(period)`, `rpt.stations(day)`, `rpt.orders(filter)`, `rpt.order_route(order_no)`, `rpt.management(month)`). The chat tools call the same functions, so a number in the chat always equals the number on the page.

## 4. The portal, page by page

Navigation follows the deck: **Overblik · Stationer · Ordrer · Ledelse**, plus **Chat**, and **Indstillinger** (settings) for admins. Every filter lives in the URL (vola pattern), every table exports to Excel and every page to PDF (port vola's `report-pdf.ts` / `report-xlsx.ts`).

### 4.1 Overblik (overview)
- Four KPI cards with change vs previous period: **Gennemløbstid pr. ordre**, **Ventetid pr. ordre**, **Leveret til tiden**, **Ordrer pakket**. Period picker (week, month, custom).
- "Gennemløbstid pr. ordre, uge for uge": stacked work/waiting per week.
- "Flaskehalsen: hvor går tiden pr. ordre": time split by step for the last 30 days, with the generated sentence ("Bufferen er flaskehalsen. Her venter en ordre i snit 2 t 10 min.").
- Today strip: orders in progress, elements through today, stations running (replaces today's Dagsoverblik).

### 4.2 Stationer (stations)
- Table per station and machine for a chosen day: Gennem i dag, Tid pr. stk., Normalt, Mod normalt %, Stod stille, Status (Normal / Lang liggetid / Langsommere / Stod stille), plus the headline "N steder at kigge på".
- Drill-down per station: day timeline of elements, distribution of times per element type, trend vs normal over weeks.
- Rows for Schirmer, KMW welding, KMW corner cleaning and Buffer appear with data once connectors deliver; until then they show "Ingen data endnu" (no data yet), never zero.

### 4.3 Ordrer (orders)
- Toggle **Afsluttede / I gang nu**, search on order number, customer and case name.
- Finished: Ordre, Kunde, Elementer, Start, Pakket, Gennemløbstid, Heraf ventetid, Status (Til tiden / Forsinket).
- In progress: Ordre, Elementer, Start, **Er nu ved**, Tid indtil nu, **Forventet klar**, Status (Til tiden / Risiko for forsinkelse).
- Order page: route Gantt per step (Arbejde / Ventetid / Afvigelse, "Nu" marker), elements list with each element's path and reworks, generated deviation notes ("Her gik det galt" / "Hold øje med" / "Ingen afvigelser"), and the **3E production list** (PDF viewer through `MasterDataBlob/GetTempUrl`, plus the parsed positions as a table).
- Absorbs today's `/ordre/[orderNo]` and `/periode`.

### 4.4 Ledelse (management). Roles `ledelse` and `admin`
- Three KPIs vs last month, month-by-month lead-time chart.
- **Kalkule mod målt**: calculated vs measured time per element type, flagged when off by more than a set threshold.
- "Det vigtigste" (most important): 3–5 bullets drafted by the AI from the month's numbers, editable by a person before sending.
- "Til beslutning" (for decision): free-text items the person adds.
- **Monthly report**: on the 1st, a workflow freezes the numbers, drafts the bullets, renders a PDF and sends it to a recipient list after one approval click (or automatically, a setting). Archive of past reports.

### 4.5 Chat
See §5. Full page plus a side panel available on every page ("Spørg om denne ordre").

### 4.6 Live screens (kiosk). Not in the deck; recommended
A read-only full-screen view for a TV in assembly or the office: orders in progress with "Er nu ved", stations with status colour, today's count. Uses Supabase Realtime on `core.*`, logs in by `screen` device token, survives network drops. Small to build once the read model exists, and visible value on the floor. Build in the last phase; skip if you say so.

### 4.7 Indstillinger (settings). Role `admin` (some parts `planner`)
- Users and roles (OptiCloud users in the Ventisol account, with portal role).
- Stations (name, kind, machine link, order) — read from what the station app set up, extra fields here.
- Element types and how they're recognised in the 3E PDF; calculated time per type.
- Normal times per station and type, with a button "foreslå fra baseline" (suggest from baseline: median of the last N weeks).
- Calendar: shifts, closed days; toggle "træk tid uden for skift fra" (deduct time outside shifts) for the lead-time calculation.
- Thresholds: what counts as late, slow, long dwell, standstill.
- Automations and recipients (§6). Screens (kiosk tokens). Audit log. Sync status (last sync, lag, errors, "rebuild").

## 5. AI chat

### 5.1 Design
- **AI SDK + AI Gateway**, `streamText` with tools on the server and `useChat` on the client. Persisted on the server (`ai.messages`), history loaded server-side (not resent by the client, unlike ai.chat). Resumable streams so a dropped connection doesn't lose the answer.
- Model: Claude Sonnet for the chat, Haiku for titles and small jobs, through the Gateway with fallback. Prompt caching on the system prompt and tool definitions.
- **Tools on the read model**, typed with zod, all read-only, all role-checked, each returning both data and a suggested chart:

| Tool | Answers |
|---|---|
| `find_order(query)` | order by number, customer or case name |
| `order_status(order_no)` | where it is now, what's done, forecast ready time |
| `order_route(order_no)` | steps, waits, deviations |
| `bottleneck(period)` | where time goes, by step and station |
| `station_performance(station, period)` | count, time per piece, vs normal, standstill |
| `calc_vs_measured(period, element_type?)` | kalkule mod målt |
| `capacity_plan(week)` | planned load vs capacity per day (needs planned orders; §9) |
| `staffing_analysis(station, period)` | output vs number of people (needs staffing data; §9) |
| `kpi_summary(period)` | the management numbers |
| `search_documents(query, order_no?)` | hybrid search over 3E production lists |
| `run_report_query(name, params)` | a whitelisted set of parameterised SQL functions for questions the tools above don't cover |

  No free-form SQL from the model. If questions keep falling outside the tools, we add a function.
- **Charts in the answer**: tool results render as generative UI parts (bar, stacked bar, Gantt, KPI tiles) with the same chart components as the report pages. Every answer that quotes a number links to the page that shows it.
- **OptiPeople MCP** (`mcp.optipeople.dk`) added as a second tool source for machine and OptiCloud data the read model doesn't mirror. Per-account OAuth as in ai.chat's `mcpOauth.ts`, secrets in Supabase Vault (not plaintext).
- Danish by default, answers in the user's language. System prompt holds Ventisol's vocabulary (stations, element types, Lev. uge, karm/ramme).
- Guardrails: role-aware tools (a `viewer` never gets cost numbers), refusal to guess when data is missing ("Vi har ikke batchdata endnu"), per-user daily token budget, usage per message in `ai.usage_events` (port ai.chat's `usage.ts` / `pricing.ts`).
- Feedback thumbs on every answer; bad answers go into the eval set.

### 5.2 Evals
An eval suite from day one (pattern from ai.chat's `scripts/eval.ts`): the six deck questions plus ~30 real questions from Kim and Bente, run against a frozen fixture database, asserting tool choice and the numbers. Runs in CI on changes to prompts or tools.

## 6. Automations and agents

### 6.1 Engine
- `auto.automations` rows: trigger (schedule, or an event such as "order at risk", "station stood still > N min", "order packed", "missing scan"), conditions, action (email, in-app notification, report, AI agent run), recipients, enabled.
- **Vercel Cron** fires a dispatcher every minute that checks schedules and event conditions against the read model; each match starts a **Vercel Workflow** run. Runs, steps and results go to `auto.runs`; sends go to `auto.notifications` (dedupe so the same alert isn't sent twice).
- In-app notification bell + email (Resend). SMS/Teams later if asked.
- An admin page to create and edit automations from templates, see the run log, and "kør nu" (run now).

### 6.2 What ships with base scope
| Automation | Trigger | Action |
|---|---|---|
| Månedsrapport til bestyrelsen | 1st of month, 07:00 | Freeze numbers, AI-drafted "Det vigtigste", PDF, approval step, send |
| Mandagsmail ("Tre tal i én mail") | Monday 07:00 | Lead time, on-time, waiting vs last week |
| Ordre i risiko | Forecast passes delivery week | Notify planner |
| Manglende scanning | Element scanned in, not out after N hours / order packed with an element missing | Notify planner; list on Overblik |
| Station stod stille | No scans at an active station for N min within a shift | Notify (off by default) |
| Sync health | Sync lag > 10 min or errors | Notify OptiPeople admin |

### 6.3 Agents (Inspiration in the deck; built on the same engine, switched on one at a time)
Each agent is a Workflow that uses the chat tools, writes a finding, and either notifies or waits for a human. Order by what the data supports:

1. **Rapportagent** (reports) and **Statusagent** (where is my order): data is there from day one.
2. **Flaskehalsagent** (bottleneck) and **Kostprisagent** (cost price, calc vs measured): need normal and calculated times entered.
3. **Forecast-agent**: ready-time prediction from history per element type and station queue; the same model feeds "Forventet klar" on the Ordrer tab, so build it in base scope.
4. **Kundeagent** (automatic message to the customer when the order is done): needs customer contact data from 3E and Ventisol's consent; draft-and-approve first.
5. **Tilbudsagent** (quote time from similar orders), **Planlægningsagent**, **Bemandingsagent**, **Bufferagent**, **Vedligeholdsagent**, **Kompetenceagent**: need data we don't have yet (planned orders, staffing, KMW, operating hours, skills). Listed so the schema leaves room; not built until the data exists.

## 7. Connectors and missing data

The portal must work without them and light up when they arrive:

| Data | Source | Until then |
|---|---|---|
| Schirmer start/stop | OptiPeople dashboards / machine data | Assumed time per batch from settings (deck: 60 min), shown as "antaget" (assumed) |
| KMW welding, corner cleaning, buffer, fill level | KMW connector (blocked on KMW) | Schirmer→first scan shown as one span "Før montage" (before assembly) |
| Batch number | Not in the barcode | Order-level only; batch views hidden |
| Delivery date (for "Leveret til tiden") | **Lev. uge** in the 3E PDF | Parsed from PDF; nothing to wait for |
| Planned orders (capacity) | 3E | Capacity agent off |

`core.machine_events` and `core.batches` exist from the start, so connector work only fills tables.

## 8. Engineering standards ("no corners cut")
- **CI for `apps/web`** (GitHub Actions): typecheck, lint, Vitest, Playwright e2e against a seeded Supabase branch, migration check, eval suite on AI changes. Required on PRs.
- **Tests**: keep the 94 unit tests and scan-rule vectors; add derive tests on real anonymised scan days; parser tests on all 26 `context/orderfiles`; RLS tests per role (a `viewer` cannot read cost tables, an unknown account reads nothing); e2e for every tab.
- **Security**: RLS with policies on every table, server-only Supabase, secrets in Vault/Vercel env, strict CSP (move from report-only to enforced), CSRF on server actions (Next default), Firewall rate limits, audit log, dependency review. Security review before go-live.
- **Performance**: every page under 1 s server time on a month of data; report functions indexed and checked with `EXPLAIN`.
- **Accessibility and language**: Danish UI; numbers and dates `da-DK`; charts have table equivalents (vola pattern).
- **Docs**: README per area, `docs/opticloud-scans.md` kept true, lore notes for each module.

## 9. Open questions

For **Ventisol** (Kim, Bente):
1. **Batch**: where does order → batch come from (3E, Schirmer files, Seriennr. on the pallet label)? The deck promises time per batch.
2. **"Leveret til tiden"**: is the target **Lev. uge** or **Afsendelse** week? Delivered = last packing scan?
3. **Normal and calculated times** per element type: do they have them (3E costing), or do we learn them from the first weeks?
4. **Board report**: recipients, PDF or mail body, who approves before it goes?
5. **Shift calendar**: confirm shifts (sim shows 06:00–14:00) and whether lead time excludes nights and weekends by default.
6. **Who gets which role**, and should a `viewer` see cost/kalkule numbers?
7. Do they want a TV screen on the floor?

For **OptiPeople** (backend owner):
8. A date filter or a "changed since" cursor on `GetRowsPaged`, or a webhook on new rows. Not required (we sync by watermark) but cheaper.
9. A non-expiring service credential for the sync job (today `ventisolserviceaccount@optipeople.dk` with password + refresh).
10. MCP OAuth client for the Ventisol account.

## 10. Order of work

Each phase ends deployed on ventisol.optipeople.dk. Work inside a phase runs in parallel workstreams that own separate folders.

**Phase 0: Foundation** (one session, sequential)
- Vercel project, domain, env; Supabase project via Marketplace; `supabase/` migrations; CI workflow.
- Auth on top of current `lib/auth.ts`: `portal_users`, roles, minted JWT, RLS helpers, role-aware nav with the new tab structure.
- Deploy the current three reports as-is behind the new auth so Ventisol can log in from day one.

**Phase 1: Read model** (parallel)
- A. Sync jobs (scans, order documents), watermark, reconcile, rebuild, sync-status page.
- B. Derive module (`core.*`) on the shared rules, with vectors and real-day tests.
- C. 3E PDF parser in TypeScript + element-type mapping + document chunks/embeddings.
- D. `config.*` tables and the Indstillinger pages for stations, element types, times, calendar, users.

**Phase 2: The four tabs** (parallel, one per tab, on `rpt.*` functions)
- Overblik, Stationer, Ordrer (incl. order page, PDF viewer, forecast v1), Ledelse (without sending). Excel/PDF export shared module first. Old routes retired.

**Phase 3: AI chat** (parallel with late Phase 2)
- Chat tools on `rpt.*`, persistence, generative charts, document search, usage/cost, evals with the six deck questions, side panel. MCP second.

**Phase 4: Automations**
- Engine (dispatcher, Workflow, run log, notifications, Resend), monthly board report with approval, Monday mail, risk/missing-scan/sync alerts, admin page.

**Phase 5: Agents and live screens**
- Rapport, Status, Flaskehals, Kostpris, Forecast agents; kiosk screens with Realtime. The rest as data arrives.

**Phase 6: Hardening and go-live**
- Security review, load test on a year of synthetic data, e2e green, docs, handover to the value meetings.

`development-plan.md` row 5 (Reports site) and row 9 (Chat interface: decided, in the portal) should point here.
