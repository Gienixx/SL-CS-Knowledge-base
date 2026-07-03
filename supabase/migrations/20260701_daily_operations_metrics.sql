begin;

create table if not exists public.daily_operations_metrics (
  report_date date primary key,
  report_timezone text not null default 'America/New_York',
  tickets_created bigint not null default 0
    check (tickets_created >= 0),
  tickets_solved bigint not null default 0
    check (tickets_solved >= 0),
  backlog_open bigint not null default 0
    check (backlog_open >= 0),
  backlog_over_24h bigint not null default 0
    check (backlog_over_24h >= 0),
  backlog_over_48h bigint not null default 0
    check (backlog_over_48h >= 0),
  first_response_minutes numeric(14, 2)
    check (first_response_minutes is null or first_response_minutes >= 0),
  resolution_minutes numeric(14, 2)
    check (resolution_minutes is null or resolution_minutes >= 0),
  sla_breaches bigint
    check (sla_breaches is null or sla_breaches >= 0),
  reopened_tickets bigint not null default 0
    check (reopened_tickets >= 0),
  csat_score numeric(10, 2)
    check (csat_score is null or csat_score >= 0),
  calculated_at timestamptz not null default now(),
  source_system text not null default 'ticket_events'
);

create index if not exists daily_operations_metrics_calculated_idx
  on public.daily_operations_metrics (calculated_at desc);

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

  -- PostgreSQL raises for an invalid IANA time-zone name.
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

  with date_spine as (
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
  created_tickets as (
    select
      ticket_id,
      min(event_timestamp) as created_at
    from public.ticket_events
    where event_type = 'created'
    group by ticket_id
  ),
  lifecycle_events as (
    select
      ticket_id,
      source_event_id,
      event_timestamp,
      case
        when event_type in ('solved', 'closed') then true
        when event_type in ('reopened', 'status_changed') then false
        else null
      end as is_terminal
    from public.ticket_events
    where event_type in (
      'solved',
      'closed',
      'reopened',
      'status_changed'
    )
  ),
  current_lifecycle as (
    select distinct on (ticket_id)
      ticket_id,
      event_timestamp,
      is_terminal
    from lifecycle_events
    order by
      ticket_id,
      event_timestamp desc,
      source_event_id desc
  ),
  finally_resolved as (
    select
      created.ticket_id,
      created.created_at,
      lifecycle.event_timestamp as resolution_at
    from created_tickets as created
    join current_lifecycle as lifecycle
      on lifecycle.ticket_id = created.ticket_id
     and lifecycle.is_terminal = true
     and lifecycle.event_timestamp >= created.created_at
  ),
  daily_values as (
    select
      dates.report_date,
      count(*) filter (
        where created.created_at >= dates.day_start
          and created.created_at < dates.day_end
      )::bigint as tickets_created,
      (
        select count(distinct solved.ticket_id)::bigint
        from public.ticket_events as solved
        where solved.event_type = 'solved'
          and solved.event_timestamp >= dates.day_start
          and solved.event_timestamp < dates.day_end
      ) as tickets_solved,
      count(*) filter (
        where created.created_at < dates.day_end
          and not coalesce((
            select lifecycle.is_terminal
            from lifecycle_events as lifecycle
            where lifecycle.ticket_id = created.ticket_id
              and lifecycle.event_timestamp < dates.day_end
            order by
              lifecycle.event_timestamp desc,
              lifecycle.source_event_id desc
            limit 1
          ), false)
      )::bigint as backlog_open,
      count(*) filter (
        where created.created_at < dates.day_end
          and dates.day_end - created.created_at >= interval '24 hours'
          and not coalesce((
            select lifecycle.is_terminal
            from lifecycle_events as lifecycle
            where lifecycle.ticket_id = created.ticket_id
              and lifecycle.event_timestamp < dates.day_end
            order by
              lifecycle.event_timestamp desc,
              lifecycle.source_event_id desc
            limit 1
          ), false)
      )::bigint as backlog_over_24h,
      count(*) filter (
        where created.created_at < dates.day_end
          and dates.day_end - created.created_at >= interval '48 hours'
          and not coalesce((
            select lifecycle.is_terminal
            from lifecycle_events as lifecycle
            where lifecycle.ticket_id = created.ticket_id
              and lifecycle.event_timestamp < dates.day_end
            order by
              lifecycle.event_timestamp desc,
              lifecycle.source_event_id desc
            limit 1
          ), false)
      )::bigint as backlog_over_48h,
      (
        select round(avg(
          nullif(response.metadata ->> 'calendar_minutes', '')::numeric
        ), 2)
        from public.ticket_events as response
        where response.event_type = 'first_response'
          and response.event_timestamp >= dates.day_start
          and response.event_timestamp < dates.day_end
          and response.metadata ? 'calendar_minutes'
      ) as first_response_minutes,
      (
        select round(avg(
          extract(epoch from (
            resolved.resolution_at - resolved.created_at
          )) / 60.0
        ), 2)
        from finally_resolved as resolved
        where resolved.resolution_at >= dates.day_start
          and resolved.resolution_at < dates.day_end
      ) as resolution_minutes,
      (
        select count(distinct reopened.ticket_id)::bigint
        from public.ticket_events as reopened
        where reopened.event_type = 'reopened'
          and reopened.event_timestamp >= dates.day_start
          and reopened.event_timestamp < dates.day_end
      ) as reopened_tickets
    from date_spine as dates
    left join created_tickets as created
      on created.created_at < dates.day_end
    group by
      dates.report_date,
      dates.day_start,
      dates.day_end
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

alter table public.daily_operations_metrics enable row level security;

revoke all privileges
on table public.daily_operations_metrics
from anon, authenticated;

grant select
on table public.daily_operations_metrics
to authenticated;

grant select, insert, update, delete
on table public.daily_operations_metrics
to service_role;

create policy "Authenticated users can read daily operations metrics"
on public.daily_operations_metrics
for select
to authenticated
using (true);

revoke all
on function public.refresh_daily_operations_metrics(date, date, text)
from public, anon, authenticated;

grant execute
on function public.refresh_daily_operations_metrics(date, date, text)
to service_role;

comment on table public.daily_operations_metrics is
  'Daily operational metrics derived from normalized Zendesk ticket events.';

comment on column public.daily_operations_metrics.first_response_minutes is
  'Average calendar first-response minutes for responses occurring on report_date.';

comment on column public.daily_operations_metrics.resolution_minutes is
  'Average elapsed minutes from creation to the latest terminal lifecycle event for tickets finally resolved on report_date.';

comment on column public.daily_operations_metrics.sla_breaches is
  'Reserved for a trusted Zendesk SLA metric source; null until imported.';

comment on column public.daily_operations_metrics.csat_score is
  'Reserved for a trusted Zendesk CSAT source; null until imported.';

commit;
