-- An order's positions come from two files when it has arched or bevelled
-- elements ("bue/skrå", BS): the production list holds the ordinary positions
-- and the BS list holds the BS ones alone (order 58931: the list has
-- positions 1 and 3, "58931_20261127BS.pdf" has position 2). Until now
-- rpt.week_plan_documents and rpt.all_orders_base read ONE file per order, so
-- the BS positions were missing from Ugeplan and from Alle ordrer, and an
-- order with BS files only could come out as its drawings, with no positions.
--
-- rpt.order_positions() gives each order's positions once, for both:
--
--   the newest list's positions
--   plus the positions of the newest BS list that the list does not have.
--
-- The rules (the same as apps/web/lib/orderdoc/order-lists.ts, which the read
-- model and the order page use):
--
--   - The kind of a file is read from its prefix: the sync stores "BS" and
--     "BS tegninger" there, after any prefix of the order ("BE_BS").
--   - The list always wins: a position in both files is the list's. Positions
--     are the same when their number and sub-number are.
--   - The newest list: newest print_date, then synced_at, then the file name,
--     as before.
--   - The newest BS list: the date in its file name (the first "_" followed
--     by exactly eight digits that make a date), else the "Dato" in its
--     header; a BS list with neither comes last. Then synced_at, then the
--     file name. BS files are stored without a print_date on purpose.
--   - An order with a BS list and no list: the BS list is its list.
--   - BS drawings never give positions or a header.
--   - Only parsed files count.
--
-- The signatures and columns of rpt.week_plan_documents and
-- rpt.all_orders_base are unchanged: the web code runs against the old and
-- the new functions alike.

-- 0: the list, 1: a BS list, 2: BS drawings.
create function rpt.document_kind(p_prefix text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
           when btrim(coalesce(p_prefix, '')) ~* '(^|_)BS tegninger$' then 2
           when btrim(coalesce(p_prefix, '')) ~* '(^|_)BS$' then 1
           else 0
         end;
$$;

-- The date a BS list is ranked by: the one in its file name, else the one in
-- its header ("2026-11-27"). Null when neither is a date; never an error.
create function rpt.bs_list_date(p_file_name text, p_header_date text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := substring(p_file_name from '_([0-9]{8})([^0-9]|$)');
  v_head text := btrim(p_header_date);
begin
  if v_name is not null then
    begin
      return to_date(v_name, 'YYYYMMDD');
    exception when others then
      null;
    end;
  end if;
  if v_head ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
      return to_date(v_head, 'YYYY-MM-DD');
    exception when others then
      null;
    end;
  end if;
  return null;
end
$$;

-- The list's positions, then the BS positions the list does not have.
-- Anything that is no array counts as no positions.
create function rpt.merged_positions(p_list jsonb, p_bs jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with l as (
    select e.value, e.ordinality
      from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end)
           with ordinality as e
  ),
  b as (
    select e.value, e.ordinality
      from jsonb_array_elements(case when jsonb_typeof(p_bs) = 'array' then p_bs else '[]'::jsonb end)
           with ordinality as e
     where jsonb_typeof(e.value) = 'object'
       and not exists (
             select 1 from l
              where jsonb_typeof(l.value) = 'object'
                and coalesce(l.value ->> 'number', '') = coalesce(e.value ->> 'number', '')
                and coalesce(l.value ->> 'subNumber', '') = coalesce(e.value ->> 'subNumber', ''))
  )
  select coalesce(jsonb_agg(x.value order by x.source, x.ordinality), '[]'::jsonb)
    from (select 0 as source, l.value, l.ordinality from l
          union all
          select 1, b.value, b.ordinality from b) x;
$$;

-- One row per order with a parsed list or BS list.
--   print_date  the list's; null for an order with a BS list only.
--   ref_date    when the order's list was printed, for placing its delivery
--               week in a year: the list's print date, else when it was
--               synced; for a BS list alone its date, else when it was synced.
--   header      the list's; the BS list's when there is no list.
create function rpt.order_positions()
returns table (
  order_no   integer,
  print_date date,
  ref_date   date,
  header     jsonb,
  positions  jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with docs as (
    select d.order_no, d.file_name, d.print_date, d.synced_at, d.parsed,
           rpt.document_kind(d.prefix) as kind
      from raw.order_documents d
     where d.order_no is not null and jsonb_typeof(d.parsed) = 'object'
  ),
  list as (
    select distinct on (d.order_no) d.order_no, d.print_date, d.synced_at, d.parsed
      from docs d
     where d.kind = 0
     order by d.order_no, d.print_date desc nulls last, d.synced_at desc, d.file_name desc
  ),
  bs as (
    select distinct on (b.order_no) b.order_no, b.bs_date, b.synced_at, b.parsed
      from (select d.*, rpt.bs_list_date(d.file_name, d.parsed -> 'header' ->> 'date') as bs_date
              from docs d
             where d.kind = 1) b
     order by b.order_no, b.bs_date desc nulls last, b.synced_at desc, b.file_name desc
  )
  select coalesce(l.order_no, b.order_no),
         l.print_date,
         case when l.order_no is not null then coalesce(l.print_date, l.synced_at::date)
              else coalesce(b.bs_date, b.synced_at::date) end,
         coalesce(l.parsed, b.parsed) -> 'header',
         rpt.merged_positions(l.parsed -> 'positions', b.parsed -> 'positions')
    from list l
    full join bs b on b.order_no = l.order_no;
$$;

revoke all on function rpt.document_kind(text) from public, anon, authenticated;
revoke all on function rpt.bs_list_date(text, text) from public, anon, authenticated;
revoke all on function rpt.merged_positions(jsonb, jsonb) from public, anon, authenticated;
revoke all on function rpt.order_positions() from public, anon, authenticated;

-- Ugeplan: as 20261118130000, with the positions of rpt.order_positions().
create or replace function rpt.week_plan_documents(p_year integer, p_week integer)
returns table (
  order_no   integer,
  print_date date,
  header     jsonb,
  positions  jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  monday date;
begin
  if not app.has_role('admin', 'ledelse', 'planner', 'viewer') then
    raise exception 'The week plan needs a portal role'
      using errcode = 'insufficient_privilege';
  end if;
  if p_year is null or p_week is null or p_week < 1 or p_week > 53 or p_year < 2000 or p_year > 2100 then
    raise exception 'Unknown week'
      using errcode = 'invalid_parameter_value';
  end if;
  monday := to_date(p_year::text || '-' || lpad(p_week::text, 2, '0'), 'IYYY-IW');

  return query
    select n.order_no,
           n.print_date,
           n.header,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'number', p.value -> 'number',
                      'subNumber', p.value -> 'subNumber',
                      'quantity', p.value -> 'quantity',
                      'system', p.value -> 'system',
                      'frameColour', p.value -> 'frameColour',
                      'sashColour', p.value -> 'sashColour',
                      'notes', p.value -> 'notes',
                      'fields', (select coalesce(jsonb_agg(jsonb_build_object(
                                          'opening', f.value -> 'opening',
                                          'frameSize', f.value -> 'frameSize'
                                        ) order by f.ordinality), '[]'::jsonb)
                                   from jsonb_array_elements(
                                          case when jsonb_typeof(p.value -> 'fields') = 'array'
                                               then p.value -> 'fields' else '[]'::jsonb end
                                        ) with ordinality as f)
                    ) order by p.ordinality)
               from jsonb_array_elements(n.positions) with ordinality as p
           ), '[]'::jsonb)
      from rpt.order_positions() n
      left join core.orders o on o.order_no = n.order_no and o.delivery_week is not null
     where case
             when o.order_no is not null then o.delivery_year = p_year and o.delivery_week = p_week
             else (n.header ->> 'deliveryWeek') = p_week::text
                  and n.ref_date between monday - 210 and monday + 14
           end
     order by n.order_no;
