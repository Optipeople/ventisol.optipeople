-- core.*: the facts derived from raw.scans (and the 3E documents) by
-- apps/web/lib/derive. Never hand-edited: every row can be rebuilt from raw.*.
--
-- Column names are the snake_case of the row types in
-- apps/web/lib/derive/types.ts. The definitions (lead time, steps, packed,
-- on time, standstill) are in docs/read-model.md.
--
-- Conventions: timestamps timestamptz (UTC), durations whole seconds in
-- integer columns named *_seconds, unknown is null (never 0). Where a figure
-- exists both ways, x_seconds is wall clock and x_working_seconds is the
-- time inside the shifts of config.calendar_shifts. The setting
-- deduct_off_shift picks one of the two at read time, with no rebuild.
--
-- Access: every signed-in role reads, only service code writes (no write
-- policy, no write grant). Nothing to anon.
--
-- core.order_facts of the first cut is merged into core.orders: both were
-- one row per order, replaced together.

-- ---------------------------------------------------------------------------
-- core.orders: one row per order, identity and facts
-- ---------------------------------------------------------------------------

create table core.orders (
  order_no                   integer primary key,
  -- From the 3E document, null until one is parsed.
  customer                   text,
  case_name                  text,
  delivery_address           text,
  delivery_year              integer,
  delivery_week              integer check (delivery_week between 1 and 53),
  due_at                     timestamptz,           -- the first instant that is too late
  status                     text not null check (status in ('in_progress', 'packed')),
  packed_source              text check (packed_source in ('document', 'scans')),
  expected_source            text not null check (expected_source in ('document', 'scans')),
  elements_expected          integer,               -- null without a document
  elements_seen              integer not null,
  elements_assembled         integer not null,
  elements_packed            integer not null,
  missing_elements           jsonb,                 -- [{position, subPosition, expected, seen, packed}]
  first_scan_at              timestamptz not null,
  last_scan_at               timestamptz not null,
  start_at                   timestamptz not null,  -- where lead time starts
  start_source               text not null check (start_source in ('first_scan', 'machine')),
  packed_at                  timestamptz,
  start_local_day            date not null,         -- Europe/Copenhagen
  packed_local_day           date,
  lead_seconds               integer,               -- start to packed, null until packed
  lead_working_seconds       integer,
  elapsed_seconds            integer not null,      -- start to packed, or to computed_at
  elapsed_working_seconds    integer not null,
  work_seconds               integer not null,
  work_working_seconds       integer not null,
  wait_seconds               integer not null,
  wait_working_seconds       integer not null,
  touch_seconds              integer not null,      -- sum of all passes
  rework_count               integer not null,
  missing_scan_out_count     integer not null,
  open_count                 integer not null,
  on_time                    boolean,
  current_step               text check (current_step in
                               ('schirmer', 'wait_kmw', 'kmw', 'buffer', 'assembly', 'wait_packing', 'packing')),
  current_station_nos        integer[] not null default '{}',
  forecast_ready_at          timestamptz,           -- an estimate
  forecast_remaining_seconds integer,
  forecast_basis             text check (forecast_basis in ('document', 'seen_elements')),
  at_risk                    boolean,
  computed_at                timestamptz not null,
  check ((status = 'packed') = (packed_at is not null))
);
comment on table core.orders is 'One row per order: 3E identity and the facts derived from its scans. Rebuilt by lib/derive; service writes only.';

-- Ordrer, Afsluttede: packed orders by packing day; the weekly and monthly aggregates.
create index orders_packed_day_idx on core.orders (packed_local_day desc) where status = 'packed';
-- Ordrer, I gang nu; and the writer's clock refresh.
create index orders_in_progress_idx on core.orders (last_scan_at desc) where status = 'in_progress';
create index orders_start_day_idx on core.orders (start_local_day);
-- Search on customer and case name.
create index orders_customer_trgm_idx on core.orders using gin (customer gin_trgm_ops);
create index orders_case_name_trgm_idx on core.orders using gin (case_name gin_trgm_ops);

alter table core.orders enable row level security;
grant select on core.orders to authenticated;

create policy orders_select on core.orders
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- core.elements: one row per barcode seen in a scan
-- ---------------------------------------------------------------------------

