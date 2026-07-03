begin;

create or replace function public.get_dashboard_period_comparison(
  p_start_date date,
  p_end_date date,
  p_app_key text default null,
  p_platform_key text default null,
  p_country_key text default null,
  p_driver_key text default null,
  p_agent_key text default null,
  p_priority text default null,
  p_channel text default null,
  p_time_zone text default 'America/New_York',
  p_period_kind text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_kind text;
  v_effective_kind text;
  v_current_month_start date;
  v_current_month_end date;
  v_previous_start date;
  v_previous_end date;
  v_previous_month_start date;
  v_previous_month_end date;
  v_period_days integer;
  v_elapsed_days integer;
  v_current jsonb;
  v_previous jsonb;
  v_metrics jsonb;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'dashboard_comparison_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'dashboard_comparison_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'dashboard_comparison_date_range_too_large';
  end if;

  v_period_kind := lower(coalesce(nullif(btrim(p_period_kind), ''), 'auto'));

  if v_period_kind not in ('auto', '7d', '30d', '90d', 'mtd', 'month', 'custom') then
    raise exception 'dashboard_comparison_period_kind_invalid';
  end if;

  v_period_days := (p_end_date - p_start_date) + 1;
  v_current_month_start := date_trunc('month', p_start_date)::date;
  v_current_month_end := (
    date_trunc('month', p_start_date) + interval '1 month - 1 day'
  )::date;

  if v_period_kind = 'auto' then
    if p_start_date = v_current_month_start
      and p_end_date = v_current_month_end then
      v_effective_kind := 'month';
    elsif p_start_date = v_current_month_start
      and date_trunc('month', p_end_date)::date = v_current_month_start then
      v_effective_kind := 'mtd';
    else
      v_effective_kind := 'previous_period';
    end if;
  elsif v_period_kind = 'custom'
    and p_start_date = v_current_month_start
    and p_end_date = v_current_month_end then
    v_effective_kind := 'month';
  elsif v_period_kind = 'mtd' then
    v_effective_kind := 'mtd';
  elsif v_period_kind = 'month' then
    v_effective_kind := 'month';
  else
    v_effective_kind := 'previous_period';
  end if;

  if v_effective_kind = 'month' then
    if p_start_date <> v_current_month_start
      or p_end_date <> v_current_month_end then
      raise exception 'dashboard_comparison_month_range_invalid';
    end if;

    v_previous_start := (v_current_month_start - interval '1 month')::date;
    v_previous_end := (v_current_month_start - interval '1 day')::date;
  elsif v_effective_kind = 'mtd' then
    if p_start_date <> v_current_month_start
      or date_trunc('month', p_end_date)::date <> v_current_month_start then
      raise exception 'dashboard_comparison_mtd_range_invalid';
    end if;

    v_elapsed_days := p_end_date - p_start_date;
    v_previous_month_start := (
      v_current_month_start - interval '1 month'
    )::date;
    v_previous_month_end := (v_current_month_start - interval '1 day')::date;
    v_previous_start := v_previous_month_start;
    v_previous_end := least(
      v_previous_month_start + v_elapsed_days,
      v_previous_month_end
    );
  else
    v_previous_end := p_start_date - 1;
    v_previous_start := v_previous_end - (v_period_days - 1);
  end if;

  v_current := public.get_dashboard_filtered_data(
    p_start_date,
    p_end_date,
    p_app_key,
    p_platform_key,
    p_country_key,
    p_driver_key,
    p_agent_key,
    p_priority,
    p_channel,
    p_time_zone
  );

  v_previous := public.get_dashboard_filtered_data(
    v_previous_start,
    v_previous_end,
    p_app_key,
    p_platform_key,
    p_country_key,
    p_driver_key,
    p_agent_key,
    p_priority,
    p_channel,
    p_time_zone
  );

  with metric_names(metric_key) as (
    values
      ('tickets_created'::text),
      ('tickets_solved'::text),
      ('backlog_open'::text),
      ('backlog_over_24h'::text),
      ('backlog_over_48h'::text),
      ('first_response_minutes'::text),
      ('resolution_minutes'::text),
      ('reopened_tickets'::text)
  ),
  metric_values as (
    select
      metric_key,
      case
        when jsonb_typeof(v_current -> 'summary' -> metric_key) = 'number'
          then (v_current -> 'summary' ->> metric_key)::numeric
        else null
      end as current_value,
      case
        when jsonb_typeof(v_previous -> 'summary' -> metric_key) = 'number'
          then (v_previous -> 'summary' ->> metric_key)::numeric
        else null
      end as previous_value
    from metric_names
  ),
  metric_comparisons as (
    select
      metric_key,
      current_value,
      previous_value,
      case
        when current_value is null or previous_value is null then null
        else current_value - previous_value
      end as absolute_change,
      case
        when current_value is null or previous_value is null then null
        when previous_value = 0 then null
        else round(
          ((current_value - previous_value) / abs(previous_value)) * 100,
          1
        )
      end as percent_change,
      case
        when current_value is null or previous_value is null then 'missing'
        when previous_value = 0 and current_value > 0 then 'new'
        when current_value = previous_value then 'flat'
        when current_value > previous_value then 'increase'
        else 'decrease'
      end as direction,
      previous_value = 0 as zero_baseline
    from metric_values
  )
  select coalesce(
    jsonb_object_agg(
      metric_key,
      jsonb_build_object(
        'current', current_value,
        'previous', previous_value,
        'absoluteChange', absolute_change,
        'percentChange', percent_change,
        'direction', direction,
        'zeroBaseline', zero_baseline
      )
    ),
    '{}'::jsonb
  )
  into v_metrics
  from metric_comparisons;

  return jsonb_build_object(
    'periodKind', v_effective_kind,
    'currentRange', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'days', v_period_days,
      'timeZone', p_time_zone
    ),
    'previousRange', jsonb_build_object(
      'startDate', v_previous_start,
      'endDate', v_previous_end,
      'days', (v_previous_end - v_previous_start) + 1,
      'timeZone', p_time_zone
    ),
    'metrics', v_metrics
  );
end;
$$;

revoke all
on function public.get_dashboard_period_comparison(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
from public, anon;

grant execute
on function public.get_dashboard_period_comparison(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
to authenticated, service_role;

comment on function public.get_dashboard_period_comparison(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) is
  'Returns current-versus-previous period comparisons for dashboard summary KPIs using the Step 4 server-filtered data contract.';

commit;