end
$$;

-- Alle ordrer: as 20261118150000, with the customer, the delivery week and
-- the element count of rpt.order_positions(). An order whose files are not
-- parsed yet still has a document and a date.
create or replace function rpt.all_orders_base()
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
  -- Every order with a file, and the date of its first file by kind (the
  -- list before its BS files), then newest: for an order with nothing parsed.
  with newest as (
    select distinct on (d.order_no) d.order_no, coalesce(d.print_date, d.synced_at::date) as ref_date
      from raw.order_documents d
     where d.order_no is not null
     order by d.order_no, rpt.document_kind(d.prefix),
              d.print_date desc nulls last, d.synced_at desc, d.file_name desc
  ),
  docs as (
    select n.order_no,
           coalesce(p.ref_date, n.ref_date) as ref_date,
           case
             when jsonb_typeof(p.header -> 'customer') = 'array' then (
               select btrim(l.value #>> '{}')
                 from jsonb_array_elements(p.header -> 'customer') with ordinality as l
                where jsonb_typeof(l.value) = 'string' and btrim(l.value #>> '{}') <> ''
                order by l.ordinality
                limit 1)
             when jsonb_typeof(p.header -> 'customer') = 'string'
               then nullif(btrim(p.header ->> 'customer'), '')
           end as customer,
           case when (p.header ->> 'deliveryWeek') ~ '^\s*\d{1,2}\s*$'
                 and btrim(p.header ->> 'deliveryWeek')::integer between 1 and 53
                then btrim(p.header ->> 'deliveryWeek')::integer end as week,
           -- As readmodel/orderinfo.ts: one line per (number, subNumber), the
           -- first one printed; no quantity counts as 1.
           (select sum(q.quantity)::integer
              from (select distinct on (e.value ->> 'number', coalesce(e.value ->> 'subNumber', ''))
                           case when jsonb_typeof(e.value -> 'quantity') = 'number' and (e.value ->> 'quantity')::numeric > 0
                                then greatest(1, round((e.value ->> 'quantity')::numeric))::integer else 1 end as quantity
                      from jsonb_array_elements(coalesce(p.positions, '[]'::jsonb)) with ordinality as e
                     where jsonb_typeof(e.value -> 'number') = 'number'
                     order by e.value ->> 'number', coalesce(e.value ->> 'subNumber', ''), e.ordinality) q) as elements
      from newest n
      left join rpt.order_positions() p on p.order_no = n.order_no
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

revoke all on function rpt.week_plan_documents(integer, integer) from public, anon;
grant execute on function rpt.week_plan_documents(integer, integer) to authenticated;
revoke all on function rpt.all_orders_base() from public, anon, authenticated;
