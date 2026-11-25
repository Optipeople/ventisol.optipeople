-- Stop at shift end (docs/plan-shift-end.md §7), with the part of the raw
-- scan change it shares with the command cards (docs/plan-scan-commands.md
-- §8.1): the Event column, and Mark rows kept.
--
-- raw.scans: the Event column of VentisolScans (null: an ordinary scan), and
-- Mark as a direction. A Mark carries no time and never pairs.
--
-- core.station_intervals.end_event: how a pass ended, the Event of the row
-- that closed it in snake case. shift_end: the station stopped it at shift
-- end (auto-stop). Null on a scan-out, an open pass and a missing scan-out,
-- and on rows written before this migration (they read as a scan-out until
-- the next rebuild of their order).
--
-- core.station_day_facts.auto_stopped_count: finished passes that ended that
-- day by an auto-stop. They count in every time and count like any pass.
--
-- rpt.missing_scan_outs lists the auto-stopped passes too, as forgotten
-- scan-outs that were caught (kind 'auto_stopped', with end_at).
-- rpt.station_day gives auto_stopped_count, rpt.station_timeline end_event.
-- New output columns mean new functions: dropped, made again, granted again.

alter table raw.scans drop constraint scans_direction_check;
alter table raw.scans add constraint scans_direction_check check (direction in ('In', 'Out', 'Mark'));
alter table raw.scans add column event text;
comment on column raw.scans.event is
  'The Event column (Scan, Pause, Resume, Hold, CheckedOut, Undo, ShiftEnd). Null: an ordinary scan.';

alter table core.station_intervals
  add column end_event text
    check (end_event in ('pause', 'resume', 'hold', 'checked_out', 'undo', 'shift_end'));
comment on column core.station_intervals.end_event is
  'How the pass ended: the Event of the row that closed it. shift_end: stopped by the station at shift end. Null: scanned out (or not ended).';

-- The auto-stops per station and day, and for the list.
create index station_intervals_shift_end_idx on core.station_intervals (local_day)
  where end_event = 'shift_end';

alter table core.station_day_facts
  add column auto_stopped_count integer not null default 0;
comment on column core.station_day_facts.auto_stopped_count is
  'Finished passes that ended this day stopped by the station at shift end.';

-- ---------------------------------------------------------------------------
-- rpt.missing_scan_outs: missing scan-outs and auto-stops in one list
-- ---------------------------------------------------------------------------

drop function rpt.missing_scan_outs(date, date, integer, integer);

-- "Scannet ind, aldrig ud", newest first: the passes with status missing_out
-- (kind 'missing'), and the passes the station stopped at shift end (kind
-- 'auto_stopped', end_at the stop). p_from and p_to bound local_day: the day
-- the In was scanned for a missing scan-out, the day of the stop for an
-- auto-stop. Either may be null.
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
  end_at          timestamptz,
  local_day       date,
  kind            text,
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
         i.start_at, i.end_at, i.local_day,
         case when i.status = 'missing_out' then 'missing' else 'auto_stopped' end,
         i.missing_reason, o.status,
         count(*) over ()
  from core.station_intervals i
  join core.orders o on o.order_no = i.order_no
  left join core.elements e on e.barcode = i.barcode
  left join config.stations c on c.station_no = i.station_no
  where (i.status = 'missing_out' or (i.status = 'done' and i.end_event = 'shift_end'))
    and (p_from is null or i.local_day >= p_from)
    and (p_to is null or i.local_day <= p_to)
  order by i.start_at desc, i.interval_id
  limit greatest(1, least(coalesce(p_limit, 100), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function rpt.missing_scan_outs(date, date, integer, integer) from public, anon;
grant execute on function rpt.missing_scan_outs(date, date, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- rpt.station_day: as before, plus auto_stopped_count
-- ---------------------------------------------------------------------------

drop function rpt.station_day(date);

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
  normal_times                        jsonb,
  auto_stopped_count                  integer
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
    ), '[]'::jsonb),
    f.auto_stopped_count
  from keys k
  left join config.stations c on c.station_no = k.station_no
  left join core.station_day_facts f on f.station_no = k.station_no and f.local_day = p_day
  order by 4, 1;
$$;

revoke all on function rpt.station_day(date) from public, anon;
grant execute on function rpt.station_day(date) to authenticated;

-- ---------------------------------------------------------------------------
-- rpt.station_timeline: as before, plus end_event
-- ---------------------------------------------------------------------------

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
  allocated_working_seconds   integer,
  end_event                   text       -- shift_end: stopped at shift end
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
         case when i.status <> 'missing_out' then coalesce(i.allocated_working_seconds, i.duration_working_seconds) end,
         i.end_event
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
