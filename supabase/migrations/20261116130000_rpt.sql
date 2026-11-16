-- rpt.*: the report functions. They turn core.* (derived facts) and config.*
-- (master data and thresholds) into the numbers the pages and the chat show.
-- The TypeScript wrappers in apps/web/lib/reports are the only callers.
-- One section per function in docs/reports.md; the definitions behind the
-- numbers are in docs/read-model.md.
--
-- Rules kept by every function here:
--   * security invoker (the default), so row level security decides what the
--     caller sees. The one exception is rpt.order_documents, see there.
--   * stable, search_path pinned to '', every name schema qualified.
--   * No clock and no time zone inside: days come in as date (Europe/Copenhagen
--     days, as stored in core.*), "now" comes in as p_now.
--   * Durations go out on both clocks (x_seconds wall clock, x_working_seconds
--     shift time). The wrapper picks the headline from deduct_off_shift.
--   * Unknown is null, never 0.
--   * Execute is granted to authenticated only.
--
-- Runs on hosted Postgres 17 and on PGlite: plain SQL and plpgsql.

-- ---------------------------------------------------------------------------
-- Indexes the report queries want and the earlier migrations lack
-- ---------------------------------------------------------------------------

-- Ordrer, Afsluttede: newest packed first. The columns and the null order are
-- exactly the default sort of rpt.orders_finished, or the index is not used.
create index orders_packed_at_idx on core.orders (packed_at desc nulls last, order_no desc)
  where status = 'packed';
-- Ordrer, I gang nu: newest started first, the default sort of rpt.orders_in_progress.
create index orders_in_progress_start_idx on core.orders (start_at desc nulls last, order_no desc)
  where status = 'in_progress';
