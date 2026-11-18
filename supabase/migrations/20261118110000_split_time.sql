-- Split time: each pass's share of its station's time when several elements
-- are on the station at once (docs/read-model.md §2, "Split time: parallel
-- work"). The station-day rebuild fills the two columns; a row it has not
-- reached yet has them null, and every figure below then falls back to the
-- wall-clock time (coalesce), so rows from before this migration still count.
--
-- Which figures move to split time: time per piece (median, mean, by element
-- type, the spread per type), a station's pass-time total, Kalkule mod målt
-- and the Normaltid suggestion. Order touch time (core.orders,
-- core.elements, core.order_steps) is kept in split time by the writer.
-- Busy time, utilisation, gaps, lead time, order work time and waiting time
-- stay wall clock.

alter table core.station_intervals
  add column allocated_seconds integer,
  add column allocated_working_seconds integer;

comment on column core.station_intervals.allocated_seconds is
  'Split time: the share of the station''s time (several elements at once share it). Up to now while open, null on missing_out.';
comment on column core.station_intervals.allocated_working_seconds is
  'Split time in shift time.';

-- How the share is weighed. 'calculated': by the calculated time of the
-- pass's element type at the station (equally where one has none).
-- 'equal': equally. A change needs a rebuild of the split columns.
insert into config.settings (key, value) values ('parallel_split', '"calculated"')
on conflict (key) do nothing;

-- rpt.settings: parallel_split too.
create or replace function rpt.settings()
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
      (select value #>> '{}' from config.settings where key = 'schirmer_assumed_minutes_per_batch') as schirmer,
      (select value #>> '{}' from config.settings where key = 'parallel_split') as split
  )
  select jsonb_build_object(
    'use_working_time', coalesce(s.deduct::boolean, true),
    'slow_threshold_percent', coalesce(s.slow::numeric, 20),
    'standstill_threshold_minutes', coalesce(s.standstill::numeric, 15),
    'long_dwell_threshold_minutes', coalesce(s.dwell::numeric, 480),
    'calculation_deviation_threshold_percent', coalesce(s.calc::numeric, 15),
    'late_threshold_days', coalesce(s.late::numeric, 0),
    'buffer_capacity', s.buffer::numeric,
    'schirmer_assumed_minutes_per_batch', s.schirmer::numeric,
    'parallel_split', case when s.split = 'equal' then 'equal' else 'calculated' end
  )
  from s;
$$;

-- Station figures for a period: as before, with time per piece, the mean,
-- the pass-time total and the per-type figures in split time.
create or replace function rpt.station_performance(
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
           coalesce(i.allocated_seconds, i.duration_seconds) as duration_seconds,
           coalesce(i.allocated_working_seconds, i.duration_working_seconds) as duration_working_seconds,
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

-- The day timeline of one station: as before, plus each pass's split time
-- beside its wall-clock time. A new output column means a new function.
drop function rpt.station_timeline(integer, timestamptz, timestamptz);

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
  duration_seconds            integer,   -- wall clock
  duration_working_seconds    integer,
  wait_before_seconds         integer,
  wait_before_working_seconds integer,
  allocated_seconds           integer,   -- split time; null on missing_out
  allocated_working_seconds   integer
)
language sql
stable
set search_path = ''
as $$
  select i.interval_id, i.order_no, i.barcode, e.position, e.sub_position, e.piece,
         i.element_type_id, t.name, i.status, i.missing_reason, i.visit, i.is_rework,
         i.start_at, i.end_at, i.start_estimated, i.duration_seconds, i.duration_working_seconds,
         i.wait_before_seconds, i.wait_before_working_seconds,
         case when i.status <> 'missing_out' then coalesce(i.allocated_seconds, i.duration_seconds) end,
         case when i.status <> 'missing_out' then coalesce(i.allocated_working_seconds, i.duration_working_seconds) end
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

revoke all on function rpt.station_timeline(integer, timestamptz, timestamptz) from public, anon;
grant execute on function rpt.station_timeline(integer, timestamptz, timestamptz) to authenticated;

-- The spread of a station's pass times per element type, in split time.
create or replace function rpt.station_type_distribution(p_station_no integer, p_from date, p_to date)
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
           min(i.split_seconds) as min_seconds,
           round(percentile_cont(0.25) within group (order by i.split_seconds)::numeric)::integer as p25_seconds,
           round(percentile_cont(0.5) within group (order by i.split_seconds)::numeric)::integer as median_seconds,
           round(percentile_cont(0.75) within group (order by i.split_seconds)::numeric)::integer as p75_seconds,
           max(i.split_seconds) as max_seconds,
           round(avg(i.split_seconds))::integer as mean_seconds,
           round(percentile_cont(0.5) within group (order by i.split_working_seconds)::numeric)::integer as median_working_seconds
    from (
      select s.element_type_id,
             coalesce(s.allocated_seconds, s.duration_seconds) as split_seconds,
             coalesce(s.allocated_working_seconds, s.duration_working_seconds) as split_working_seconds
      from core.station_intervals s
      where s.station_no = p_station_no
        and s.status = 'done'
        and s.local_day between p_from and p_to
    ) i
    group by i.element_type_id
  ) m
  left join config.element_types t on t.id = m.element_type_id
  left join config.normal_times n on n.station_no = p_station_no and n.element_type_id = m.element_type_id
  order by t.sort_order nulls last, m.element_type_id nulls last;
$$;

-- Kalkule mod målt, in split time: the median and mean of the passes' shares.
create or replace function rpt.calc_vs_measured(
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
             round(percentile_cont(0.5) within group (
               order by coalesce(i.allocated_seconds, i.duration_seconds))::numeric)::integer as m_median,
             round(percentile_cont(0.5) within group (
               order by coalesce(i.allocated_working_seconds, i.duration_working_seconds))::numeric)::integer as m_median_working,
             round(avg(coalesce(i.allocated_seconds, i.duration_seconds)))::integer as m_mean,
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

-- "Foreslå fra baseline", in split time: a normal time is the time a piece
-- takes of the station, so at a station working several at once it is the
-- share, not the wall clock.
create or replace function rpt.baseline_suggestion(p_from date, p_to date, p_min_samples integer default 1)
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
           round(percentile_cont(0.5) within group (order by i.split_seconds)::numeric)::integer as median_seconds,
           round(percentile_cont(0.5) within group (order by i.split_working_seconds)::numeric)::integer as median_working_seconds,
           round(avg(i.split_seconds))::integer as mean_seconds,
           round(percentile_cont(0.25) within group (order by i.split_seconds)::numeric)::integer as p25_seconds,
           round(percentile_cont(0.75) within group (order by i.split_seconds)::numeric)::integer as p75_seconds,
           (array_agg(i.station order by i.start_at desc))[1] as station,
           (array_agg(i.station_kind order by i.start_at desc))[1] as station_kind
    from (
      select s.station_no, s.element_type_id, s.station, s.station_kind, s.start_at,
             coalesce(s.allocated_seconds, s.duration_seconds) as split_seconds,
             coalesce(s.allocated_working_seconds, s.duration_working_seconds) as split_working_seconds
      from core.station_intervals s
      where s.status = 'done'
        and s.local_day between p_from and p_to
    ) i
    group by i.station_no, i.element_type_id
    having count(*) >= greatest(1, coalesce(p_min_samples, 1))
  ) m
  left join config.stations c on c.station_no = m.station_no
  left join config.element_types t on t.id = m.element_type_id
  left join config.normal_times n on n.station_no = m.station_no and n.element_type_id = m.element_type_id
  order by c.sort_order nulls last, m.station_no, t.sort_order nulls last, m.element_type_id nulls last;
$$;
