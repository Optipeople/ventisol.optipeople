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
| Monthly report to the board on the 1st (Ledelse tab) | A frozen monthly report with PDF download; how it gets sent is an open question (§9) |
| Værdimøde (value meeting), weekly for 3 months | Not software, but the portal must give us the numbers for it |

Shown as "Inspiration / Senere" and **not sold**: the 12 agents, Webshop. Options: KMW, 3E and Schirmer connectors. Not promised anywhere: OEE, quality module, TV screens, roles. **TV/kiosk screens: decided out of scope 2026-11-13.** We build the sold scope fully and design so the agents and connectors plug in without rework (§6, §7).

**Decided 2026-11-13:** automations and AI agents are **not built for Ventisol** until they're sold. When they are, they run in a **separate central OptiPeople project** that serves all customers, not in this portal and not in Opti Assist. §6 records that design so the groundwork and decisions are in place; this portal only keeps its tools in a shape that project can call later.

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

### 3.1 Where the report numbers come from. **DECIDED 2026-11-16: option C**

Supabase read model. How it is built is in `docs/portal-architecture.md`, which differs from §3.2 and §3.3 below in one way: server code reaches the database over a pooled Postgres connection and sets the role and claims per transaction, with no minted JWT and no supabase-js. The options are kept here for the record. Asking the backend owner for a "changed since" cursor (option B) is still worth doing, since it makes the sync cheaper.

**The facts that decide it**
- `MasterData/GetRowsPaged` has **no date filter and no server-side aggregation**. It can only page backwards from the newest row, 500 rows per page. `apps/web/lib/paging.ts` is sized for about 3,000 scans a day and capped at 600 pages.
  - One day ≈ 6 pages; a month ≈ 180 pages; a year ≈ 2,200 pages, past the cap.
- The deck needs history: Overblik's 12-week trend with change vs last month, Ledelse month by month, calculated vs measured over 30 days, and the AI chat asking about any period.
- No report number exists in OptiCloud as stored. Lead time, waiting time and time per station come from pairing each element's scan-in and scan-out and joining stations into a route. Direct reading redoes that per request.
- On Vercel the in-memory cache is per server instance and lost on every deploy.
- A chat question often makes 3–5 tool calls; each one would page OptiCloud.
- Customer, delivery week (Lev. uge) and element type only exist inside the 3E PDFs, which would otherwise be parsed per view.
- Some data has no home in OptiCloud: normal times, calculated times per element type, shift calendar, monthly snapshots, chat history. Most could live in OptiCloud master-data tables (the station app already creates tables there); chat history can't sensibly.

**The options**

| Option | What it is | For | Against |
|---|---|---|---|
| **A. Direct only** | As `apps/web` does today: page OptiCloud per request, compute in the request, cache in memory | One source of truth; no sync to keep correct; matches the original "no database of our own" rule | Daily views work; trends, Ledelse and chat get slow and hit the page cap as history grows; PDFs parsed per view |
| **B. Improve the OptiPeople API, then read directly** | Ask the backend owner for a date filter and a "changed since" cursor on `GetRowsPaged`, possibly aggregation endpoints | It's our own platform; every customer benefits; still one source | Depends on the backend owner's time; still recomputes everything per request; chat history and portal settings still need a home |
| **C. Supabase read model** | A sync job copies new scans and 3E documents from OptiCloud every minute (by watermark) and stores derived facts: paired intervals, order and station figures, parsed 3E data; plus portal-owned data | Every report is a cheap SQL query; history permanent; chat and pages share the same queries; PDFs parsed once | A sync job to keep correct (late offline scans, edits); a second database; reverses the original rule |

**Leaning** (not decided): C in a smaller form. Supabase stores derived facts, parsed 3E data and portal-owned data. OptiCloud stays the only home of raw scans and the system of record, and the derived tables can always be rebuilt from it and are never hand-edited. Ask for B in parallel, since a "changed since" cursor makes C's sync cheaper and surer.

