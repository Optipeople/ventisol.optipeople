-- Foundation of the Ventisol portal database.
--
-- Schemas, extensions, claim helpers, and every table that is not derived
-- from scans (those live in core.*, made by the next migration).
--
-- Runs unchanged on hosted Supabase (Postgres 17, connected as postgres) and
-- on PGlite (tests and fixture mode). So: plain SQL only, the extensions
-- vector and pg_trgm, no pg_cron, no Vault, no auth.* or storage.*.
--
-- Access model (docs/portal-architecture.md §3):
--   * The server connects as the table owner. Service code (sync, cron, the
--     first-login row) runs as that role and is not bound by RLS.
--   * User code runs in a transaction that sets request.jwt.claims and drops
--     to the role authenticated. Everything below that says "to authenticated"
--     is what a signed-in portal user can do.
--   * "Service only" tables have RLS on, no policy and no grant.
--   * Nothing is granted to anon.

-- ---------------------------------------------------------------------------
-- Schemas and extensions
-- ---------------------------------------------------------------------------

create schema if not exists raw;
create schema if not exists core;   -- filled by 20261116110000_core.sql
create schema if not exists doc;
create schema if not exists config;
create schema if not exists app;
create schema if not exists ai;
create schema if not exists rpt;

create extension if not exists vector;
create extension if not exists pg_trgm;

grant usage on schema raw, core, doc, config, app, ai, rpt to authenticated;

-- ---------------------------------------------------------------------------
-- app.instance and the claim helpers
-- ---------------------------------------------------------------------------

