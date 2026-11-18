-- The week plan (/ugeplan, docs/ugeplan.md) reads the 3E production lists of
-- one delivery week, also of orders not scanned yet: those have no row in
-- core.orders, and raw.order_documents is service only.
--
-- SECURITY DEFINER for the reason rpt.order_documents gives: it opens only
-- what the week plan reads (the header and, per position, the number,
-- quantity, system, notes and each field's opening and sash size), to the
-- four portal roles, for one week. search_path is pinned and it takes no
-- identifier from the caller.
--
-- Each order's newest list is taken first, and only then is its week
-- compared, so an order moved to another week leaves its old one. The week:
-- the one core.orders gives the order when it has a row, else the list's
-- "Lev. uge". "Lev. uge" has no year: the list is of p_year when it was
-- printed (or synced, without a print date) in the 30 weeks before that
-- week's Monday or the two weeks after. No cast here can fail on an odd
-- parsed value: one bad row must not take the page down.
create function rpt.week_plan_documents(p_year integer, p_week integer)
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
    with newest as (
      select distinct on (d.order_no)
             d.order_no, d.print_date, d.synced_at, d.parsed
        from raw.order_documents d
       where d.order_no is not null and jsonb_typeof(d.parsed) = 'object'
       order by d.order_no, d.print_date desc nulls last, d.synced_at desc, d.file_name desc
    )
    select n.order_no,
           n.print_date,
           n.parsed -> 'header',
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'number', p.value -> 'number',
                      'subNumber', p.value -> 'subNumber',
                      'quantity', p.value -> 'quantity',
                      'system', p.value -> 'system',
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
               from jsonb_array_elements(
                      case when jsonb_typeof(n.parsed -> 'positions') = 'array'
                           then n.parsed -> 'positions' else '[]'::jsonb end
                    ) with ordinality as p
           ), '[]'::jsonb)
      from newest n
      left join core.orders o on o.order_no = n.order_no and o.delivery_week is not null
     where case
             when o.order_no is not null then o.delivery_year = p_year and o.delivery_week = p_week
             else (n.parsed -> 'header' ->> 'deliveryWeek') = p_week::text
                  and coalesce(n.print_date, n.synced_at::date) between monday - 210 and monday + 14
           end
     order by n.order_no;
end
$$;

revoke all on function rpt.week_plan_documents(integer, integer) from public, anon;
grant execute on function rpt.week_plan_documents(integer, integer) to authenticated;