**If the answer is A or B**, the honest version is:
- Stations and orders views read OptiCloud directly (with B's date filter if we get it).
- Ledelse, long trends and the chat still need some stored figures. The minimum is a cache of each finished day's numbers in a shared store (Vercel Runtime Cache or a small table). That is a small version of C.
- Supabase, or OptiCloud master-data tables, still hold portal-owned data: roles, normal and calculated times, calendar, snapshots, chat history.
- §3.5's `raw.*` and most of `core.*` drop out; `config.*`, `app.*`, `ai.*` and `rpt.snapshots` stay.

**To decide it we need:** an answer from the OptiPeople backend owner on whether a date filter and "changed since" cursor on `GetRowsPaged` can be added, and when (§9).

### 3.2 Platform

| Concern | Choice | Notes |
|---|---|---|
| App | Keep `apps/web`, Next.js 16 App Router, `@optipeople/ui` | Shared UI goes to `optipeople.ui` per `apps/web/AGENTS.md` |
| Hosting | New Vercel project `ventisol-optipeople` in the Optipeople team, root `apps/web`, domain `ventisol.optipeople.dk` | Fluid compute, preview per PR |
| Database | New Supabase project, EU region (Frankfurt), installed through the Vercel Marketplace integration so env vars sync | Postgres, pgvector, Storage |
| Migrations | `supabase/` folder in repo root, Supabase CLI, applied by CI | Branching per PR if the plan allows |
| AI | Vercel AI SDK (`ai`, `@ai-sdk/react`) through **Vercel AI Gateway**, Claude models | Gateway gives one bill, fallbacks and usage per key inside Vercel |
| Scheduled jobs | **Vercel Cron** for sync, reconcile and the monthly snapshot | Automations and agents live in the central project (§6) |
| Cache | Vercel Runtime Cache for OptiCloud lookups (machines, users) | Replaces the in-process cache |
| Rate limiting | Vercel Firewall rules on auth routes + a Postgres-backed limiter | Replaces in-memory `lib/rate-limit.ts` |
| Files | Supabase Storage for generated reports; OptiCloud Blob stays the home of 3E PDFs | |
| Observability | Vercel Observability + log drain, Sentry for errors, `usage_events` for AI cost | |

### 3.3 Auth and roles

- **Identity stays OptiCloud.** Same login as today (`lib/auth.ts`): password grant, refresh, `GetCurrentUser`. Users already exist there and the station app's service account lives there.
- **Authorisation moves to the portal.** A `portal_users` table maps OptiCloud user id → portal role. First login of an unknown Ventisol user creates a row with role `viewer`; an admin promotes.
- Roles:

| Role | Who (from the deck) | Can |
|---|---|---|
| `admin` | OptiPeople staff, Ventisol IT | Everything, incl. users and master data |
| `ledelse` (management) | Kim, the board | All tabs incl. Ledelse, monthly reports, cost figures |
| `planner` | Bente | Overblik, Stationer, Ordrer, master data for times and calendar, chat |
| `viewer` | Supervisors, office | Overblik, Stationer, Ordrer, chat without cost figures |

- **Supabase access is server-only.** The browser never holds a Supabase key. Server code uses a client that carries a short-lived JWT minted per request with `account_id`, `opti_user_id` and `role` claims, and **RLS policies enforce role and account on every table**. The service role is used only by sync jobs and migrations. This fixes the weakness in ai.chat, where RLS is on but has no policies and one missed check leaks data.
- Every write and every admin action goes to `audit_log`.

### 3.4 Data flow (assumes option C, §3.1)

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
   Report pages   AI chat tools   (later) MCP for agents
```

- **Sync.** Read `GetRowsPaged` newest-first until we hit the last stored `ScanId`; insert idempotently. Same for the order-document list. A nightly full reconcile catches edits and late offline uploads (the station's outbox sends old scans late, with their own time, so derived facts for past days must be recomputed when a late scan lands).
- **Derive.** Port the pairing rules from `apps/web/lib/report.ts` into a `lib/derive/` module that writes `core.*`, and keep running `docs/scan-rules-vectors.json` against it. The station screen, the old reports and the read model must count the same way.
- **3E documents.** For each new PDF: fetch through `MasterDataBlob/Get`, parse into the `OrderDocument` shape described in `docs/order-documents.md` (customer, delivery address, **Lev. uge**, positions, element system, opening type, dimensions, glass), store the JSON, derive **element type** per position (Vindue 1 fag / 2 fag / Dør / Terrassedør), chunk and embed for search. The station already has a .NET parser; we port it to TypeScript and test both against the same `context/orderfiles` fixtures. Fallback when a PDF won't parse: Claude structured extraction, flagged for review.
- **Freshness.** Cron every minute. Live pages also call a throttled "sync now" when opened, so a scan shows within seconds when someone is looking. If that's not enough later, the station app can ping a portal webhook after each upload (a one-line change there; not needed now).

### 3.5 Data model (first cut; assumes option C, §3.1)

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
| `app.portal_users`, `app.audit_log` | Auth, audit |
| `ai.conversations`, `ai.messages`, `ai.tool_calls`, `ai.usage_events`, `ai.feedback` | Chat persistence, every tool call stored, cost |
| `rpt.snapshots` | Frozen monthly reports (PDF in Storage + JSON numbers) |

No `auto.*` tables here: automation definitions, runs and notifications belong to the central project (§6).

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
- "Det vigtigste" (most important): 3–5 bullets. A person writes them; a "Lav udkast" (draft) button asks the chat model for a draft from the month's numbers. On demand, not scheduled.
- "Til beslutning" (for decision): free-text items the person adds.
- **Monthly report**: a Vercel Cron job on the 1st freezes the month's numbers into `rpt.snapshots`. The page shows the current and past months, and downloads as PDF for the board. Mailing it out automatically belongs to the central automation project (§6); until then someone downloads and sends it.

### 4.5 Chat
See §5. Full page plus a side panel available on every page ("Spørg om denne ordre").

### 4.6 Indstillinger (settings). Role `admin` (some parts `planner`)
- Users and roles (OptiCloud users in the Ventisol account, with portal role).
- Stations (name, kind, machine link, order) — read from what the station app set up, extra fields here.
- Element types and how they're recognised in the 3E PDF; calculated time per type.
- Normal times per station and type, with a button "foreslå fra baseline" (suggest from baseline: median of the last N weeks).
- Calendar: shifts, closed days; toggle "træk tid uden for skift fra" (deduct time outside shifts) for the lead-time calculation.
- Thresholds: what counts as late, slow, long dwell, standstill.
- Audit log. Sync status (last sync, lag, errors, "rebuild").
- Missing scans: a list on Overblik of elements scanned in but never out, and packed orders with an element missing. A list, not an alert.

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
- **Groundwork for the central project (§6):** tools live in one module (`lib/tools/`), each a plain function with a zod schema, an `account_id` + role context and no dependency on the chat route. The chat calls them directly today; an MCP endpoint can expose the same functions later without rewriting them. `capacity_plan` and `staffing_analysis` return "no data yet" until the data in §7 exists.
- **Charts in the answer**: tool results render as generative UI parts (bar, stacked bar, Gantt, KPI tiles) with the same chart components as the report pages. Every answer that quotes a number links to the page that shows it.
- **OptiPeople MCP** (`mcp.optipeople.dk`) added as a second tool source for machine and OptiCloud data the read model doesn't mirror. Per-account OAuth as in ai.chat's `mcpOauth.ts`, secrets in Supabase Vault (not plaintext).
- Danish by default, answers in the user's language. System prompt holds Ventisol's vocabulary (stations, element types, Lev. uge, karm/ramme).
- Guardrails: role-aware tools (a `viewer` never gets cost numbers), refusal to guess when data is missing ("Vi har ikke batchdata endnu"), per-user daily token budget, usage per message in `ai.usage_events` (port ai.chat's `usage.ts` / `pricing.ts`).
- Feedback thumbs on every answer; bad answers go into the eval set.

### 5.2 Evals
An eval suite from day one (pattern from ai.chat's `scripts/eval.ts`): the six deck questions plus ~30 real questions from Kim and Bente, run against a frozen fixture database, asserting tool choice and the numbers. Runs in CI on changes to prompts or tools.

## 6. Future: automations and agents (central project, not built now)

Not sold to Ventisol, so not built. This section records what was decided so the work can start without re-deciding when it is sold, for Ventisol or another customer.

### 6.1 Decisions
- **A separate central project**, working name `optipeople.agents`: its own repo, Vercel project and Supabase project in the Optipeople team. It runs automations and agents for **all customers**. Not inside Opti Assist (different audience, and its code has no RLS policies and a hand-built stream; the wrong base for every customer's automations). Not inside each customer portal (the engine would be built again per customer).
- **Identity:** OptiCloud login, as everywhere else. OptiCloud `accountId` is the tenant key on every row, with RLS policies tested in CI. A leak there exposes every customer, so isolation is the first test written.
- **Data access only through MCP.** The central project never copies a customer's data. It calls:
  - the customer portal's MCP endpoint (for Ventisol: the `lib/tools/` functions from §5, authenticated per account), and
  - OptiPeople's own `mcp.optipeople.dk` for machine and OptiCloud data.
  Every tool is defined once, in the portal, so a number in an agent's mail equals the number on the report page.
- **Engine:** Vercel Cron fires a dispatcher; each match starts a **Vercel Workflow** run (retries, sleeps, human-approval steps). AI through Vercel AI Gateway. Email through Resend, other channels later.
- **Scope discipline:** multi-tenant schema and policies from day one, but build only what the first paying customer needs. No generic "automation builder" UI until a second customer shows what really varies.
- **Chat stays in each portal.** The central project is for things that run without someone asking.

### 6.2 What the central project will own
| Part | Notes |
|---|---|
| `automations` | Per account: trigger (schedule or event condition), action (email, in-app notice, report, agent run), recipients, enabled |
| `runs`, `run_steps` | Every run and step with inputs, tool calls, output, cost |
| `notifications` | What was sent to whom, with dedupe keys so an alert isn't sent twice |
| `agents` | Prompt, allowed tools, model, eval set, version |
| `usage_events` | Cost per account (port ai.chat's `usage.ts` / `pricing.ts`) |
| Admin UI | Across customers for OptiPeople; per-account view for the customer |
| Approval inbox | Shown inside each customer portal through a small API, so Kim approves the board report where he already works |

### 6.3 Ventisol's backlog for when it's sold
Automations, in the order the data supports them:

| Automation | Trigger | Action |
|---|---|---|
| Månedsrapport til bestyrelsen | 1st of month 07:00 | Take the portal's frozen snapshot, AI-drafted "Det vigtigste", approval, send |
| Mandagsmail ("Tre tal i én mail") | Monday 07:00 | Lead time, on-time, waiting vs last week |
| Ordre i risiko | Forecast passes delivery week | Notify planner |
| Manglende scanning | Element in but not out after N hours; order packed with an element missing | Notify planner |
| Station stod stille | No scans at an active station for N min in a shift | Notify (off by default) |

The deck's 12 agents, by readiness:
1. **Rapportagent**, **Statusagent**: the data exists once the portal's read model runs.
2. **Flaskehalsagent**, **Kostprisagent**: need normal and calculated times entered in the portal.
3. **Forecast-agent**: uses the same forecast that gives "Forventet klar" on the Ordrer tab (built in the portal anyway).
4. **Kundeagent** (message to the customer when the order is done): needs customer contacts from 3E and Ventisol's consent; draft-and-approve first.
5. **Tilbudsagent**, **Planlægningsagent**, **Bemandingsagent**, **Bufferagent**, **Vedligeholdsagent**, **Kompetenceagent**: need data that doesn't exist yet (planned orders, staffing, KMW, operating hours, skills).

### 6.4 What the Ventisol portal does now so this is cheap later
- Tools in `lib/tools/` as transport-free functions (§5).
- Monthly figures frozen in `rpt.snapshots`, so a later mail sends exactly what the page shows.
- No `auto.*` tables, no Workflow, no Resend in the portal.
- When it is sold: add an MCP endpoint on `lib/tools/` and an approval inbox. Nothing else in the portal changes.

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
4. **Board report**: is a PDF they download and send themselves enough, or do they expect it mailed automatically? Automatic sending needs the central automation project (§6), which isn't sold.
5. **Shift calendar**: confirm shifts (sim shows 06:00–14:00) and whether lead time excludes nights and weekends by default.
6. **Who gets which role**, and should a `viewer` see cost/kalkule numbers?

For **OptiPeople** (backend owner):
7. **Decides §3.1:** can a date filter and a "changed since" cursor be added to `GetRowsPaged` (or a webhook on new rows, or aggregation endpoints), and when?
8. A non-expiring service credential for the sync job (today `ventisolserviceaccount@optipeople.dk` with password + refresh).
9. MCP OAuth client for the Ventisol account.

## 10. Order of work

Each phase ends deployed on ventisol.optipeople.dk. Work inside a phase runs in parallel workstreams that own separate folders.

**Phase 0: Foundation** (one session, sequential)
- Vercel project, domain, env; Supabase project via Marketplace; `supabase/` migrations; CI workflow.
- Auth on top of current `lib/auth.ts`: `portal_users`, roles, minted JWT, RLS helpers, role-aware nav with the new tab structure.
- Deploy the current three reports as-is behind the new auth so Ventisol can log in from day one.

**Phase 1: Read model** (parallel; shape depends on §3.1)
- A. Sync jobs (scans, order documents), watermark, reconcile, rebuild, sync-status page.
- B. Derive module (`core.*`) on the shared rules, with vectors and real-day tests.
- C. 3E PDF parser in TypeScript + element-type mapping + document chunks/embeddings.
- D. `config.*` tables and the Indstillinger pages for stations, element types, times, calendar, users.

**Phase 2: The four tabs** (parallel, one per tab, on `rpt.*` functions)
- Overblik, Stationer, Ordrer (incl. order page, PDF viewer, forecast v1), Ledelse (without sending). Excel/PDF export shared module first. Old routes retired.

**Phase 3: AI chat** (parallel with late Phase 2)
- Chat tools on `rpt.*`, persistence, generative charts, document search, usage/cost, evals with the six deck questions, side panel. MCP second.

**Phase 4: Hardening and go-live**
- Security review, load test on a year of synthetic data, e2e green, docs, handover to the value meetings.

**Not scheduled: automations and agents.** Built in the central project (§6) when sold; the portal's part then is an MCP endpoint on `lib/tools/` and an approval inbox.