-- One row: the OptiCloud account this deployment serves. Service code writes
-- it from VENTISOL_ACCOUNT_ID at first use. Until it is there, app.has_role
-- is false for everyone, so an unconfigured database shows nothing.
create table app.instance (
  id         boolean primary key default true check (id),
  account_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table app.instance is 'One row: the OptiCloud account id of this deployment. Service only.';

alter table app.instance enable row level security;
-- Service only: no policy, no grant. app.has_role reads it as definer.

-- The claims of the current request, {} when none are set.
create function app.claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

-- The portal role claim, or null when it is missing or not one of the four.
create function app.current_role()
returns text
language sql
stable
set search_path = ''
as $$
  select r
  from (select app.claims() ->> 'role' as r) c
  where r in ('admin', 'ledelse', 'planner', 'viewer');
$$;

-- The OptiCloud user id claim, or null.
create function app.current_user_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(app.claims() ->> 'opti_user_id', '');
$$;

-- The account claim, or null when it is missing or not a uuid.
create function app.current_account_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when a ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then a::uuid
  end
  from (select app.claims() ->> 'account_id' as a) c;
$$;

-- True when the role claim is one of the given roles AND the account claim is
-- this deployment's account. Never null. Security definer because it reads
-- app.instance, which authenticated cannot read; it takes no table input from
-- the caller and its search_path is pinned.
create function app.has_role(variadic roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from app.instance i
      where i.account_id = app.current_account_id()
    )
    and coalesce(app.current_role() = any (roles), false);
$$;

revoke all on function
  app.claims(),
  app.current_role(),
  app.current_user_id(),
  app.current_account_id(),
  app.has_role(text[])
from public;

grant execute on function
  app.claims(),
  app.current_role(),
  app.current_user_id(),
  app.current_account_id(),
  app.has_role(text[])
to authenticated;

-- Policies call the helpers as (select app.has_role(...)) so the planner runs
-- them once per statement, not once per row.

-- ---------------------------------------------------------------------------
-- app: portal users, audit, rate limits, sync state
-- ---------------------------------------------------------------------------

create table app.portal_users (
  opti_user_id text primary key,
  email        text,
  name         text,
  role         text not null default 'viewer'
               check (role in ('admin', 'ledelse', 'planner', 'viewer')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  created_by   text
);
comment on table app.portal_users is 'OptiCloud user id to portal role. The first-login row is written by service code.';

alter table app.portal_users enable row level security;
grant select, insert, update, delete on app.portal_users to authenticated;

create policy portal_users_select_own on app.portal_users
  for select to authenticated
  using (
    opti_user_id = (select app.current_user_id())
    and (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
  );

create policy portal_users_admin_all on app.portal_users
  for all to authenticated
  using ((select app.has_role('admin')))
  with check ((select app.has_role('admin')));

create table app.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  opti_user_id text,
  role         text,
  action       text not null,
  subject      text,
  detail       jsonb
);
comment on table app.audit_log is 'Append only. Every write and admin action. Rows with a null user are service actions.';

create index audit_log_at_idx on app.audit_log (at desc);
create index audit_log_user_idx on app.audit_log (opti_user_id, at desc);

alter table app.audit_log enable row level security;
-- Insert on these columns only: id and at cannot be chosen by the writer.
-- No update and no delete grant, so the log cannot be rewritten as a user.
grant select on app.audit_log to authenticated;
grant insert (opti_user_id, role, action, subject, detail) on app.audit_log to authenticated;

create policy audit_log_select_admin on app.audit_log
  for select to authenticated
  using ((select app.has_role('admin')));

-- A user can only log as itself, with the role it really holds.
create policy audit_log_insert_own on app.audit_log
  for insert to authenticated
  with check (
    (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
    and opti_user_id = (select app.current_user_id())
    and role = (select app.current_role())
  );

create table app.rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null
);
comment on table app.rate_limits is 'Fixed-window counters. Service only.';

alter table app.rate_limits enable row level security;
-- Service only: no policy, no grant.

create table app.sync_state (
  name            text primary key,
  watermark       text,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  rows_total      bigint,
  detail          jsonb
);
comment on table app.sync_state is 'One row per sync job. Written by service code, read by admin.';

alter table app.sync_state enable row level security;
grant select on app.sync_state to authenticated;

create policy sync_state_select_admin on app.sync_state
  for select to authenticated
  using ((select app.has_role('admin')));

-- ---------------------------------------------------------------------------
-- raw: the mirror of OptiCloud. Service only, never hand-edited.
-- ---------------------------------------------------------------------------

-- 1:1 with the master-data table VentisolScans (docs/opticloud-scans.md).
-- OptiCloud requires no column, so everything but the key is nullable.
create table raw.scans (
  scan_id      text primary key,
  barcode      text,
  order_no     integer,
  position     integer,
  sub_position integer,
  piece        integer,
  station      text,
  station_no   integer,
  station_kind text,
  machine_id   text,
  direction    text check (direction in ('In', 'Out')),
  scan_time    timestamptz,
  duration_sec integer,
  device       text,
  row_id       text,          -- the OptiCloud row id
  created_date timestamptz,   -- when OptiCloud stored the row
  synced_at    timestamptz not null default now()
);

create index scans_order_no_idx on raw.scans (order_no, scan_time);
create index scans_scan_time_idx on raw.scans (scan_time);
create index scans_station_barcode_time_idx on raw.scans (station_no, barcode, scan_time);

alter table raw.scans enable row level security;
-- Service only: no policy, no grant.

-- Mirror of the list VentisolOrderDocuments (docs/order-documents.md) plus
-- what the portal's parser made of the PDF.
create table raw.order_documents (
  file_name      text primary key,
  order_no       integer,
  prefix         text,
  print_date     date,
  blob_reference text,
  blob_name      text,
  content_type   text,
  size_bytes     integer,
  sha256         text,
  device         text,
  claimed_at     timestamptz,
  row_id         text,
  synced_at      timestamptz not null default now(),
  parsed         jsonb,
  parsed_at      timestamptz,
  parser_version text,
  parse_problems jsonb
);

create index order_documents_order_no_idx on raw.order_documents (order_no);

alter table raw.order_documents enable row level security;
-- Service only: no policy, no grant.

-- ---------------------------------------------------------------------------
-- config: master data
-- ---------------------------------------------------------------------------

create table config.stations (
  station_no           integer primary key,
  name                 text not null,
  kind                 text not null check (kind in ('assembly', 'packing', 'machine', 'buffer')),
  opticloud_machine_id text,
  sort_order           integer not null default 0,
  active               boolean not null default true
);

alter table config.stations enable row level security;
grant select, insert, update, delete on config.stations to authenticated;

create policy stations_select on config.stations
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy stations_write_admin on config.stations
  for all to authenticated
  using ((select app.has_role('admin')))
  with check ((select app.has_role('admin')));

create table config.element_types (
  id          text primary key,
  name        text not null,
  recognition jsonb,          -- how lib/orderdoc recognises the type in a 3E PDF
  sort_order  integer not null default 0,
  active      boolean not null default true
);

alter table config.element_types enable row level security;
grant select, insert, update, delete on config.element_types to authenticated;

create policy element_types_select on config.element_types
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy element_types_write_admin on config.element_types
  for all to authenticated
  using ((select app.has_role('admin')))
  with check ((select app.has_role('admin')));

-- The time a piece of this type should take at this station.
create table config.normal_times (
  station_no      integer not null,
  element_type_id text not null references config.element_types (id) on delete cascade,
  seconds         integer not null check (seconds >= 0),
  source          text not null default 'manual' check (source in ('manual', 'baseline')),
  updated_at      timestamptz not null default now(),
  updated_by      text,
  primary key (station_no, element_type_id)
);

create index normal_times_element_type_idx on config.normal_times (element_type_id);

alter table config.normal_times enable row level security;
grant select, insert, update, delete on config.normal_times to authenticated;

create policy normal_times_select on config.normal_times
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy normal_times_write on config.normal_times
  for all to authenticated
  using ((select app.has_role('admin', 'planner')))
  with check ((select app.has_role('admin', 'planner')));

-- The time the quotation calculated for this type at this station. A cost
-- figure: viewer never reads it.
create table config.calculated_times (
  station_no      integer not null,
  element_type_id text not null references config.element_types (id) on delete cascade,
  seconds         integer not null check (seconds >= 0),
  source          text not null default 'manual' check (source in ('manual', 'baseline')),
  updated_at      timestamptz not null default now(),
  updated_by      text,
  primary key (station_no, element_type_id)
);

create index calculated_times_element_type_idx on config.calculated_times (element_type_id);

alter table config.calculated_times enable row level security;
grant select, insert, update, delete on config.calculated_times to authenticated;

create policy calculated_times_select on config.calculated_times
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner')));

create policy calculated_times_write on config.calculated_times
  for all to authenticated
  using ((select app.has_role('admin', 'planner')))
  with check ((select app.has_role('admin', 'planner')));

-- The calendar is two tables ("config.calendar" in the contract's access
-- table): the weekly shifts and the closed days. Times are Europe/Copenhagen
-- wall clock.
create table config.calendar_shifts (
  weekday    smallint not null check (weekday between 1 and 7),  -- ISO: 1 Monday, 7 Sunday
  start_time time not null,
  end_time   time not null,
  primary key (weekday, start_time),
  check (end_time > start_time)
);

alter table config.calendar_shifts enable row level security;
grant select, insert, update, delete on config.calendar_shifts to authenticated;

create policy calendar_shifts_select on config.calendar_shifts
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy calendar_shifts_write on config.calendar_shifts
  for all to authenticated
  using ((select app.has_role('admin', 'planner')))
  with check ((select app.has_role('admin', 'planner')));

create table config.calendar_closed_days (
  day  date primary key,
  name text
);

alter table config.calendar_closed_days enable row level security;
grant select, insert, update, delete on config.calendar_closed_days to authenticated;

create policy calendar_closed_days_select on config.calendar_closed_days
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy calendar_closed_days_write on config.calendar_closed_days
  for all to authenticated
  using ((select app.has_role('admin', 'planner')))
  with check ((select app.has_role('admin', 'planner')));

create table config.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table config.settings enable row level security;
grant select, insert, update, delete on config.settings to authenticated;

create policy settings_select on config.settings
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

create policy settings_write on config.settings
  for all to authenticated
  using ((select app.has_role('admin', 'planner')))
  with check ((select app.has_role('admin', 'planner')));

-- Seed: one day shift Monday to Friday, 06:00 to 14:00.
insert into config.calendar_shifts (weekday, start_time, end_time)
select d, time '06:00', time '14:00' from generate_series(1, 5) as d;

-- Seed: settings. Every value is a default the customer can change under
-- Indstillinger; none of them is measured yet.
insert into config.settings (key, value) values
  -- Minutes a batch is assumed to spend in the Schirmer until its connector
  -- delivers real times. Agreed starting figure: one hour.
  ('schirmer_assumed_minutes_per_batch', '60'),
  -- Elements the buffer before assembly holds. From the customer: 40.
  ('buffer_capacity', '40'),
  -- Lead time counts only time inside the shifts of config.calendar_shifts.
  -- On, because an order waiting overnight is not a delay anyone can act on.
  ('deduct_off_shift', 'true'),
  -- Days after the end of the delivery week (Lev. uge) before an order counts
  -- as late. 0: packed after Sunday of its delivery week is late.
  ('late_threshold', '0'),
  -- A station is slow when its time per piece is more than this many percent
  -- over the normal time. 20 keeps ordinary variation out of the red.
  ('slow_threshold_percent', '20'),
  -- An element has a long dwell when it waits more than this many shift
  -- minutes between two steps. 480 is one full shift.
  ('long_dwell_threshold_minutes', '480'),
  -- A station stands still when it has no scan for this many minutes inside
  -- a shift. 15 is longer than a normal pause between two pieces.
  ('standstill_threshold_minutes', '15'),
  -- "Kalkule mod målt": an element type is flagged when the measured time is
  -- more than this many percent off the calculated time.
  ('calculation_deviation_threshold_percent', '15');

-- ---------------------------------------------------------------------------
-- doc: searchable text of the 3E production lists
-- ---------------------------------------------------------------------------

create table doc.document_chunks (
  id          bigint generated always as identity primary key,
  file_name   text not null references raw.order_documents (file_name) on delete cascade,
  order_no    integer,
  position    integer,
  chunk_index integer not null,
  content     text not null,
  embedding   vector(1536),
  tsv         tsvector generated always as (to_tsvector('danish'::regconfig, content)) stored,
  unique (file_name, chunk_index)
);

create index document_chunks_tsv_idx on doc.document_chunks using gin (tsv);
create index document_chunks_order_no_idx on doc.document_chunks (order_no, position);
-- No vector index yet: with a few thousand chunks an exact scan is fast and
-- always right. Add an hnsw index (vector_cosine_ops) in a later migration
-- when the table is large enough to need it.

alter table doc.document_chunks enable row level security;
grant select on doc.document_chunks to authenticated;

create policy document_chunks_select on doc.document_chunks
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- ai: chat persistence. A user sees and writes only its own conversations.
-- ---------------------------------------------------------------------------

create table ai.conversations (
  id           uuid primary key default gen_random_uuid(),
  opti_user_id text not null,
  title        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);

create index conversations_user_idx on ai.conversations (opti_user_id, updated_at desc);

alter table ai.conversations enable row level security;
grant select, insert, update, delete on ai.conversations to authenticated;

create policy conversations_own on ai.conversations
  for all to authenticated
  using (
    opti_user_id = (select app.current_user_id())
    and (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
  )
  with check (
    opti_user_id = (select app.current_user_id())
    and (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
  );

-- The policies of the child tables look the conversation up in
-- ai.conversations. That lookup is itself filtered by conversations_own, so
-- "the conversation exists" already means "it is mine and I hold a role".

create table ai.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai.conversations (id) on delete cascade,
  role            text not null check (role in ('system', 'user', 'assistant', 'tool')),
  parts           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on ai.messages (conversation_id, created_at);

alter table ai.messages enable row level security;
grant select, insert, update, delete on ai.messages to authenticated;

create policy messages_own on ai.messages
  for all to authenticated
  using (exists (select 1 from ai.conversations c where c.id = conversation_id))
  with check (exists (select 1 from ai.conversations c where c.id = conversation_id));

create table ai.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid references ai.messages (id) on delete cascade,
  conversation_id uuid not null references ai.conversations (id) on delete cascade,
  name            text not null,
  input           jsonb,
  output          jsonb,
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index tool_calls_conversation_idx on ai.tool_calls (conversation_id, created_at);
create index tool_calls_message_idx on ai.tool_calls (message_id);

alter table ai.tool_calls enable row level security;
grant select, insert, update, delete on ai.tool_calls to authenticated;

create policy tool_calls_own on ai.tool_calls
  for all to authenticated
  using (exists (select 1 from ai.conversations c where c.id = conversation_id))
  with check (exists (select 1 from ai.conversations c where c.id = conversation_id));

-- The cost record. It outlives its conversation (set null, not cascade), and
-- a user can add to it but not change or remove it.
create table ai.usage_events (
  id              bigint generated always as identity primary key,
  conversation_id uuid references ai.conversations (id) on delete set null,
  message_id      uuid references ai.messages (id) on delete set null,
  opti_user_id    text not null,
  model           text not null,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  cached_tokens   integer not null default 0,
  cost_usd        numeric(12, 6),
  created_at      timestamptz not null default now()
);

create index usage_events_user_idx on ai.usage_events (opti_user_id, created_at);
create index usage_events_conversation_idx on ai.usage_events (conversation_id);
create index usage_events_message_idx on ai.usage_events (message_id);
create index usage_events_created_idx on ai.usage_events (created_at);

alter table ai.usage_events enable row level security;
grant select, insert on ai.usage_events to authenticated;

create policy usage_events_select on ai.usage_events
  for select to authenticated
  using (
    (
      opti_user_id = (select app.current_user_id())
      and (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
    )
    or (select app.has_role('admin'))
  );

create policy usage_events_insert_own on ai.usage_events
  for insert to authenticated
  with check (
    opti_user_id = (select app.current_user_id())
    and (select app.has_role('admin', 'ledelse', 'planner', 'viewer'))
    and (
      conversation_id is null
      or exists (select 1 from ai.conversations c where c.id = conversation_id)
    )
  );

create table ai.feedback (
  message_id   uuid not null references ai.messages (id) on delete cascade,
  opti_user_id text not null,
  rating       smallint not null check (rating in (-1, 1)),
  comment      text,
  created_at   timestamptz not null default now(),
  primary key (message_id, opti_user_id)
);

alter table ai.feedback enable row level security;
grant select, insert, update, delete on ai.feedback to authenticated;

-- ai.messages is filtered by messages_own, so "the message exists" means it
-- is in one of my conversations.
create policy feedback_own on ai.feedback
  for all to authenticated
  using (
    opti_user_id = (select app.current_user_id())
    and exists (select 1 from ai.messages m where m.id = message_id)
  )
  with check (
    opti_user_id = (select app.current_user_id())
    and exists (select 1 from ai.messages m where m.id = message_id)
  );

-- ---------------------------------------------------------------------------
-- rpt: frozen monthly reports and the management's notes
-- ---------------------------------------------------------------------------

create table rpt.snapshots (
  month     date primary key check (extract(day from month) = 1),
  frozen_at timestamptz not null default now(),
  numbers   jsonb not null,
  pdf_path  text
);
comment on table rpt.snapshots is 'One frozen report per month (first of the month). Written by service code.';

alter table rpt.snapshots enable row level security;
grant select on rpt.snapshots to authenticated;

create policy snapshots_select on rpt.snapshots
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse')));

create table rpt.management_notes (
  month      date primary key check (extract(day from month) = 1),
  highlights jsonb not null default '[]'::jsonb,
  decisions  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table rpt.management_notes enable row level security;
grant select, insert, update, delete on rpt.management_notes to authenticated;

create policy management_notes_all on rpt.management_notes
  for all to authenticated
  using ((select app.has_role('admin', 'ledelse')))
  with check ((select app.has_role('admin', 'ledelse')));
