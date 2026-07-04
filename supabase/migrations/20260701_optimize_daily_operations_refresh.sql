begin;

create or replace function public.refresh_daily_operations_metrics(
  p_start_date date default null,
  p_end_date date default null,
  p_time_zone text default 'America/New_York'
)
returns table (
  refresh_start_date date,
  refresh_end_date date,
  rows_upserted bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_date date;
  v_max_date date;
  v_start_date date;
  v_end_date date;
  v_time_zone text;
  v_rows bigint := 0;
begin
  v_time_zone := nullif(btrim(p_time_zone), '');

  if v_time_zone is null then
    raise exception 'operations_time_zone_required';
  end if;

  perform now() at time zone v_time_zone;

  select
    min((event_timestamp at time zone v_time_zone)::date),
    max((event_timestamp at time zone v_time_zone)::date)
  into v_min_date, v_max_date
  from public.ticket_events;

  if v_min_date is null then
    return query
    select p_start_date, p_end_date, 0::bigint;
    return;
  end if;

  v_start_date := coalesce(p_start_date, v_min_date);
  v_end_date := coalesce(
    p_end_date,
    greatest(
      v_max_date,
      (now() at time zone v_time_zone)::date
    )
  );

  if v_start_date > v_end_date then
    raise exception 'operations_date_range_invalid';
  end if;

  with date_spine as materialized (
    select
      day_value::date as report_date,
      day_value at time zone v_time_zone as day_start,
      (day_value + interval '1 day') at time zone v_time_zone as day_end
    from generate_series(
      v_start_date::timestamp,
      v_end_date::timestamp,
      interval '1 day'
    ) as day_value
  ),
  created_tickets as materialized (
    select
      ticket_id,
      min(event_timestamp) as created_at
    from public.ticket_events
    where event_type = 'created'
    group by ticket_id
  ),
  state_events as materialized (
    select
      created.ticket_id,
      'created:' || created.ticket_id::text as source_event_id,
      created.created_at as event_timestamp,
      true as is_open,
      0 as state_order
    from created_tickets as created

    union all

    select
      event.ticket_id,
      event.source_event_id,
      event.event_timestamp,
      case
        when event.event_type in ('solved', 'closed') then false
        else true
      end as is_open,
      case event.event_type
        when 'status_changed' then 1
        when 'reopened' then 2
        when 'solved' then 3
        when 'closed' then 4
        else 1
      end as state_order
    from public.ticket_events as event
    where event.event_type in (
      'status_changed',
      'reopened',
      'solved',
      'closed'
    )
  ),
  state_intervals as materialized (
    select
      state.ticket_id,
      state.event_timestamp as state_start,
      lead(state.event_timestamp) over (
        partition by state.ticket_id
        order by
          state.event_timestamp,
          state.state_order,
          state.source_event_id
      ) as state_end,
      state.is_open
    from state_events as state
  ),
  backlog_daily as (
    select
      dates.report_date,
      count(distinct interval.ticket_id)::bigint as backlog_open,
      count(distinct interval.ticket_id) filter (
        where created.created_at <= dates.day_end - interval '24 hours'
      )::bigint as backlog_over_24h,
      count(distinct interval.ticket_id) filter (
        where created.created_at <= dates.day_end - interval '48 hours'
      )::bigint as backlog_over_48h
    from date_spine as dates
    left join state_intervals as interval
      on interval.is_open = true
     and interval.state_start < dates.day_end
     and (
       interval.state_end is null or
       interval.state_end >= dates.day_end
     )
    left join created_tickets as created
      on created.ticket_id = interval.ticket_id
    group by dates.report_date
  ),
  created_daily as (
    select
      (created.created_at at time zone v_time_zone)::date as report_date,
      count(*)::bigint as tickets_created
    from created_tickets as created
    where created.created_at >= (
      v_start_date::timestamp at time zone v_time_zone
    )
      and created.created_at < (
        (v_end_date + 1)::timestamp at time zone v_time_zone
      )
    group by 1
  ),
  solved_daily as (
    select
      (event.event_timestamp at time zone v_time_zone)::date as report_date,
      count(distinct event.ticket_id)::bigint as tickets_solved
    from public.ticket_events as event
    where event.event_type = 'solved'
      and event.event_timestamp >= (
        v_start_date::timestamp at time zone v_time_zone
      )
      and event.event_timestamp < (
        (v_end_date + 1)::timestamp at time zone v_time_zone
      )
    group by 1
  ),
  reopened_daily as (
    select
      (event.event_timestamp at time zone v_time_zone)::date as report_date,
      count(distinct event.ticket_id)::bigint as reopened_tickets
    from public.ticket_events as event
    where event.event_type = 'reopened'
      and event.event_timestamp >= (
        v_start_date::timestamp at time zone v_time_zone
      )
      and event.event_timestamp < (
        (v_end_date + 1)::timestamp at time zone v_time_zone
      )
    group by 1
  ),
  first_response_daily as (
    select
      (event.event_timestamp at time zone v_time_zone)::date as report_date,
      round(avg(
        case
          when event.metadata ->> 'calendar_minutes'
            ~ '^[0-9]+([.][0-9]+)?$'
          then (event.metadata ->> 'calendar_minutes')::numeric
          else null
        end
      ), 2) as first_response_minutes
    from public.ticket_events as event
    where event.event_type = 'first_response'
      and event.event_timestamp >= (
        v_start_date::timestamp at time zone v_time_zone
      )
      and event.event_timestamp < (
        (v_end_date + 1)::timestamp at time zone v_time_zone
      )
    group by 1
  ),
  current_state as materialized (
    select distinct on (state.ticket_id)
      state.ticket_id,
      state.event_timestamp,
      state.is_open
    from state_events as state
    order by
      state.ticket_id,
      state.event_timestamp desc,
      state.state_order desc,
      state.source_event_id desc
  ),
  resolution_daily as (
    select
      (state.event_timestamp at time zone v_time_zone)::date as report_date,
      round(avg(
        extract(epoch from (
          state.event_timestamp - created.created_at
        )) / 60.0
      ), 2) as resolution_minutes
    from current_state as state
    join created_tickets as created
      on created.ticket_id = state.ticket_id
    where state.is_open = false
      and state.event_timestamp >= created.created_at
      and state.event_timestamp >= (
        v_start_date::timestamp at time zone v_time_zone
      )
      and state.event_timestamp < (
        (v_end_date + 1)::timestamp at time zone v_time_zone
      )
    group by 1
  ),
  daily_values as (
    select
      dates.report_date,
      coalesce(created.tickets_created, 0)::bigint as tickets_created,
      coalesce(solved.tickets_solved, 0)::bigint as tickets_solved,
      coalesce(backlog.backlog_open, 0)::bigint as backlog_open,
      coalesce(backlog.backlog_over_24h, 0)::bigint as backlog_over_24h,
      coalesce(backlog.backlog_over_48h, 0)::bigint as backlog_over_48h,
      response.first_response_minutes,
      resolution.resolution_minutes,
      coalesce(reopened.reopened_tickets, 0)::bigint as reopened_tickets
    from date_spine as dates
    left join created_daily as created using (report_date)
    left join solved_daily as solved using (report_date)
    left join backlog_daily as backlog using (report_date)
    left join first_response_daily as response using (report_date)
    left join resolution_daily as resolution using (report_date)
    left join reopened_daily as reopened using (report_date)
  )
  insert into public.daily_operations_metrics (
    report_date,
    report_timezone,
    tickets_created,
    tickets_solved,
    backlog_open,
    backlog_over_24h,
    backlog_over_48h,
    first_response_minutes,
    resolution_minutes,
    sla_breaches,
    reopened_tickets,
    csat_score,
    calculated_at,
    source_system
  )
  select
    report_date,
    v_time_zone,
    tickets_created,
    tickets_solved,
    backlog_open,
    backlog_over_24h,
    backlog_over_48h,
    first_response_minutes,
    resolution_minutes,
    null::bigint,
    reopened_tickets,
    null::numeric,
    now(),
    'ticket_events'
  from daily_values
  on conflict (report_date) do update
  set
    report_timezone = excluded.report_timezone,
    tickets_created = excluded.tickets_created,
    tickets_solved = excluded.tickets_solved,
    backlog_open = excluded.backlog_open,
    backlog_over_24h = excluded.backlog_over_24h,
    backlog_over_48h = excluded.backlog_over_48h,
    first_response_minutes = excluded.first_response_minutes,
    resolution_minutes = excluded.resolution_minutes,
    reopened_tickets = excluded.reopened_tickets,
    calculated_at = excluded.calculated_at,
    source_system = excluded.source_system;

  get diagnostics v_rows = row_count;

  return query
  select v_start_date, v_end_date, v_rows;
end;
$$;

revoke all
on function public.refresh_daily_operations_metrics(date, date, text)
from public, anon, authenticated;

grant execute
on function public.refresh_daily_operations_metrics(date, date, text)
to service_role;

comment on function public.refresh_daily_operations_metrics(date, date, text) is
  'Refreshes daily operational metrics using materialized ticket-state intervals.';

commit;
