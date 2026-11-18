-- "Max i gang": how many elements may be in progress at a station at once
-- (docs/opticloud-scans.md, "Rules"; docs/read-model.md §2). 1 is the old
-- rule, one element at a time. The glazing station works several at once.
-- The station PC has the same setting; the two are set by hand to the same
-- number.

alter table config.stations
  add column max_open integer not null default 1 check (max_open between 1 and 20);

comment on column config.stations.max_open is
  'Max i gang: elements that may be in progress here at once. 1: one at a time.';

-- rpt.stations gains max_open. A new output column means a new function, so
-- the old one is dropped and its grant given again below.
drop function rpt.stations();

create function rpt.stations()
returns table (
  station_no   integer,
  name         text,
  kind         text,
  sort_order   integer,
  active       boolean,
  normal_times jsonb,     -- [{elementTypeId, seconds}]
  max_open     integer
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
         ), '[]'::jsonb),
         c.max_open
  from config.stations c
  order by c.sort_order, c.station_no;
$$;

revoke all on function rpt.stations() from public, anon;
grant execute on function rpt.stations() to authenticated;
