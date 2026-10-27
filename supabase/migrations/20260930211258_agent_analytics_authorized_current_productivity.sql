create or replace function public.agent_analytics_get_current_productivity(
  p_range text,
  p_custom_start text default null,
  p_custom_end text default null,
  p_agent_key text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_email text;
  v_anchor_date date;
  v_start_date date;
  v_end_date date;
  v_days integer;
  v_rows jsonb;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  if v_email = '' or not exists (
    select 1
    from public.login as approved_user
    where lower(approved_user.email) = v_email
  ) then
    raise exception using
      errcode = '42501',
      message = 'Approved reporting access is required.';
  end if;

  if p_range is null
     or p_range not in ('latest', '7d', '30d', '90d', 'mtd', 'custom') then
    raise exception using
      errcode = '22023',
      message = 'Unsupported reporting date range.';
  end if;

  select productivity.report_date
  into v_anchor_date
  from public.agent_productivity as productivity
  order by productivity.report_date desc
  limit 1;

  if v_anchor_date is null then
    return jsonb_build_object(
      'anchor_date', null,
      'rows', '[]'::jsonb
    );
  end if;

  if p_range = 'custom' then
    if p_custom_start is null or p_custom_end is null
       or p_custom_start !~ '^\d{4}-\d{2}-\d{2}$'
       or p_custom_end !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception using
        errcode = '22023',
        message = 'Choose both a valid start date and end date.';
    end if;

    v_start_date := pg_catalog.to_date(p_custom_start, 'YYYY-MM-DD');
    v_end_date := pg_catalog.to_date(p_custom_end, 'YYYY-MM-DD');
    if v_start_date > v_end_date then
      raise exception using
        errcode = '22023',
        message = 'The start date cannot be after the end date.';
    end if;
  elsif p_range = 'latest' then
    v_start_date := v_anchor_date;
    v_end_date := v_anchor_date;
  elsif p_range = 'mtd' then
    v_start_date := pg_catalog.date_trunc('month', v_anchor_date)::date;
    v_end_date := v_anchor_date;
  else
    v_days := case p_range
      when '7d' then 7
      when '90d' then 90
      else 30
    end;
    v_start_date := v_anchor_date - (v_days - 1);
    v_end_date := v_anchor_date;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'report_date', productivity.report_date,
        'agent_key', productivity.agent_key,
        'agent_name', productivity.agent_name,
        'solved_tickets', productivity.solved_tickets,
        'open_tickets', productivity.open_tickets,
        'aht_value', productivity.aht_value
      ) order by productivity.report_date asc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.agent_productivity as productivity
  where productivity.report_date >= v_start_date
    and productivity.report_date <= v_end_date
    and (p_agent_key is null or productivity.agent_key = p_agent_key);

  return jsonb_build_object(
    'anchor_date', v_anchor_date,
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.agent_analytics_get_current_productivity(text, text, text, text)
  from public, anon;
grant execute on function public.agent_analytics_get_current_productivity(text, text, text, text)
  to authenticated;

;