create table core.elements (
  barcode                text primary key,
  order_no               integer not null references core.orders (order_no) on delete cascade,
  position               integer,
  sub_position           integer,
  piece                  integer,
  element_type_id        text,                    -- config.element_types.id; no FK, so a type can be removed
  in_document            boolean,                 -- null without a document
  system                 text,
  width_mm               integer,
  height_mm              integer,
  first_scan_at          timestamptz not null,
  last_scan_at           timestamptz not null,
  station_path           integer[] not null default '{}',
  total_seconds          integer,
  total_working_seconds  integer,
  touch_seconds          integer not null,
  rework_count           integer not null,
  missing_scan_out_count integer not null,
  in_progress            boolean not null,
  current_station_no     integer,
  assembled_at           timestamptz,
  packed_at              timestamptz
);
comment on table core.elements is 'One row per element (barcode) seen in a scan, with its path and times.';

create index elements_order_idx on core.elements (order_no, position, sub_position, piece);
create index elements_type_idx on core.elements (element_type_id);

alter table core.elements enable row level security;
grant select on core.elements to authenticated;

create policy elements_select on core.elements
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- core.station_intervals: one element at one station, In to Out
-- ---------------------------------------------------------------------------

create table core.station_intervals (
  interval_id              text primary key,      -- the In scan id, or the Out scan id when the In is missing
  order_no                 integer not null references core.orders (order_no) on delete cascade,
  barcode                  text not null references core.elements (barcode) on delete cascade,
  station_no               integer not null,      -- 0: the scan carried no station number
  station                  text not null,         -- name at scan time
  station_kind             text not null check (station_kind in ('assembly', 'packing')),
  visit                    integer,               -- 1 first pass, 2+ rework, null on a missing scan-out
  is_rework                boolean not null,
  status                   text not null check (status in ('done', 'open', 'missing_out')),
  missing_reason           text check (missing_reason in ('stale', 'superseded')),
  start_at                 timestamptz not null,
  end_at                   timestamptz,
  start_estimated          boolean not null,
  duration_seconds         integer,
  duration_working_seconds integer,
  wait_before_seconds      integer,               -- since the element's previous Out
  wait_before_working_seconds integer,
  element_type_id          text,
  local_day                date not null,         -- the day the pass counts on (Europe/Copenhagen)
  in_scan_id               text,
  out_scan_id              text,
  check ((status = 'done') = (end_at is not null)),
  check ((status = 'missing_out') = (missing_reason is not null))
);
comment on table core.station_intervals is 'Paired In/Out per element per station. status missing_out rows never count in any time.';

create index station_intervals_order_idx on core.station_intervals (order_no, start_at);
create index station_intervals_barcode_idx on core.station_intervals (barcode, start_at);
-- Stationer: a station's passes of a day; and the station-day rebuild.
create index station_intervals_station_day_idx on core.station_intervals (station_no, local_day);
create index station_intervals_station_start_idx on core.station_intervals (station_no, start_at);
-- "In progress now" and the missing scan-out list.
create index station_intervals_not_done_idx on core.station_intervals (status, station_no, start_at)
  where status <> 'done';

alter table core.station_intervals enable row level security;
grant select on core.station_intervals to authenticated;

create policy station_intervals_select on core.station_intervals
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- core.order_steps: seven rows per order, the route
-- ---------------------------------------------------------------------------

create table core.order_steps (
  order_no                 integer not null references core.orders (order_no) on delete cascade,
  step                     text not null check (step in
                             ('schirmer', 'wait_kmw', 'kmw', 'buffer', 'assembly', 'wait_packing', 'packing')),
  seq                      smallint not null,
  kind                     text not null check (kind in ('work', 'wait')),
  -- scans: measured. machine: from a connector. assumed: a setting, shown as "antaget". none: no data yet.
  source                   text not null check (source in ('scans', 'machine', 'assumed', 'none')),
  start_at                 timestamptz,
  end_at                   timestamptz,
  duration_seconds         integer,               -- time counted to the step; null: no data, never 0
  duration_working_seconds integer,
  work_seconds             integer,
  work_working_seconds     integer,
  wait_seconds             integer,
  wait_working_seconds     integer,
  touch_seconds            integer,
  is_open                  boolean not null,
  counts_in_lead           boolean not null,      -- the steps with true add up to the order's lead time
  primary key (order_no, step)
);
comment on table core.order_steps is 'Per order per step. The counts_in_lead steps add up to elapsed_seconds (lead_seconds once packed) of core.orders.';

alter table core.order_steps enable row level security;
grant select on core.order_steps to authenticated;

create policy order_steps_select on core.order_steps
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- core.station_day_facts: one row per station per Copenhagen day with activity
-- ---------------------------------------------------------------------------

