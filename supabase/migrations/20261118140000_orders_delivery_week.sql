-- Ordrer: filter both lists on the delivery week (leveringsuge), and list the
-- delivery weeks there are orders in, for the filter's choices.
-- New input parameters mean new functions, so the old ones are dropped and
-- their grants given again below.

drop function rpt.orders_finished(text, date, date, text, text, text, integer, integer, boolean);
drop function rpt.orders_in_progress(timestamptz, text, text, text, text, integer, integer, boolean, timestamptz);

-- Afsluttede: packed orders, newest first unless p_sort says otherwise.
--   p_search  matches the start of the order number, or any part of the
--             customer or the case name (case insensitive).
--   p_from, p_to  packed_local_day range, either may be null.
--   p_status  'on_time', 'late', 'unknown' (no delivery week) or null for all.
--   p_sort    order, customer, elements, start, packed, lead, wait, status.
--             Anything else sorts by packed. The column is chosen from this
--             fixed list, never taken from the input.
--   p_working sort lead and wait on the working-time column.
--   p_delivery_year, p_delivery_week  only orders due in that ISO week; null: all.
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
  p_working boolean default true,
  p_delivery_year integer default null,
  p_delivery_week integer default null
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
      and ($8::integer is null or o.delivery_year = $8)
      and ($9::integer is null or o.delivery_week = $9)
    order by %s %s nulls last, o.order_no desc
    limit $6 offset $7
  $q$, v_order, v_dir)
  using p_from, p_to, p_status, v_pattern, v_digits,
        greatest(1, least(coalesce(p_limit, 50), 1000)), greatest(0, coalesce(p_offset, 0)),
        p_delivery_year, p_delivery_week;
end
$$;

-- I gang nu: orders not packed.
--   p_status  'late' (the deadline has passed), 'at_risk' (the forecast lands
--             after the deadline), 'on_time', 'unknown' (cannot be said), or
--             null for all. Same rule as orderDeliveryStatus() in the wrapper.
--   p_sort    order, customer, elements, start, elapsed, forecast, due,
--             last_scan. Anything else sorts by start.

create function rpt.orders_in_progress(
  p_now          timestamptz,
  p_search       text default null,
  p_status       text default null,
  p_sort         text default 'start',
  p_dir          text default 'desc',
  p_limit        integer default 50,
  p_offset       integer default 0,
  p_working      boolean default true,
  p_active_since timestamptz default null,
  p_delivery_year integer default null,
  p_delivery_week integer default null
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
      and ($8::integer is null or o.delivery_year = $8)
      and ($9::integer is null or o.delivery_week = $9)
    order by %s %s nulls last, o.order_no desc
    limit $6 offset $7
  $q$, v_order, v_dir)
  using p_active_since, p_status, p_now, v_pattern, v_digits,
        greatest(1, least(coalesce(p_limit, 50), 1000)), greatest(0, coalesce(p_offset, 0)),
        p_delivery_year, p_delivery_week;
end
$$;

-- Find an order by number, customer or case name, in progress or packed.

-- The delivery weeks there are orders in, newest first, with how many.
--   p_status  'packed' or 'in_progress'.
create function rpt.order_delivery_weeks(p_status text)
returns table (
  delivery_year integer,
  delivery_week integer,
  order_count   bigint
)
language sql
stable
set search_path = ''
as $$
  select o.delivery_year, o.delivery_week, count(*)
  from core.orders o
  where o.status = p_status
    and o.delivery_year is not null
    and o.delivery_week is not null
  group by o.delivery_year, o.delivery_week
  order by o.delivery_year desc, o.delivery_week desc;
$$;

revoke all on function rpt.orders_finished(text, date, date, text, text, text, integer, integer, boolean, integer, integer) from public, anon;
grant execute on function rpt.orders_finished(text, date, date, text, text, text, integer, integer, boolean, integer, integer) to authenticated;
revoke all on function rpt.orders_in_progress(timestamptz, text, text, text, text, integer, integer, boolean, timestamptz, integer, integer) from public, anon;
grant execute on function rpt.orders_in_progress(timestamptz, text, text, text, text, integer, integer, boolean, timestamptz, integer, integer) to authenticated;
revoke all on function rpt.order_delivery_weeks(text) from public, anon;
grant execute on function rpt.order_delivery_weeks(text) to authenticated;
