-- Ordrer, "Alle ordrer": every order the portal knows, the ones with a 3E
-- production list (raw.order_documents) and the ones with scans (core.orders),
-- including orders that have a list and no scan yet ('not_started').
--
-- raw.* has no grant, so the two public functions are security definer and
-- check the portal role themselves, as rpt.week_plan_documents does. The base
-- function rpt.all_orders_base is granted to no one: only they call it.
--
-- An order without scans takes its customer, delivery week and element count
-- from its newest list. The list prints a delivery week and no year: the year
-- is the one whose week starts between 2 weeks before and 30 weeks after the
-- list's print date (else when it was synced), the window
-- rpt.week_plan_documents uses. Outside it the delivery week is left unknown.
-- A scanned order without a delivery week takes the list's, as Ugeplan does.

create function rpt.all_orders_base()
returns table (
  order_no          integer,
  customer          text,
  case_name         text,
  delivery_year     integer,
  delivery_week     integer,
  due_at            timestamptz,
  elements          integer,
  elements_packed   integer,
  status            text,
  first_scan_at     timestamptz,
  last_scan_at      timestamptz,
  packed_at         timestamptz,
  on_time           boolean,
  at_risk           boolean,
  has_document      boolean,
  document_date     date
)
language sql
stable
security definer
set search_path = ''
as $$
  -- The newest list per order, preferring one that is parsed. Only the keys
  -- here, so each parsed blob is read once, below, for the chosen file.
  with newest as (
    select distinct on (d.order_no) d.order_no, d.file_name
      from raw.order_documents d
     where d.order_no is not null
     order by d.order_no, (jsonb_typeof(d.parsed) = 'object') desc nulls last,
              d.print_date desc nulls last, d.synced_at desc, d.file_name desc
  ),
  docs as (
    select d.order_no,
           coalesce(d.print_date, d.synced_at::date) as ref_date,
           case
             when jsonb_typeof(d.parsed -> 'header' -> 'customer') = 'array' then (
               select btrim(l.value #>> '{}')
                 from jsonb_array_elements(d.parsed -> 'header' -> 'customer') with ordinality as l
                where jsonb_typeof(l.value) = 'string' and btrim(l.value #>> '{}') <> ''
                order by l.ordinality
                limit 1)
             when jsonb_typeof(d.parsed -> 'header' -> 'customer') = 'string'
               then nullif(btrim(d.parsed -> 'header' ->> 'customer'), '')
           end as customer,
           case when (d.parsed -> 'header' ->> 'deliveryWeek') ~ '^\s*\d{1,2}\s*$'
                 and btrim(d.parsed -> 'header' ->> 'deliveryWeek')::integer between 1 and 53
                then btrim(d.parsed -> 'header' ->> 'deliveryWeek')::integer end as week,
           -- As readmodel/orderinfo.ts: one line per (number, subNumber), the
           -- first one printed; no quantity counts as 1.
           (select sum(q.quantity)::integer
              from (select distinct on (p.value ->> 'number', coalesce(p.value ->> 'subNumber', ''))
                           case when jsonb_typeof(p.value -> 'quantity') = 'number' and (p.value ->> 'quantity')::numeric > 0
                                then greatest(1, round((p.value ->> 'quantity')::numeric))::integer else 1 end as quantity
                      from jsonb_array_elements(
                             case when jsonb_typeof(d.parsed -> 'positions') = 'array'
                                  then d.parsed -> 'positions' else '[]'::jsonb end
                           ) with ordinality as p
                     where jsonb_typeof(p.value -> 'number') = 'number'
                     order by p.value ->> 'number', coalesce(p.value ->> 'subNumber', ''), p.ordinality) q) as elements
      from newest n
      join raw.order_documents d on d.file_name = n.file_name
  ),
  -- The year whose week starts between 2 weeks before and 30 weeks after the
  -- list's date, as in rpt.week_plan_documents. None: the year stays unknown.
  -- A week 53 the year does not have is no week.
  dated as (
    select d.*,
           (select c.y
              from (select y, to_date(y::text || '-' || lpad(d.week::text, 2, '0'), 'IYYY-IW') as monday
                      from generate_series(extract(isoyear from d.ref_date)::integer - 1,
                                           extract(isoyear from d.ref_date)::integer + 1) as y) c
             where extract(isoyear from c.monday)::integer = c.y
               and c.monday between d.ref_date - 14 and d.ref_date + 210
             order by c.monday
             limit 1) as year
      from docs d
  )
  select coalesce(o.order_no, d.order_no),
         coalesce(o.customer, d.customer),
         o.case_name,
         case when o.delivery_week is not null then o.delivery_year when d.year is not null then d.year end,
         case when o.delivery_week is not null then o.delivery_week when d.year is not null then d.week end,
         o.due_at,
         coalesce(o.elements_expected, o.elements_seen, d.elements),
         o.elements_packed,
         coalesce(o.status, 'not_started'),
         o.first_scan_at,
         o.last_scan_at,
         o.packed_at,
         o.on_time,
         o.at_risk,
         d.order_no is not null,
         d.ref_date
    from core.orders o
    full join dated d on d.order_no = o.order_no;
$$;

revoke all on function rpt.all_orders_base() from public, anon, authenticated;

-- Alle ordrer, with search, status, delivery week, sort and paging.
--   p_search  start of the order number, or part of the customer or case name.
--   p_status  'not_started', 'in_progress', 'packed', or null for all.
--   p_sort    order, customer, elements, delivery, status, first_scan, last_scan.
--             Anything else sorts by order. Chosen from this fixed list.
--   p_delivery_year, p_delivery_week  only orders due in that ISO week; null: all.
-- total_count is the number of matches before paging, on every row.
create function rpt.orders_all(
  p_search        text default null,
  p_status        text default null,
  p_sort          text default 'order',
  p_dir           text default 'desc',
  p_limit         integer default 50,
  p_offset        integer default 0,
  p_delivery_year integer default null,
  p_delivery_week integer default null
)
returns table (
  order_no        integer,
  customer        text,
  case_name       text,
  delivery_year   integer,
  delivery_week   integer,
  due_at          timestamptz,
  elements        integer,
  elements_packed integer,
  status          text,
  first_scan_at   timestamptz,
  last_scan_at    timestamptz,
  packed_at       timestamptz,
  on_time         boolean,
  at_risk         boolean,
  has_document    boolean,
  document_date   date,
  total_count     bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pattern text := rpt.like_escape(p_search);
  v_digits  text := case when btrim(coalesce(p_search, '')) ~ '^[0-9]+$' then btrim(p_search) end;
  v_dir     text := case when lower(coalesce(p_dir, '')) = 'asc' then 'asc' else 'desc' end;
  v_order   text;
begin
  if not app.has_role('admin', 'ledelse', 'planner', 'viewer') then
    raise exception 'The order list needs a portal role'
      using errcode = 'insufficient_privilege';
  end if;

  v_order := case p_sort
    when 'customer' then 'a.customer'
    when 'elements' then 'a.elements'
    when 'delivery' then 'a.delivery_year %1$s nulls last, a.delivery_week'
    when 'status' then $s$case a.status when 'not_started' then 0 when 'in_progress' then 1 else 2 end$s$
    when 'first_scan' then 'a.first_scan_at'
    when 'last_scan' then 'a.last_scan_at'
    else 'a.order_no'
  end;

  return query execute format($q$
    select a.*, count(*) over ()
    from rpt.all_orders_base() a
    where ($1::text is null or a.status = $1)
      and ($2::text is null
           or a.customer ilike '%%' || $2 || '%%'
           or a.case_name ilike '%%' || $2 || '%%'
           or ($3::text is not null and (a.order_no::text) like $3 || '%%'))
      and ($6::integer is null or a.delivery_year = $6)
      and ($7::integer is null or a.delivery_week = $7)
    order by %s %s nulls last, a.order_no desc
    limit $4 offset $5
  $q$, format(v_order, v_dir), v_dir)
  using p_status, v_pattern, v_digits,
        greatest(1, least(coalesce(p_limit, 50), 1000)), greatest(0, coalesce(p_offset, 0)),
        p_delivery_year, p_delivery_week;
end
$$;

-- The delivery weeks of Alle ordrer, newest first, with how many.
create function rpt.all_order_delivery_weeks()
returns table (
  delivery_year integer,
  delivery_week integer,
  order_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.has_role('admin', 'ledelse', 'planner', 'viewer') then
    raise exception 'The order list needs a portal role'
      using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.delivery_year, a.delivery_week, count(*)
      from rpt.all_orders_base() a
     where a.delivery_year is not null and a.delivery_week is not null
     group by a.delivery_year, a.delivery_week
     order by a.delivery_year desc, a.delivery_week desc;
end
$$;

revoke all on function rpt.orders_all(text, text, text, text, integer, integer, integer, integer) from public, anon;
grant execute on function rpt.orders_all(text, text, text, text, integer, integer, integer, integer) to authenticated;
revoke all on function rpt.all_order_delivery_weeks() from public, anon;
grant execute on function rpt.all_order_delivery_weeks() to authenticated;