create table core.station_day_facts (
  station_no                          integer not null,
  local_day                           date not null,
  station                             text not null,
  station_kind                        text not null check (station_kind in ('assembly', 'packing', 'machine', 'buffer')),
  count_through                       integer not null,   -- finished passes that ended this day
  elements_through                    integer not null,
  rework_passes                       integer not null,
  missing_scan_out_count              integer not null,
  open_count                          integer not null,
  time_per_piece_seconds              integer,            -- median
  time_per_piece_working_seconds      integer,
  mean_piece_seconds                  integer,
  pass_seconds_total                  integer not null,
  available_seconds                   integer not null,   -- shift seconds of the whole day
  observed_seconds                    integer not null,   -- shift seconds up to computed_at
  busy_seconds                        integer not null,
  busy_in_shift_seconds               integer not null,
  idle_seconds                        integer not null,
  longest_gap_seconds                 integer not null,
  gaps                                jsonb not null default '[]'::jsonb,  -- [{startAt, endAt, seconds}]
  longest_wait_before_seconds         integer,
  longest_wait_before_working_seconds integer,
  first_scan_at                       timestamptz,
  last_scan_at                        timestamptz,
  by_element_type                     jsonb not null default '[]'::jsonb,  -- [{elementTypeId, count, medianSeconds, meanSeconds}]
  is_complete                         boolean not null,
  computed_at                         timestamptz not null,
  primary key (station_no, local_day)
);
comment on table core.station_day_facts is 'Per station per day. Normal time, deviation and the status label are applied at read time (stationStatus in lib/derive).';

-- Stationer for one day across stations; trends walk the primary key.
create index station_day_facts_day_idx on core.station_day_facts (local_day);

alter table core.station_day_facts enable row level security;
grant select on core.station_day_facts to authenticated;

create policy station_day_facts_select on core.station_day_facts
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- ---------------------------------------------------------------------------
-- Empty until the connectors deliver (plan §7). Shaped so that connector
-- work only fills tables.
-- ---------------------------------------------------------------------------

-- A production batch (a Schirmer run, a 3E batch). The barcode carries no
-- batch number, so nothing fills this until Ventisol says where it comes from.
create table core.batches (
  batch_id      text primary key,
  source        text not null,                    -- 'schirmer', '3e', ...
  batch_no      text,
  started_at    timestamptz,
  ended_at      timestamptz,
  duration_seconds integer,
  element_count integer,
  detail        jsonb,
  computed_at   timestamptz not null default now()
);
comment on table core.batches is 'Empty until batch data exists (plan §9, question 1).';

create index batches_started_idx on core.batches (started_at);

alter table core.batches enable row level security;
grant select on core.batches to authenticated;

create policy batches_select on core.batches
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- Which elements a batch holds. No FK to core.elements: a batch is known
-- before its elements are first scanned.
create table core.batch_elements (
  batch_id text not null references core.batches (batch_id) on delete cascade,
  barcode  text not null,
  order_no integer,
  primary key (batch_id, barcode)
);
comment on table core.batch_elements is 'Empty until batch data exists.';

create index batch_elements_barcode_idx on core.batch_elements (barcode);
create index batch_elements_order_idx on core.batch_elements (order_no);

alter table core.batch_elements enable row level security;
grant select on core.batch_elements to authenticated;

create policy batch_elements_select on core.batch_elements
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));

-- One event or run from a machine: Schirmer start/stop, KMW welding, KMW
-- corner cleaning, buffer in/out and fill level.
create table core.machine_events (
  id               bigint generated always as identity primary key,
  machine          text not null,                 -- 'schirmer', 'kmw_welding', 'kmw_corner_cleaning', 'buffer'
  station_no       integer,                       -- config.stations row of kind machine or buffer, when set up
  event_type       text not null,                 -- 'run', 'start', 'stop', 'in', 'out', 'fill_level'
  event_at         timestamptz not null,
  ended_at         timestamptz,                   -- for a run
  duration_seconds integer,
  order_no         integer,
  barcode          text,
  batch_id         text references core.batches (batch_id) on delete set null,
  value            numeric,                       -- e.g. the buffer fill level
  source_id        text unique,                   -- the connector's own id, so a re-send is recognised
  payload          jsonb,
  synced_at        timestamptz not null default now()
);
comment on table core.machine_events is 'Empty until the Schirmer and KMW connectors deliver.';

create index machine_events_machine_time_idx on core.machine_events (machine, event_at);
create index machine_events_order_idx on core.machine_events (order_no, event_at);
create index machine_events_barcode_idx on core.machine_events (barcode);
create index machine_events_batch_idx on core.machine_events (batch_id);

alter table core.machine_events enable row level security;
grant select on core.machine_events to authenticated;

create policy machine_events_select on core.machine_events
  for select to authenticated
  using ((select app.has_role('admin', 'ledelse', 'planner', 'viewer')));
