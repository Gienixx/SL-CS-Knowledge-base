begin;

create or replace function public.get_agent_analytics_dashboard(
  p_start_date date,
  p_end_date date,
  p_agent_key text default null,
  p_time_zone text default 'America/New_York'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_result jsonb;
  v_time_zone text;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'agent_analytics_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'agent_analytics_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'agent_analytics_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'agent_analytics_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  with
  bounds as materialized (
    select
      p_start_date::timestamp at time zone v_time_zone as range_start,
      (p_end_date + 1)::timestamp at time zone v_time_zone as range_end
  ),
  all_agent_scope as materialized (
    select
      map.agent_key,
      map.agent_name,
      map.zendesk_agent_key
    from public.agent_identity_map as map
    where map.active = true
  ),
  selected_agent_scope as materialized (
    select *
    from all_agent_scope
    where nullif(btrim(p_agent_key), '') is null
      or agent_key = lower(btrim(p_agent_key))
  ),
  productivity_rows as materialized (
    select
      productivity.report_date,
      productivity.agent_key,
      productivity.agent_name,
      productivity.solved_tickets,
      productivity.open_tickets,
      productivity.aht_value
    from public.agent_productivity as productivity
    join all_agent_scope as scope using (agent_key)
    where productivity.report_date >= p_start_date
      and productivity.report_date <= p_end_date
  ),
  productivity_agg as materialized (
    select
      scope.agent_key,
      scope.agent_name,
      scope.zendesk_agent_key,
      coalesce(sum(rows.solved_tickets), 0)::bigint as solved_tickets,
      (array_agg(
        rows.open_tickets
        order by rows.report_date desc
      ) filter (where rows.open_tickets is not null))[1]::numeric
        as latest_open_tickets,
      round(avg(rows.open_tickets)::numeric, 2) as avg_open_tickets,
      round(
        case
          when sum(rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ) > 0
          then sum(rows.aht_value * rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ) / nullif(sum(rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ), 0)
          else avg(rows.aht_value)
        end::numeric,
        2
      ) as avg_aht_minutes,
      round((
        percentile_cont(0.5) within group (
          order by rows.aht_value
        ) filter (where rows.aht_value is not null)
      )::numeric, 2) as median_aht_minutes,
      count(distinct rows.report_date)::integer as reporting_days
    from all_agent_scope as scope
    left join productivity_rows as rows using (agent_key)
    group by
      scope.agent_key,
      scope.agent_name,
      scope.zendesk_agent_key
  ),
  team_productivity as materialized (
    select
      coalesce(sum(solved_tickets), 0)::numeric as solved_tickets,
      coalesce(sum(avg_open_tickets), 0)::numeric as avg_open_tickets,
      coalesce(sum(latest_open_tickets), 0)::numeric as latest_open_tickets
    from productivity_agg
  ),
  created_tickets as materialized (
    select ticket_id, min(event_timestamp) as created_at
    from public.ticket_events
    where event_type = 'created'
    group by ticket_id
  ),
  response_rows as materialized (
    select
      response.ticket_id,
      response.event_timestamp as response_at,
      assignment.agent_key as zendesk_agent_key,
      case
        when response.metadata ->> 'calendar_minutes'
          ~ '^[0-9]+([.][0-9]+)?$'
        then (response.metadata ->> 'calendar_minutes')::numeric
        else null
      end as response_minutes
    from public.ticket_events as response
    cross join bounds
    left join lateral (
      select assigned.agent_key
      from public.ticket_events as assigned
      where assigned.ticket_id = response.ticket_id
        and assigned.event_type in ('created', 'assigned')
        and assigned.agent_key is not null
        and assigned.event_timestamp <= response.event_timestamp
      order by assigned.event_timestamp desc, assigned.source_event_id desc
      limit 1
    ) as assignment on true
    where response.event_type = 'first_response'
      and response.event_timestamp >= bounds.range_start
      and response.event_timestamp < bounds.range_end
  ),
  response_agg as materialized (
    select
      scope.agent_key,
      count(distinct response.ticket_id)::bigint as responded_tickets,
      round(avg(response.response_minutes), 2) as avg_first_response_minutes,
      round((percentile_cont(0.5) within group (
        order by response.response_minutes
      ))::numeric, 2) as median_first_response_minutes
    from all_agent_scope as scope
    left join response_rows as response
      on response.zendesk_agent_key = scope.zendesk_agent_key
    group by scope.agent_key
  ),
  resolution_candidates as materialized (
    select
      terminal.ticket_id,
      terminal.event_timestamp as resolution_at,
      created.created_at,
      coalesce(terminal.agent_key, assignment.agent_key) as zendesk_agent_key,
      round(
        extract(epoch from (terminal.event_timestamp - created.created_at))::numeric / 60.0,
        2
      ) as resolution_minutes
    from public.ticket_events as terminal
    join created_tickets as created using (ticket_id)
    cross join bounds
    left join lateral (
      select assigned.agent_key
      from public.ticket_events as assigned
      where assigned.ticket_id = terminal.ticket_id
        and assigned.event_type in ('created', 'assigned')
        and assigned.agent_key is not null
        and assigned.event_timestamp <= terminal.event_timestamp
      order by assigned.event_timestamp desc, assigned.source_event_id desc
      limit 1
    ) as assignment on true
    where terminal.event_type = 'solved'
      and terminal.event_timestamp >= bounds.range_start
      and terminal.event_timestamp < bounds.range_end
      and terminal.event_timestamp >= created.created_at
  ),
  resolved_tickets as materialized (
    select distinct on (ticket_id)
      candidate.ticket_id,
      candidate.resolution_at,
      candidate.zendesk_agent_key,
      candidate.resolution_minutes,
      exists (
        select 1
        from public.ticket_events as reopened
        cross join bounds
        where reopened.ticket_id = candidate.ticket_id
          and reopened.event_type = 'reopened'
          and reopened.event_timestamp < bounds.range_end
          and exists (
            select 1
            from public.ticket_events as prior_resolution
            where prior_resolution.ticket_id = candidate.ticket_id
              and prior_resolution.event_type = 'solved'
              and prior_resolution.event_timestamp >= bounds.range_start
              and prior_resolution.event_timestamp < reopened.event_timestamp
          )
      ) as reopened_after_resolution
    from resolution_candidates as candidate
    order by ticket_id, resolution_at desc
  ),
  resolution_agg as materialized (
    select
      scope.agent_key,
      count(resolved.ticket_id)::bigint as resolved_tickets,
      count(resolved.ticket_id) filter (
        where resolved.reopened_after_resolution
      )::bigint as reopened_tickets,
      round(avg(resolved.resolution_minutes), 2) as avg_resolution_minutes,
      round((percentile_cont(0.5) within group (
        order by resolved.resolution_minutes
      ))::numeric, 2) as median_resolution_minutes
    from all_agent_scope as scope
    left join resolved_tickets as resolved
      on resolved.zendesk_agent_key = scope.zendesk_agent_key
    group by scope.agent_key
  ),
  agent_rows as materialized (
    select
      productivity.agent_key,
      productivity.agent_name,
      productivity.zendesk_agent_key,
      productivity.zendesk_agent_key is not null as zendesk_mapped,
      productivity.solved_tickets,
      productivity.latest_open_tickets,
      productivity.avg_open_tickets,
      productivity.avg_aht_minutes,
      productivity.median_aht_minutes,
      productivity.reporting_days,
      coalesce(response.responded_tickets, 0)::bigint as responded_tickets,
      response.avg_first_response_minutes,
      response.median_first_response_minutes,
      coalesce(resolution.resolved_tickets, 0)::bigint as resolved_tickets,
      coalesce(resolution.reopened_tickets, 0)::bigint as reopened_tickets,
      resolution.avg_resolution_minutes,
      resolution.median_resolution_minutes,
      round(
        case
          when team.solved_tickets > 0
          then productivity.solved_tickets::numeric / team.solved_tickets
          else null
        end,
        4
      ) as team_output_share,
      round(
        case
          when team.avg_open_tickets > 0
          then productivity.avg_open_tickets / team.avg_open_tickets
          else null
        end,
        4
      ) as workload_share,
      round(
        case
          when team.solved_tickets > 0
            and team.avg_open_tickets > 0
            and productivity.avg_open_tickets > 0
          then (
            productivity.solved_tickets::numeric / team.solved_tickets
          ) / (
            productivity.avg_open_tickets / team.avg_open_tickets
          ) * 100
          else null
        end,
        1
      ) as workload_adjusted_index,
      round(
        case
          when coalesce(resolution.resolved_tickets, 0) > 0
          then resolution.reopened_tickets::numeric /
            resolution.resolved_tickets::numeric
          else null
        end,
        4
      ) as reopen_rate
    from productivity_agg as productivity
    cross join team_productivity as team
    left join response_agg as response using (agent_key)
    left join resolution_agg as resolution using (agent_key)
    where nullif(btrim(p_agent_key), '') is null
      or productivity.agent_key = lower(btrim(p_agent_key))
  ),
  trend_rows as materialized (
    select
      rows.report_date,
      coalesce(sum(rows.solved_tickets), 0)::bigint as solved_tickets,
      coalesce(sum(rows.open_tickets), 0)::bigint as open_tickets,
      round(
        case
          when sum(rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ) > 0
          then sum(rows.aht_value * rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ) / nullif(sum(rows.solved_tickets) filter (
            where rows.aht_value is not null and rows.solved_tickets > 0
          ), 0)
          else avg(rows.aht_value)
        end::numeric,
        2
      ) as avg_aht_minutes
    from productivity_rows as rows
    where nullif(btrim(p_agent_key), '') is null
      or rows.agent_key = lower(btrim(p_agent_key))
    group by rows.report_date
  ),
  team_one_touch as materialized (
    select round(
      case
        when sum(solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ) > 0
        then sum(one_touch_resolution * solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ) / nullif(sum(solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ), 0)
        else avg(one_touch_resolution)
      end::numeric,
      4
    ) as rate
    from public.daily_ticket_metrics
    where report_date >= p_start_date
      and report_date <= p_end_date
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'readiness', jsonb_build_object(
      'mappedAgents', (
        select count(*)::integer
        from selected_agent_scope
        where zendesk_agent_key is not null
      ),
      'unmappedAgents', coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', agent_key,
          'label', agent_name
        ) order by agent_name)
        from selected_agent_scope
        where zendesk_agent_key is null
      ), '[]'::jsonb),
      'eventMetricsAvailable', exists (
        select 1 from selected_agent_scope where zendesk_agent_key is not null
      )
    ),
    'summary', jsonb_build_object(
      'scope_solved_tickets', (
        select coalesce(sum(solved_tickets), 0)::bigint from agent_rows
      ),
      'scope_latest_open_tickets', (
        select coalesce(sum(latest_open_tickets), 0)::numeric from agent_rows
      ),
      'team_solved_tickets', (select solved_tickets from team_productivity),
      'team_latest_open_tickets', (select latest_open_tickets from team_productivity),
      'avg_aht_minutes', (
        select round(
          case
            when sum(solved_tickets) filter (
              where aht_value is not null and solved_tickets > 0
            ) > 0
            then sum(aht_value * solved_tickets) filter (
              where aht_value is not null and solved_tickets > 0
            ) / nullif(sum(solved_tickets) filter (
              where aht_value is not null and solved_tickets > 0
            ), 0)
            else avg(aht_value)
          end::numeric,
          2
        )
        from productivity_rows
        where nullif(btrim(p_agent_key), '') is null
          or agent_key = lower(btrim(p_agent_key))
      ),
      'median_aht_minutes', (
        select round((percentile_cont(0.5) within group (
          order by aht_value
        ))::numeric, 2)
        from productivity_rows
        where aht_value is not null
          and (
            nullif(btrim(p_agent_key), '') is null
            or agent_key = lower(btrim(p_agent_key))
          )
      ),
      'avg_first_response_minutes', (
        select round(avg(response_minutes), 2)
        from response_rows
        where zendesk_agent_key in (
          select zendesk_agent_key
          from selected_agent_scope
          where zendesk_agent_key is not null
        )
      ),
      'avg_resolution_minutes', (
        select round(avg(resolution_minutes), 2)
        from resolved_tickets
        where zendesk_agent_key in (
          select zendesk_agent_key
          from selected_agent_scope
          where zendesk_agent_key is not null
        )
      ),
      'reopen_rate', (
        select round(
          count(*) filter (where reopened_after_resolution)::numeric /
            nullif(count(*), 0)::numeric,
          4
        )
        from resolved_tickets
        where zendesk_agent_key in (
          select zendesk_agent_key
          from selected_agent_scope
          where zendesk_agent_key is not null
        )
      ),
      'team_one_touch_resolution_rate', (select rate from team_one_touch)
    ),
    'agents', coalesce((
      select jsonb_agg(
        to_jsonb(agent_rows)
        order by solved_tickets desc, agent_name
      )
      from agent_rows
    ), '[]'::jsonb),
    'trend', coalesce((
      select jsonb_agg(
        to_jsonb(trend_rows)
        order by report_date
      )
      from trend_rows
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'agents', coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', agent_key,
          'label', agent_name,
          'mapped', zendesk_agent_key is not null
        ) order by agent_name)
        from public.agent_identity_map
        where active = true
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

comment on function public.get_agent_analytics_dashboard(date, date, text, text) is
  'Returns date-bounded agent productivity, response, resolution, reopen, output-share, and workload-adjusted analytics without SLA data.';

notify pgrst, 'reload schema';

commit;