-- No index for the text search: it is one OR over customer, case name and the
-- start of the order number, so it reads core.orders once whatever exists
-- (and LIKE is not leakproof, so under row level security an index on
-- order_no::text is never used for it). Measured: a few ms on 2400 orders.
-- Passes of a day or a period across all stations (today strip, baseline, kalkule mod målt).
create index station_intervals_local_day_idx on core.station_intervals (local_day) where status = 'done';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Raises insufficient_privilege unless the caller holds one of the roles.
-- Service code (sync, cron: the table owner, with no claims) passes: it is not
-- a portal user and is not bound by row level security either. Only the
-- roles authenticated and anon are ever held to the claim.
create function rpt.require_role(variadic roles text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and not app.has_role(variadic roles) then
    raise exception 'This report needs one of the roles: %', pg_catalog.array_to_string(roles, ', ')
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- The read-time settings as one object, with the seed values as fallback.
create function rpt.settings()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with s as (
    select
      (select value #>> '{}' from config.settings where key = 'deduct_off_shift') as deduct,
      (select value #>> '{}' from config.settings where key = 'slow_threshold_percent') as slow,
      (select value #>> '{}' from config.settings where key = 'standstill_threshold_minutes') as standstill,
      (select value #>> '{}' from config.settings where key = 'long_dwell_threshold_minutes') as dwell,
      (select value #>> '{}' from config.settings where key = 'calculation_deviation_threshold_percent') as calc,
      (select value #>> '{}' from config.settings where key = 'late_threshold') as late,
      (select value #>> '{}' from config.settings where key = 'buffer_capacity') as buffer,
      (select value #>> '{}' from config.settings where key = 'schirmer_assumed_minutes_per_batch') as schirmer
  )
  select jsonb_build_object(
    'use_working_time', coalesce(s.deduct::boolean, true),
    'slow_threshold_percent', coalesce(s.slow::numeric, 20),
    'standstill_threshold_minutes', coalesce(s.standstill::numeric, 15),
    'long_dwell_threshold_minutes', coalesce(s.dwell::numeric, 480),
    'calculation_deviation_threshold_percent', coalesce(s.calc::numeric, 15),
    'late_threshold_days', coalesce(s.late::numeric, 0),
    'buffer_capacity', s.buffer::numeric,
    'schirmer_assumed_minutes_per_batch', s.schirmer::numeric
  )
  from s;
$$;

-- Every station of config.stations with its normal times, in display order.
create function rpt.stations()
returns table (
  station_no   integer,
  name         text,
  kind         text,
  sort_order   integer,
  active       boolean,
  normal_times jsonb      -- [{elementTypeId, seconds}]
)
language sql
stable
set search_path = ''
as $$
  select c.station_no, c.name, c.kind, c.sort_order, c.active,
         coalesce((
           select jsonb_agg(jsonb_build_object('elementTypeId', n.element_type_id, 'seconds', n.seconds)
                            order by n.element_type_id)
           from config.normal_times n
           where n.station_no = c.station_no
         ), '[]'::jsonb)
  from config.stations c
  order by c.sort_order, c.station_no;
$$;

-- ---------------------------------------------------------------------------
-- Overblik
-- ---------------------------------------------------------------------------

-- The KPIs of the orders packed in [p_from, p_to] (by packed_local_day).
-- One row, also for an empty period (counts 0, averages null).
create function rpt.period_kpis(p_from date, p_to date)
returns table (
  orders_packed        integer,
  elements_packed      integer,
  lead_seconds         integer,   -- mean per order
  lead_working_seconds integer,
  work_seconds         integer,
  work_working_seconds integer,
  wait_seconds         integer,
  wait_working_seconds integer,
  touch_seconds        integer,
  on_time_orders       integer,   -- packed before due_at
  on_time_known        integer,   -- packed orders that have a delivery week
  on_time_percent      numeric,   -- of on_time_known; null when that is 0
  rework_orders        integer
)
language sql
stable
set search_path = ''
as $$
  select
    count(*)::integer,
    coalesce(sum(o.elements_packed), 0)::integer,
    round(avg(o.lead_seconds))::integer,
    round(avg(o.lead_working_seconds))::integer,
    round(avg(o.work_seconds))::integer,
    round(avg(o.work_working_seconds))::integer,
    round(avg(o.wait_seconds))::integer,
    round(avg(o.wait_working_seconds))::integer,
    round(avg(o.touch_seconds))::integer,
    (count(*) filter (where o.on_time))::integer,
    count(o.on_time)::integer,
    case when count(o.on_time) > 0
      then round(100.0 * (count(*) filter (where o.on_time)) / count(o.on_time), 1)
    end,
    (count(*) filter (where o.rework_count > 0))::integer
  from core.orders o
  where o.status = 'packed'
    and o.packed_local_day between p_from and p_to;
$$;

-- Lead time per ISO week or calendar month, split in work and waiting.
-- One row per bucket that touches [p_from, p_to], also the empty ones. Only
-- orders packed inside [p_from, p_to] count, so a cut first or last bucket
-- holds only its days inside the range.
create function rpt.lead_time_series(p_from date, p_to date, p_bucket text)
returns table (
  bucket_start         date,
  bucket_end           date,
  iso_year             integer,
  iso_week             integer,
  orders_packed        integer,
  lead_seconds         integer,
  lead_working_seconds integer,
  work_seconds         integer,
  work_working_seconds integer,
  wait_seconds         integer,
  wait_working_seconds integer
)
language sql
stable
set search_path = ''
as $$
  with step as (
    select case p_bucket when 'month' then interval '1 month' else interval '7 days' end as size
  ),
  b as (
    select gs::date as bucket_start,
           ((gs + step.size)::date - 1) as bucket_end
    from step,
         generate_series(date_trunc(p_bucket, p_from::timestamp), p_to::timestamp, step.size) as gs
    where p_bucket in ('week', 'month')
  )
  select
    b.bucket_start,
    b.bucket_end,
    extract(isoyear from b.bucket_start)::integer,
    extract(week from b.bucket_start)::integer,
    count(o.order_no)::integer,
    round(avg(o.lead_seconds))::integer,
    round(avg(o.lead_working_seconds))::integer,
    round(avg(o.work_seconds))::integer,
    round(avg(o.work_working_seconds))::integer,
    round(avg(o.wait_seconds))::integer,
    round(avg(o.wait_working_seconds))::integer
  from b
  left join core.orders o
    on o.status = 'packed'
   and o.packed_local_day >= greatest(b.bucket_start, p_from)
   and o.packed_local_day <= least(b.bucket_end, p_to)
  group by b.bucket_start, b.bucket_end
  order by b.bucket_start;
$$;

-- Where the time of an order goes: the seven steps for the orders packed in
-- [p_from, p_to]. Always seven rows. Sums, not averages, so the wrapper can
-- round the averages so that they still add up to the average lead time.
--   counted_*: the rows with counts_in_lead (measured). Divide by `orders`.
--   assumed_*: rows with a duration that does not count in the lead time
--              (source assumed). Divide by assumed_orders.
create function rpt.step_times(p_from date, p_to date)
returns table (
  step                     text,
  seq                      smallint,
  kind                     text,
  source                   text,     -- machine, scans, assumed or none
  orders                   integer,  -- packed orders in the period
  orders_with_data         integer,  -- of them, with a measured duration for the step
  duration_seconds         bigint,
  duration_working_seconds bigint,
  work_seconds             bigint,
  work_working_seconds     bigint,
  wait_seconds             bigint,
  wait_working_seconds     bigint,
  touch_seconds            bigint,
  assumed_orders           integer,
  assumed_seconds          bigint
)
language sql
stable
set search_path = ''
as $$
  with o as (
    select x.order_no
    from core.orders x
    where x.status = 'packed' and x.packed_local_day between p_from and p_to
  ),
  n as (select count(*)::integer as orders from o),
  k (step, seq, kind) as (
    values ('schirmer', 1, 'work'), ('wait_kmw', 2, 'wait'), ('kmw', 3, 'work'), ('buffer', 4, 'wait'),
           ('assembly', 5, 'work'), ('wait_packing', 6, 'wait'), ('packing', 7, 'work')
  ),
  s as (
    select st.*
    from core.order_steps st
    join o on o.order_no = st.order_no
  )
  select
    k.step,
    k.seq::smallint,
    k.kind,
    case
      when bool_or(s.counts_in_lead and s.duration_seconds is not null and s.source = 'machine') then 'machine'
      when bool_or(s.counts_in_lead and s.duration_seconds is not null) then 'scans'
      when bool_or(s.duration_seconds is not null) then 'assumed'
      else 'none'
    end,
    n.orders,
    (count(*) filter (where s.counts_in_lead and s.duration_seconds is not null))::integer,
    sum(s.duration_seconds) filter (where s.counts_in_lead),
    sum(s.duration_working_seconds) filter (where s.counts_in_lead),
    sum(s.work_seconds) filter (where s.counts_in_lead),
    sum(s.work_working_seconds) filter (where s.counts_in_lead),
    sum(s.wait_seconds) filter (where s.counts_in_lead),
    sum(s.wait_working_seconds) filter (where s.counts_in_lead),
    sum(s.touch_seconds) filter (where s.counts_in_lead),
    (count(*) filter (where not s.counts_in_lead and s.duration_seconds is not null))::integer,
    sum(s.duration_seconds) filter (where not s.counts_in_lead)
  from k
  cross join n
  left join s on s.step = k.step
  group by k.step, k.seq, k.kind, n.orders
  order by k.seq;
$$;

-- The today strip. p_today is the Copenhagen day of p_now.
create function rpt.today(p_today date, p_now timestamptz, p_active_days integer default 14)
returns table (
  orders_in_progress  integer,  -- every order not packed
  orders_active       integer,  -- of them, scanned within p_active_days
  orders_at_risk      integer,  -- in progress and late or at risk
  orders_packed_today integer,
  passes_today        integer,  -- finished passes that ended today, all stations
  elements_through    integer,  -- distinct elements among them
  elements_packed     integer,  -- distinct elements through packing today
  stations_running    integer,  -- stations with an element on them now
  stations_total      integer   -- active assembly and packing stations
)
language sql
stable
set search_path = ''
as $$
  select
    (select count(*) from core.orders o where o.status = 'in_progress')::integer,
    (select count(*) from core.orders o
      where o.status = 'in_progress'
        and o.last_scan_at >= p_now - make_interval(days => p_active_days))::integer,
    (select count(*) from core.orders o
      where o.status = 'in_progress' and (o.at_risk or o.due_at <= p_now))::integer,
    (select count(*) from core.orders o
      where o.status = 'packed' and o.packed_local_day = p_today)::integer,
    (select count(*) from core.station_intervals i
      where i.status = 'done' and i.local_day = p_today)::integer,
    (select count(distinct i.barcode) from core.station_intervals i
      where i.status = 'done' and i.local_day = p_today)::integer,
    (select count(distinct i.barcode) from core.station_intervals i
      where i.status = 'done' and i.local_day = p_today and i.station_kind = 'packing')::integer,
    (select count(distinct i.station_no) from core.station_intervals i where i.status = 'open')::integer,
    (select count(*) from config.stations c
      where c.active and c.kind in ('assembly', 'packing'))::integer;
$$;

-- ---------------------------------------------------------------------------
-- Stationer
-- ---------------------------------------------------------------------------

-- One row per station for one day: every active station of config.stations
-- (machines and the buffer too, with has_facts false until data exists), plus
-- any station with facts that day that is not set up. The stored primitives
-- only: normal, deviation and status are applied by the wrapper with
-- stationStatus() of lib/derive, the one place that owns the label.
create function rpt.station_day(p_day date)
returns table (
  station_no                          integer,
  name                                text,
  kind                                text,
  sort_order                          integer,
  configured                          boolean,
  has_facts                           boolean,
  count_through                       integer,
  elements_through                    integer,
  rework_passes                       integer,
  missing_scan_out_count              integer,
  open_count                          integer,
  time_per_piece_seconds              integer,
  time_per_piece_working_seconds      integer,
  mean_piece_seconds                  integer,
  pass_seconds_total                  integer,
  available_seconds                   integer,
  observed_seconds                    integer,
  busy_seconds                        integer,
  busy_in_shift_seconds               integer,
  idle_seconds                        integer,
  longest_gap_seconds                 integer,
  gaps                                jsonb,
  longest_wait_before_seconds         integer,
  longest_wait_before_working_seconds integer,
  first_scan_at                       timestamptz,
  last_scan_at                        timestamptz,
  by_element_type                     jsonb,
  is_complete                         boolean,
  computed_at                         timestamptz,
  days_active                         integer,
  normal_times                        jsonb
)
language sql
stable
set search_path = ''
as $$
  with keys as (
    select c.station_no from config.stations c where c.active
    union
    select f.station_no from core.station_day_facts f where f.local_day = p_day
  )
  select
    k.station_no,
    coalesce(c.name, f.station, 'Station nr. ' || k.station_no),
    coalesce(c.kind, f.station_kind),
    coalesce(c.sort_order, 1000000 + k.station_no),
    c.station_no is not null,
    f.station_no is not null,
    f.count_through, f.elements_through, f.rework_passes, f.missing_scan_out_count, f.open_count,
    f.time_per_piece_seconds, f.time_per_piece_working_seconds, f.mean_piece_seconds, f.pass_seconds_total,
    f.available_seconds, f.observed_seconds, f.busy_seconds, f.busy_in_shift_seconds, f.idle_seconds,
    f.longest_gap_seconds, f.gaps, f.longest_wait_before_seconds, f.longest_wait_before_working_seconds,
    f.first_scan_at, f.last_scan_at, f.by_element_type, f.is_complete, f.computed_at,
    case when f.station_no is not null then 1 end,
    coalesce((
      select jsonb_agg(jsonb_build_object('elementTypeId', n.element_type_id, 'seconds', n.seconds)
                       order by n.element_type_id)
      from config.normal_times n
      where n.station_no = k.station_no
    ), '[]'::jsonb)
  from keys k
  left join config.stations c on c.station_no = k.station_no
  left join core.station_day_facts f on f.station_no = k.station_no and f.local_day = p_day
  order by 4, 1;
$$;

-- Station figures for a period, per bucket: 'all' (one row per station),
-- 'day', 'week' or 'month'. Same columns as rpt.station_day. Medians come from
-- core.station_intervals (the passes that ended in the bucket), not from an
-- average of daily medians (docs/read-model.md §7). The shift, busy and gap
-- columns are summed from core.station_day_facts. Only stations and buckets
-- with data give a row.
create function rpt.station_performance(
  p_from date,
  p_to date,
  p_station_no integer default null,
  p_bucket text default 'all'
)
returns table (
  bucket_start                        date,
  station_no                          integer,
  name                                text,
  kind                                text,
  sort_order                          integer,
  configured                          boolean,
  has_facts                           boolean,
  count_through                       integer,
  elements_through                    integer,
  rework_passes                       integer,
  missing_scan_out_count              integer,
  open_count                          integer,
  time_per_piece_seconds              integer,
  time_per_piece_working_seconds      integer,
  mean_piece_seconds                  integer,
  pass_seconds_total                  integer,
  available_seconds                   integer,
  observed_seconds                    integer,
  busy_seconds                        integer,
  busy_in_shift_seconds               integer,
  idle_seconds                        integer,
  longest_gap_seconds                 integer,
  gaps                                jsonb,
  longest_wait_before_seconds         integer,
  longest_wait_before_working_seconds integer,
  avg_wait_before_seconds             integer,
  avg_wait_before_working_seconds     integer,
  first_scan_at                       timestamptz,
  last_scan_at                        timestamptz,
  by_element_type                     jsonb,
  days_active                         integer,
  normal_times                        jsonb
)
language sql
stable
set search_path = ''
as $$
  with iv as (
    select i.station_no, i.station, i.station_kind, i.barcode, i.is_rework, i.start_at,
           i.duration_seconds, i.duration_working_seconds,
           i.wait_before_seconds, i.wait_before_working_seconds, i.element_type_id,
           case p_bucket
             when 'day' then i.local_day
             when 'week' then date_trunc('week', i.local_day::timestamp)::date
             when 'month' then date_trunc('month', i.local_day::timestamp)::date
             else p_from
           end as bucket_start
    from core.station_intervals i
    where i.status = 'done'
      and i.local_day between p_from and p_to
      and (p_station_no is null or i.station_no = p_station_no)
  ),
  agg as (
    select iv.station_no, iv.bucket_start,
           count(*)::integer as count_through,
           count(distinct iv.barcode)::integer as elements_through,
           (count(*) filter (where iv.is_rework))::integer as rework_passes,
           round(percentile_cont(0.5) within group (order by iv.duration_seconds)::numeric)::integer as time_per_piece_seconds,
           round(percentile_cont(0.5) within group (order by iv.duration_working_seconds)::numeric)::integer as time_per_piece_working_seconds,
           round(avg(iv.duration_seconds))::integer as mean_piece_seconds,
           sum(iv.duration_seconds)::integer as pass_seconds_total,
           max(iv.wait_before_seconds) as longest_wait_before_seconds,
           max(iv.wait_before_working_seconds) as longest_wait_before_working_seconds,
           round(avg(iv.wait_before_seconds))::integer as avg_wait_before_seconds,
           round(avg(iv.wait_before_working_seconds))::integer as avg_wait_before_working_seconds,
           (array_agg(iv.station order by iv.start_at desc))[1] as station,
           (array_agg(iv.station_kind order by iv.start_at desc))[1] as station_kind
    from iv
    group by iv.station_no, iv.bucket_start
  ),
  types as (
    select t.station_no, t.bucket_start,
           jsonb_agg(jsonb_build_object(
             'elementTypeId', t.element_type_id,
             'count', t.n,
             'medianSeconds', t.median_seconds,
             'medianWorkingSeconds', t.median_working_seconds,
             'meanSeconds', t.mean_seconds
           ) order by t.element_type_id) as by_element_type
    from (
      select iv.station_no, iv.bucket_start, iv.element_type_id,
             count(*)::integer as n,
             round(percentile_cont(0.5) within group (order by iv.duration_seconds)::numeric)::integer as median_seconds,
             round(percentile_cont(0.5) within group (order by iv.duration_working_seconds)::numeric)::integer as median_working_seconds,
             round(avg(iv.duration_seconds))::integer as mean_seconds
      from iv
      group by iv.station_no, iv.bucket_start, iv.element_type_id
    ) t
    group by t.station_no, t.bucket_start
  ),
  facts as (
    select f.*,
           case p_bucket
             when 'day' then f.local_day
             when 'week' then date_trunc('week', f.local_day::timestamp)::date
             when 'month' then date_trunc('month', f.local_day::timestamp)::date
             else p_from
           end as bucket_start
    from core.station_day_facts f
    where f.local_day between p_from and p_to
      and (p_station_no is null or f.station_no = p_station_no)
  ),
  dayagg as (
    select f.station_no, f.bucket_start,
           count(*)::integer as days_active,
           sum(f.missing_scan_out_count)::integer as missing_scan_out_count,
           -- Elements on the station now: only the newest day knows.
           (array_agg(f.open_count order by f.local_day desc))[1] as open_count,
           sum(f.available_seconds)::integer as available_seconds,
           sum(f.observed_seconds)::integer as observed_seconds,
           sum(f.busy_seconds)::integer as busy_seconds,
           sum(f.busy_in_shift_seconds)::integer as busy_in_shift_seconds,
           sum(f.idle_seconds)::integer as idle_seconds,
           max(f.longest_gap_seconds) as longest_gap_seconds,
           min(f.first_scan_at) as first_scan_at,
           max(f.last_scan_at) as last_scan_at,
           (array_agg(f.station order by f.local_day desc))[1] as station,
           (array_agg(f.station_kind order by f.local_day desc))[1] as station_kind
    from facts f
    group by f.station_no, f.bucket_start
  ),
  gapagg as (
    select f.station_no, f.bucket_start,
           jsonb_agg(g.gap order by g.gap ->> 'startAt') as gaps
    from facts f
    cross join lateral jsonb_array_elements(f.gaps) as g (gap)
    group by f.station_no, f.bucket_start
  ),
  keys as (
    select a.station_no, a.bucket_start from agg a
    union
    select d.station_no, d.bucket_start from dayagg d
  )
  select
    k.bucket_start,
    k.station_no,
    coalesce(c.name, d.station, a.station, 'Station nr. ' || k.station_no),
    coalesce(c.kind, d.station_kind, a.station_kind),
    coalesce(c.sort_order, 1000000 + k.station_no),
    c.station_no is not null,
    true,
    coalesce(a.count_through, 0),
    coalesce(a.elements_through, 0),
    coalesce(a.rework_passes, 0),
    coalesce(d.missing_scan_out_count, 0),
    coalesce(d.open_count, 0),
    a.time_per_piece_seconds,
    a.time_per_piece_working_seconds,
    a.mean_piece_seconds,
    coalesce(a.pass_seconds_total, 0),
    d.available_seconds,
    d.observed_seconds,
    d.busy_seconds,
    d.busy_in_shift_seconds,
    d.idle_seconds,
    d.longest_gap_seconds,
    coalesce(g.gaps, '[]'::jsonb),
    a.longest_wait_before_seconds,
    a.longest_wait_before_working_seconds,
    a.avg_wait_before_seconds,
    a.avg_wait_before_working_seconds,
    d.first_scan_at,
    d.last_scan_at,
    coalesce(t.by_element_type, '[]'::jsonb),
    coalesce(d.days_active, 0),
    coalesce((
      select jsonb_agg(jsonb_build_object('elementTypeId', n.element_type_id, 'seconds', n.seconds)
                       order by n.element_type_id)
      from config.normal_times n
      where n.station_no = k.station_no
    ), '[]'::jsonb)
  from keys k
  left join agg a on a.station_no = k.station_no and a.bucket_start = k.bucket_start
  left join dayagg d on d.station_no = k.station_no and d.bucket_start = k.bucket_start
  left join types t on t.station_no = k.station_no and t.bucket_start = k.bucket_start
  left join gapagg g on g.station_no = k.station_no and g.bucket_start = k.bucket_start
  left join config.stations c on c.station_no = k.station_no
  order by 1, 5, 2;
$$;

-- The day timeline of one station: every pass that touches
-- [p_day_start, p_day_end), plus the missing scan-outs that started in it.
-- The two instants are the Copenhagen day's start and end, from the wrapper.
create function rpt.station_timeline(p_station_no integer, p_day_start timestamptz, p_day_end timestamptz)
returns table (
  interval_id                 text,
  order_no                    integer,
  barcode                     text,
  "position"                  integer,
  sub_position                integer,
  piece                       integer,
  element_type_id             text,
  element_type_name           text,
  status                      text,
  missing_reason              text,
  visit                       integer,
  is_rework                   boolean,
  start_at                    timestamptz,
  end_at                      timestamptz,
  start_estimated             boolean,
  duration_seconds            integer,
  duration_working_seconds    integer,
  wait_before_seconds         integer,
  wait_before_working_seconds integer
)
language sql
stable
set search_path = ''
as $$
  select i.interval_id, i.order_no, i.barcode, e.position, e.sub_position, e.piece,
         i.element_type_id, t.name, i.status, i.missing_reason, i.visit, i.is_rework,
         i.start_at, i.end_at, i.start_estimated, i.duration_seconds, i.duration_working_seconds,
         i.wait_before_seconds, i.wait_before_working_seconds
  from core.station_intervals i
  left join core.elements e on e.barcode = i.barcode
  left join config.element_types t on t.id = i.element_type_id
  where i.station_no = p_station_no
    and i.start_at < p_day_end
    and (
      i.end_at >= p_day_start
      or (i.status = 'open')
      or (i.status = 'missing_out' and i.start_at >= p_day_start)
    )
  order by i.start_at, i.interval_id;
$$;

-- How the pass times of one station spread, per element type, for the passes
-- that ended in [p_from, p_to]. Wall clock quartiles, plus the working-time
-- median and the type's normal time here.
create function rpt.station_type_distribution(p_station_no integer, p_from date, p_to date)
returns table (
  element_type_id        text,
  element_type_name      text,
  passes                 integer,
  min_seconds            integer,
  p25_seconds            integer,
  median_seconds         integer,
  p75_seconds            integer,
  max_seconds            integer,
  mean_seconds           integer,
  median_working_seconds integer,
  normal_seconds         integer
)
language sql
stable
set search_path = ''
as $$
  select
    m.element_type_id,
    t.name,
    m.passes, m.min_seconds, m.p25_seconds, m.median_seconds, m.p75_seconds, m.max_seconds,
    m.mean_seconds, m.median_working_seconds,
    n.seconds
  from (
    select i.element_type_id,
           count(*)::integer as passes,
           min(i.duration_seconds) as min_seconds,
           round(percentile_cont(0.25) within group (order by i.duration_seconds)::numeric)::integer as p25_seconds,
           round(percentile_cont(0.5) within group (order by i.duration_seconds)::numeric)::integer as median_seconds,
           round(percentile_cont(0.75) within group (order by i.duration_seconds)::numeric)::integer as p75_seconds,
           max(i.duration_seconds) as max_seconds,
           round(avg(i.duration_seconds))::integer as mean_seconds,
           round(percentile_cont(0.5) within group (order by i.duration_working_seconds)::numeric)::integer as median_working_seconds
    from core.station_intervals i
    where i.station_no = p_station_no
      and i.status = 'done'
      and i.local_day between p_from and p_to
    group by i.element_type_id
  ) m
  left join config.element_types t on t.id = m.element_type_id
  left join config.normal_times n on n.station_no = p_station_no and n.element_type_id = m.element_type_id
  order by t.sort_order nulls last, m.element_type_id nulls last;
$$;

-- ---------------------------------------------------------------------------
-- Ordrer
-- ---------------------------------------------------------------------------

-- Turns what a user typed into a LIKE pattern body: %, _ and \ lose their
-- meaning. Null for an empty search.
create function rpt.like_escape(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    replace(replace(replace(btrim(p_text), '\', '\\'), '%', '\%'), '_', '\_'),
    ''
  );
$$;

-- Afsluttede: packed orders, newest first unless p_sort says otherwise.
--   p_search  matches the start of the order number, or any part of the
--             customer or the case name (case insensitive).
--   p_from, p_to  packed_local_day range, either may be null.
--   p_status  'on_time', 'late', 'unknown' (no delivery week) or null for all.
--   p_sort    order, customer, elements, start, packed, lead, wait, status.
--             Anything else sorts by packed. The column is chosen from this
--             fixed list, never taken from the input.
--   p_working sort lead and wait on the working-time column.
-- total_count is the number of matches before paging, on every row.
create function rpt.orders_finished(
  p_search  text default null,
  p_from    date default null,
  p_to      date default null,
  p_status  text default null,
  p_sort    text default 'packed',
  p_dir     text default 'desc',
  p_limit   integer default 50,
  p_offset  integer default 0,
  p_working boolean default true
)
returns table (
  order_no               integer,
  customer               text,
  case_name              text,
  delivery_year          integer,
  delivery_week          integer,
  due_at                 timestamptz,
  elements_expected      integer,
  elements_seen          integer,
  elements_packed        integer,
  start_at               timestamptz,
  packed_at              timestamptz,
  packed_local_day       date,
  lead_seconds           integer,
  lead_working_seconds   integer,
  work_seconds           integer,
  work_working_seconds   integer,
  wait_seconds           integer,
  wait_working_seconds   integer,
  touch_seconds          integer,
  rework_count           integer,
  missing_scan_out_count integer,
  on_time                boolean,
  packed_source          text,
  expected_source        text,
  total_count            bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_pattern text := rpt.like_escape(p_search);
  v_digits  text := case when btrim(coalesce(p_search, '')) ~ '^[0-9]+$' then btrim(p_search) end;
  v_dir     text := case when lower(coalesce(p_dir, '')) = 'asc' then 'asc' else 'desc' end;
  v_order   text;
begin
  v_order := case p_sort
    when 'order' then 'o.order_no'
    when 'customer' then 'o.customer'
    when 'elements' then 'coalesce(o.elements_expected, o.elements_seen)'
    when 'start' then 'o.start_at'
    when 'lead' then case when p_working then 'o.lead_working_seconds' else 'o.lead_seconds' end
    when 'wait' then case when p_working then 'o.wait_working_seconds' else 'o.wait_seconds' end
    when 'status' then 'o.on_time'
    else 'o.packed_at'
  end;

  return query execute format($q$
    select o.order_no, o.customer, o.case_name, o.delivery_year, o.delivery_week, o.due_at,
           o.elements_expected, o.elements_seen, o.elements_packed, o.start_at, o.packed_at,
           o.packed_local_day, o.lead_seconds, o.lead_working_seconds, o.work_seconds,
           o.work_working_seconds, o.wait_seconds, o.wait_working_seconds, o.touch_seconds,
           o.rework_count, o.missing_scan_out_count, o.on_time, o.packed_source, o.expected_source,
           count(*) over ()
    from core.orders o
    where o.status = 'packed'
      and ($1::date is null or o.packed_local_day >= $1)
      and ($2::date is null or o.packed_local_day <= $2)
      and ($3::text is null
           or ($3 = 'on_time' and o.on_time)
           or ($3 = 'late' and not o.on_time)
           or ($3 = 'unknown' and o.on_time is null))
      and ($4::text is null
           or o.customer ilike '%%' || $4 || '%%'
           or o.case_name ilike '%%' || $4 || '%%'
           or ($5::text is not null and (o.order_no::text) like $5 || '%%'))
    order by %s %s nulls last, o.order_no desc
    limit $6 offset $7
  $q$, v_order, v_dir)
  using p_from, p_to, p_status, v_pattern, v_digits,
        greatest(1, least(coalesce(p_limit, 50), 1000)), greatest(0, coalesce(p_offset, 0));
end
$$;

-- I gang nu: orders not packed.
--   p_status  'late' (the deadline has passed), 'at_risk' (the forecast lands
--             after the deadline), 'on_time', 'unknown' (cannot be said), or
--             null for all. Same rule as orderDeliveryStatus() in the wrapper.
--   p_sort    order, customer, elements, start, elapsed, forecast, due,
--             last_scan. Anything else sorts by start.
--   p_active_since  only orders scanned at or after this instant; null: all.
create function rpt.orders_in_progress(
  p_now          timestamptz,
  p_search       text default null,
  p_status       text default null,
  p_sort         text default 'start',
  p_dir          text default 'desc',
  p_limit        integer default 50,
  p_offset       integer default 0,
  p_working      boolean default true,
  p_active_since timestamptz default null
)
returns table (
  order_no                   integer,
  customer                   text,
  case_name                  text,
  delivery_year              integer,
  delivery_week              integer,
  due_at                     timestamptz,
  elements_expected          integer,
  elements_seen              integer,
  elements_assembled         integer,
  elements_packed            integer,
  start_at                   timestamptz,
  last_scan_at               timestamptz,
  elapsed_seconds            integer,
  elapsed_working_seconds    integer,
  work_seconds               integer,
  work_working_seconds       integer,
  wait_seconds               integer,
  wait_working_seconds       integer,
  current_step               text,
  current_station_nos        integer[],
  forecast_ready_at          timestamptz,
  forecast_remaining_seconds integer,
  forecast_basis             text,
  at_risk                    boolean,
  rework_count               integer,
  missing_scan_out_count     integer,
  open_count                 integer,
  expected_source            text,
  computed_at                timestamptz,
  total_count                bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_pattern text := rpt.like_escape(p_search);
  v_digits  text := case when btrim(coalesce(p_search, '')) ~ '^[0-9]+$' then btrim(p_search) end;
  v_dir     text := case when lower(coalesce(p_dir, '')) = 'asc' then 'asc' else 'desc' end;
  v_order   text;
begin
  v_order := case p_sort
    when 'order' then 'o.order_no'
    when 'customer' then 'o.customer'
    when 'elements' then 'coalesce(o.elements_expected, o.elements_seen)'
    when 'elapsed' then case when p_working then 'o.elapsed_working_seconds' else 'o.elapsed_seconds' end
    when 'forecast' then 'o.forecast_ready_at'
    when 'due' then 'o.due_at'
    when 'last_scan' then 'o.last_scan_at'
    else 'o.start_at'
  end;

  return query execute format($q$
    select o.order_no, o.customer, o.case_name, o.delivery_year, o.delivery_week, o.due_at,
           o.elements_expected, o.elements_seen, o.elements_assembled, o.elements_packed,
           o.start_at, o.last_scan_at, o.elapsed_seconds, o.elapsed_working_seconds,
           o.work_seconds, o.work_working_seconds, o.wait_seconds, o.wait_working_seconds,
           o.current_step, o.current_station_nos, o.forecast_ready_at,
           o.forecast_remaining_seconds, o.forecast_basis, o.at_risk, o.rework_count,
           o.missing_scan_out_count, o.open_count, o.expected_source, o.computed_at,
           count(*) over ()
    from core.orders o
    where o.status = 'in_progress'
      and ($1::timestamptz is null or o.last_scan_at >= $1)
      and ($2::text is null
           or ($2 = 'late' and o.due_at <= $3)
           or ($2 = 'at_risk' and o.at_risk and o.due_at > $3)
           or ($2 = 'on_time' and o.at_risk = false and o.due_at > $3)
           or ($2 = 'unknown' and o.at_risk is null and (o.due_at is null or o.due_at > $3)))
      and ($4::text is null
           or o.customer ilike '%%' || $4 || '%%'
           or o.case_name ilike '%%' || $4 || '%%'
           or ($5::text is not null and (o.order_no::text) like $5 || '%%'))
    order by %s %s nulls last, o.order_no desc
    limit $6 offset $7
  $q$, v_order, v_dir)
  using p_active_since, p_status, p_now, v_pattern, v_digits,
        greatest(1, least(coalesce(p_limit, 50), 1000)), greatest(0, coalesce(p_offset, 0));
end
$$;

-- Find an order by number, customer or case name, in progress or packed.
-- Best match first: the exact order number, then numbers that start with the
-- query, then name matches, newest scan first within each.
create function rpt.find_orders(p_query text, p_limit integer default 10)
returns table (
  order_no          integer,
  customer          text,
  case_name         text,
  status            text,
  delivery_year     integer,
  delivery_week     integer,
  elements_expected integer,
  elements_seen     integer,
  elements_packed   integer,
  start_at          timestamptz,
  packed_at         timestamptz,
  last_scan_at      timestamptz,
  match             text      -- order_no, order_no_prefix, customer or case_name
)
language sql
stable
set search_path = ''
as $$
  with q as (
    select rpt.like_escape(p_query) as pattern,
           case when btrim(coalesce(p_query, '')) ~ '^[0-9]+$' then btrim(p_query) end as digits
  )
  select o.order_no, o.customer, o.case_name, o.status, o.delivery_year, o.delivery_week,
         o.elements_expected, o.elements_seen, o.elements_packed, o.start_at, o.packed_at,
         o.last_scan_at,
         case
           when q.digits is not null and o.order_no::text = q.digits then 'order_no'
           when q.digits is not null and (o.order_no::text) like q.digits || '%' then 'order_no_prefix'
           when o.customer ilike '%' || q.pattern || '%' then 'customer'
           else 'case_name'
         end
  from core.orders o, q
  where q.pattern is not null
    and (
      o.customer ilike '%' || q.pattern || '%'
      or o.case_name ilike '%' || q.pattern || '%'
      or (q.digits is not null and (o.order_no::text) like q.digits || '%')
    )
  order by
    case
      when q.digits is not null and o.order_no::text = q.digits then 0
      when q.digits is not null and (o.order_no::text) like q.digits || '%' then 1
      else 2
    end,
    o.last_scan_at desc,
    o.order_no desc
  limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

-- One order in full, as one object: the core.orders row, its seven steps,
-- its elements (with the element type name), its passes (with the station's
-- current name and the normal time for the element type there), and the
-- station list. Null when the order does not exist or the caller cannot see it.
-- Keys are the column names; the wrapper turns them into camelCase.
create function rpt.order_detail(p_order_no integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'order', to_jsonb(o),
    'steps', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.seq)
      from core.order_steps s
      where s.order_no = o.order_no
    ), '[]'::jsonb),
    'elements', coalesce((
      select jsonb_agg(
               to_jsonb(e) || jsonb_build_object('element_type_name', t.name)
               order by e.position, e.sub_position, e.piece, e.barcode)
      from core.elements e
      left join config.element_types t on t.id = e.element_type_id
      where e.order_no = o.order_no
    ), '[]'::jsonb),
    'intervals', coalesce((
      select jsonb_agg(
               to_jsonb(i) || jsonb_build_object(
                 'station_name', coalesce(c.name, i.station),
                 'normal_seconds', n.seconds)
               order by i.start_at, i.interval_id)
      from core.station_intervals i
      left join config.stations c on c.station_no = i.station_no
      left join config.normal_times n
        on n.station_no = i.station_no and n.element_type_id = i.element_type_id
      where i.order_no = o.order_no
    ), '[]'::jsonb)
  )
  from core.orders o
  where o.order_no = p_order_no;
$$;

-- The 3E documents of an order: what a portal user may see of
-- raw.order_documents (the file, its blob reference for the PDF viewer, and
-- what the parser read). Not the hash, the device or the OptiCloud row id.
--
-- SECURITY DEFINER, the only one in this schema, and why: raw.* is service
-- only (no grant, no policy), and a security invoker function or view cannot
-- read a table its caller has no grant on. The alternatives were a copy of
-- the documents in doc.* that the sync would have to keep in step (two
-- sources for one fact), or a grant on raw.order_documents (opens the whole
-- row). This function opens exactly these columns, to the four portal roles
-- of this account, by order number. search_path is pinned and it takes no
-- identifier from the caller.
create function rpt.order_documents(p_order_no integer)
returns table (
  file_name      text,
  order_no       integer,
  prefix         text,
  print_date     date,
  blob_reference text,
  blob_name      text,
  content_type   text,
  size_bytes     integer,
  synced_at      timestamptz,
  parsed_at      timestamptz,
  parser_version text,
  page_count     integer,
  header         jsonb,
  positions      jsonb,
  problems       jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.has_role('admin', 'ledelse', 'planner', 'viewer') then
    raise exception 'Order documents need a portal role'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select d.file_name, d.order_no, d.prefix, d.print_date, d.blob_reference, d.blob_name,
           d.content_type, d.size_bytes, d.synced_at, d.parsed_at, d.parser_version,
           case when jsonb_typeof(d.parsed -> 'pageCount') = 'number'
             then (d.parsed ->> 'pageCount')::integer
           end,
           d.parsed -> 'header',
           coalesce(d.parsed -> 'positions', '[]'::jsonb),
           coalesce(d.parsed -> 'problems', d.parse_problems, '[]'::jsonb)
    from raw.order_documents d
    where d.order_no = p_order_no
    order by d.print_date desc nulls last, d.file_name;
end
$$;

-- ---------------------------------------------------------------------------
-- Ledelse
-- ---------------------------------------------------------------------------

-- Kalkule mod målt: the calculated time (config.calculated_times, a cost
-- figure) against the measured median pass time, per station and element
-- type, for the passes that ended in [p_from, p_to]. One row per pair that
-- has a calculated time or a measurement. Roles admin, ledelse and planner.
create function rpt.calc_vs_measured(
  p_from date,
  p_to date,
  p_element_type_id text default null,
  p_station_no integer default null
)
returns table (
  station_no             integer,
  station_name           text,
  station_kind           text,
  element_type_id        text,
  element_type_name      text,
  calculated_seconds     integer,
  normal_seconds         integer,
  passes                 integer,
  rework_passes          integer,
  median_seconds         integer,
  median_working_seconds integer,
  mean_seconds           integer
)
language plpgsql
stable
set search_path = ''
as $$
begin
  perform rpt.require_role('admin', 'ledelse', 'planner');

  return query
    with m as (
      select i.station_no as m_station_no,
             i.element_type_id as m_type,
             count(*)::integer as m_passes,
             (count(*) filter (where i.is_rework))::integer as m_rework,
             round(percentile_cont(0.5) within group (order by i.duration_seconds)::numeric)::integer as m_median,
             round(percentile_cont(0.5) within group (order by i.duration_working_seconds)::numeric)::integer as m_median_working,
             round(avg(i.duration_seconds))::integer as m_mean,
             (array_agg(i.station order by i.start_at desc))[1] as m_station,
             (array_agg(i.station_kind order by i.start_at desc))[1] as m_kind
      from core.station_intervals i
      where i.status = 'done'
        and i.local_day between p_from and p_to
        and i.element_type_id is not null
      group by i.station_no, i.element_type_id
    ),
    keys as (
      select ct.station_no as k_station_no, ct.element_type_id as k_type from config.calculated_times ct
      union
      select m.m_station_no, m.m_type from m
    )
    select k.k_station_no,
           coalesce(c.name, m.m_station, 'Station nr. ' || k.k_station_no),
           coalesce(c.kind, m.m_kind),
           k.k_type,
           coalesce(t.name, k.k_type),
           ct.seconds,
           n.seconds,
           coalesce(m.m_passes, 0),
           coalesce(m.m_rework, 0),
           m.m_median,
           m.m_median_working,
           m.m_mean
    from keys k
    left join m on m.m_station_no = k.k_station_no and m.m_type = k.k_type
    left join config.calculated_times ct on ct.station_no = k.k_station_no and ct.element_type_id = k.k_type
    left join config.normal_times n on n.station_no = k.k_station_no and n.element_type_id = k.k_type
    left join config.stations c on c.station_no = k.k_station_no
    left join config.element_types t on t.id = k.k_type
    where (p_element_type_id is null or k.k_type = p_element_type_id)
      and (p_station_no is null or k.k_station_no = p_station_no)
    order by t.sort_order nulls last, k.k_type, c.sort_order nulls last, k.k_station_no;
end
$$;

-- Everything the monthly report shows, as one object of raw facts, for the
-- month that starts on p_month. The wrapper adds the labels and sentences and
-- that result is what a snapshot freezes. Roles admin and ledelse (and service
-- code, for the freeze).
create function rpt.month_report(p_month date, p_now timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from      date := date_trunc('month', p_month::timestamp)::date;
  v_to        date;
  v_prev_from date;
  v_prev_to   date;
begin
  perform rpt.require_role('admin', 'ledelse');

  v_to := (v_from + interval '1 month')::date - 1;
  v_prev_from := (v_from - interval '1 month')::date;
  v_prev_to := v_from - 1;

  return jsonb_build_object(
    'month', v_from,
    'from', v_from,
    'to', v_to,
    'previous_from', v_prev_from,
    'previous_to', v_prev_to,
    'generated_at', p_now,
    'settings', rpt.settings(),
    'kpis', (select to_jsonb(k) from rpt.period_kpis(v_from, v_to) k),
    'previous_kpis', (select to_jsonb(k) from rpt.period_kpis(v_prev_from, v_prev_to) k),
    'monthly', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.bucket_start)
      from rpt.lead_time_series((v_from - interval '11 months')::date, v_to, 'month') x
    ), '[]'::jsonb),
    'weekly', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.bucket_start)
      from rpt.lead_time_series(v_from, v_to, 'week') x
    ), '[]'::jsonb),
    'steps', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.seq)
      from rpt.step_times(v_from, v_to) x
    ), '[]'::jsonb),
    'stations', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.station_no)
      from rpt.station_performance(v_from, v_to, null, 'all') x
    ), '[]'::jsonb),
    'station_list', coalesce((select jsonb_agg(to_jsonb(x)) from rpt.stations() x), '[]'::jsonb),
    'calc_vs_measured', coalesce((
      select jsonb_agg(to_jsonb(x))
      from rpt.calc_vs_measured(v_from, v_to) x
    ), '[]'::jsonb),
    'notes', (select to_jsonb(n) from rpt.management_notes n where n.month = v_from),
    'missing_scan_outs', (
      select count(*)::integer
      from core.station_intervals i
      where i.status = 'missing_out' and i.local_day between v_from and v_to
    )
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Lists for Overblik and Indstillinger
-- ---------------------------------------------------------------------------

-- "Scannet ind, aldrig ud": the passes with status missing_out, newest first.
-- p_from and p_to bound the day the In was scanned; either may be null.
create function rpt.missing_scan_outs(
  p_from   date default null,
  p_to     date default null,
  p_limit  integer default 100,
  p_offset integer default 0
)
returns table (
  interval_id     text,
  order_no        integer,
  customer        text,
  barcode         text,
  "position"      integer,
  sub_position    integer,
  piece           integer,
  element_type_id text,
  station_no      integer,
  station_name    text,
  station_kind    text,
  start_at        timestamptz,
  local_day       date,
  missing_reason  text,
  order_status    text,
  total_count     bigint
)
language sql
stable
set search_path = ''
as $$
  select i.interval_id, i.order_no, o.customer, i.barcode, e.position, e.sub_position, e.piece,
         i.element_type_id, i.station_no, coalesce(c.name, i.station), i.station_kind,
         i.start_at, i.local_day, i.missing_reason, o.status,
         count(*) over ()
  from core.station_intervals i
  join core.orders o on o.order_no = i.order_no
  left join core.elements e on e.barcode = i.barcode
  left join config.stations c on c.station_no = i.station_no
  where i.status = 'missing_out'
    and (p_from is null or i.local_day >= p_from)
    and (p_to is null or i.local_day <= p_to)
  order by i.start_at desc, i.interval_id
  limit greatest(1, least(coalesce(p_limit, 100), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- "Pakket ordre med manglende element": orders where packing has begun, the
-- 3E list still has positions not fully packed, and nothing has been scanned
-- on the order for p_quiet_hours. (An order whose every expected element is
-- packed is by definition packed, so these orders stand as in progress.)
create function rpt.incomplete_packed_orders(
  p_now         timestamptz,
  p_quiet_hours integer default 12,
  p_limit       integer default 100,
  p_offset      integer default 0
)
returns table (
  order_no          integer,
  customer          text,
  case_name         text,
  status            text,
  delivery_year     integer,
  delivery_week     integer,
  elements_expected integer,
  elements_seen     integer,
  elements_packed   integer,
  missing_elements  jsonb,
  last_scan_at      timestamptz,
  total_count       bigint
)
language sql
stable
set search_path = ''
as $$
  select o.order_no, o.customer, o.case_name, o.status, o.delivery_year, o.delivery_week,
         o.elements_expected, o.elements_seen, o.elements_packed, o.missing_elements,
         o.last_scan_at, count(*) over ()
  from core.orders o
  where o.elements_packed > 0
    and case when jsonb_typeof(o.missing_elements) = 'array'
          then jsonb_array_length(o.missing_elements) else 0 end > 0
    and o.last_scan_at <= p_now - make_interval(hours => p_quiet_hours)
  order by o.last_scan_at desc, o.order_no desc
  limit greatest(1, least(coalesce(p_limit, 100), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- "Foreslå fra baseline": the median pass time per station and element type
-- for the passes that ended in [p_from, p_to], with the sample count and the
-- normal time in force. Passes with no element type come as one row per
-- station with element_type_id null (they cannot become a normal time).
create function rpt.baseline_suggestion(p_from date, p_to date, p_min_samples integer default 1)
returns table (
  station_no             integer,
  station_name           text,
  station_kind           text,
  element_type_id        text,
  element_type_name      text,
  samples                integer,
  median_seconds         integer,
  median_working_seconds integer,
  mean_seconds           integer,
  p25_seconds            integer,
  p75_seconds            integer,
  current_seconds        integer,
  current_source         text
)
language sql
stable
set search_path = ''
as $$
  select m.station_no,
         coalesce(c.name, m.station, 'Station nr. ' || m.station_no),
         coalesce(c.kind, m.station_kind),
         m.element_type_id,
         t.name,
         m.samples, m.median_seconds, m.median_working_seconds, m.mean_seconds,
         m.p25_seconds, m.p75_seconds,
         n.seconds, n.source
  from (
    select i.station_no, i.element_type_id,
           count(*)::integer as samples,
           round(percentile_cont(0.5) within group (order by i.duration_seconds)::numeric)::integer as median_seconds,
           round(percentile_cont(0.5) within group (order by i.duration_working_seconds)::numeric)::integer as median_working_seconds,
           round(avg(i.duration_seconds))::integer as mean_seconds,
           round(percentile_cont(0.25) within group (order by i.duration_seconds)::numeric)::integer as p25_seconds,
           round(percentile_cont(0.75) within group (order by i.duration_seconds)::numeric)::integer as p75_seconds,
           (array_agg(i.station order by i.start_at desc))[1] as station,
           (array_agg(i.station_kind order by i.start_at desc))[1] as station_kind
    from core.station_intervals i
    where i.status = 'done'
      and i.local_day between p_from and p_to
    group by i.station_no, i.element_type_id
    having count(*) >= greatest(1, coalesce(p_min_samples, 1))
  ) m
  left join config.stations c on c.station_no = m.station_no
  left join config.element_types t on t.id = m.element_type_id
  left join config.normal_times n on n.station_no = m.station_no and n.element_type_id = m.element_type_id
  order by c.sort_order nulls last, m.station_no, t.sort_order nulls last, m.element_type_id nulls last;
$$;

-- ---------------------------------------------------------------------------
-- For the chat: the two questions whose data does not exist yet
-- ---------------------------------------------------------------------------

-- Capacity for the week that starts on p_week_start (a Monday): the shift
-- time per day from the calendar, which is known, and the planned load, which
-- is not: planned orders come from 3E and are not delivered yet (plan §7), so
-- planned_load_seconds and planned_orders are null on every row.
create function rpt.capacity_plan(p_week_start date)
returns table (
  day                  date,
  weekday              integer,
  closed               boolean,
  closed_name          text,
  shift_seconds        integer,
  assembly_stations    integer,
  open_orders_due      integer,   -- in progress with this delivery week (same on every row)
  planned_orders       integer,
  planned_load_seconds integer
)
language sql
stable
set search_path = ''
as $$
  select d.day,
         extract(isodow from d.day)::integer,
         cd.day is not null,
         cd.name,
         case when cd.day is not null then 0 else coalesce((
           select sum(extract(epoch from (s.end_time - s.start_time)))::integer
           from config.calendar_shifts s
           where s.weekday = extract(isodow from d.day)
         ), 0) end,
         (select count(*) from config.stations c where c.active and c.kind = 'assembly')::integer,
         (select count(*) from core.orders o
           where o.status = 'in_progress'
             and o.delivery_year = extract(isoyear from p_week_start)
             and o.delivery_week = extract(week from p_week_start))::integer,
         null::integer,
         null::integer
  from (select p_week_start + i as day from generate_series(0, 6) as i) d
  left join config.calendar_closed_days cd on cd.day = d.day
  order by d.day;
$$;

-- Output per station per day for [p_from, p_to], with the number of people,
-- which is not recorded anywhere yet: people is null on every row.
create function rpt.staffing(p_from date, p_to date, p_station_no integer default null)
returns table (
  station_no                     integer,
  station_name                   text,
  station_kind                   text,
  local_day                      date,
  count_through                  integer,
  time_per_piece_seconds         integer,
  time_per_piece_working_seconds integer,
  busy_in_shift_seconds          integer,
  observed_seconds               integer,
  people                         integer
)
language sql
stable
set search_path = ''
as $$
  select f.station_no, coalesce(c.name, f.station), coalesce(c.kind, f.station_kind), f.local_day,
         f.count_through, f.time_per_piece_seconds, f.time_per_piece_working_seconds,
         f.busy_in_shift_seconds, f.observed_seconds, null::integer
  from core.station_day_facts f
  left join config.stations c on c.station_no = f.station_no
  where f.local_day between p_from and p_to
    and (p_station_no is null or f.station_no = p_station_no)
  order by f.local_day, c.sort_order nulls last, f.station_no;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated only
-- ---------------------------------------------------------------------------

do $grants$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'rpt'
  loop
    execute format('revoke all on function %s from public, anon', f.signature);
    execute format('grant execute on function %s to authenticated', f.signature);
  end loop;
end
$grants$;
