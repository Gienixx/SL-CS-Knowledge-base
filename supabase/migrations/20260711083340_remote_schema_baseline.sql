-- PRODUCTION BASELINE: DO NOT paste or execute this file in the SQL Editor of
-- the existing linked project. It records the schema that already exists and is
-- intended only for creating a clean database from scratch. Future production
-- changes must use a new CLI-generated incremental migration.



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."acquire_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid", "p_lease_seconds" integer DEFAULT 900) RETURNS TABLE("current_cursor" "text", "current_start_time" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if p_stream_key is null or btrim(p_stream_key) = '' then
    raise exception 'stream_key_required';
  end if;

  if p_lock_token is null then
    raise exception 'lock_token_required';
  end if;

  insert into public.zendesk_sync_state (stream_key)
  values (p_stream_key)
  on conflict (stream_key) do nothing;

  update public.zendesk_sync_state
  set
    lease_token = p_lock_token,
    lease_expires_at = now() + make_interval(
      secs => greatest(60, least(coalesce(p_lease_seconds, 900), 3600))
    ),
    updated_at = now()
  where stream_key = p_stream_key
    and (
      lease_token is null
      or lease_expires_at is null
      or lease_expires_at < now()
      or lease_token = p_lock_token
    )
  returning cursor, start_time
  into current_cursor, current_start_time;

  if not found then
    raise exception 'zendesk_sync_locked'
      using errcode = '55P03';
  end if;

  return next;
end;
$$;


ALTER FUNCTION "public"."acquire_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid", "p_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_zendesk_sync_state"("p_stream_key" "text", "p_lock_token" "uuid", "p_cursor" "text", "p_start_time" bigint, "p_last_event_timestamp" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.zendesk_sync_state
  set
    cursor = p_cursor,
    start_time = coalesce(p_start_time, start_time),
    last_event_timestamp = coalesce(
      p_last_event_timestamp,
      last_event_timestamp
    ),
    last_success_at = now(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where stream_key = p_stream_key
    and lease_token = p_lock_token;

  if not found then
    raise exception 'zendesk_sync_lock_lost'
      using errcode = '55P03';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."advance_zendesk_sync_state"("p_stream_key" "text", "p_lock_token" "uuid", "p_cursor" "text", "p_start_time" bigint, "p_last_event_timestamp" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."capture_agent_identity_from_productivity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.agent_identity_map (agent_key, agent_name)
  values (
    lower(btrim(new.agent_key)),
    coalesce(
      nullif(btrim(new.agent_name), ''),
      initcap(replace(lower(btrim(new.agent_key)), '_', ' '))
    )
  )
  on conflict (agent_key) do update
  set
    agent_name = excluded.agent_name,
    updated_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."capture_agent_identity_from_productivity"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."capture_agent_identity_from_productivity"() IS 'Keeps the agent identity map aligned with synchronized productivity agents.';



CREATE OR REPLACE FUNCTION "public"."current_user_can_edit_articles"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.login
    where lower(email) = lower(
      coalesce(auth.jwt() ->> 'email', '')
    )
    and (
      can_edit_articles is true
      or is_admin is true
    )
  );
$$;


ALTER FUNCTION "public"."current_user_can_edit_articles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_admin_article_access"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.is_admin is true then
    new.can_edit_articles := true;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_admin_article_access"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text" DEFAULT NULL::"text", "p_time_zone" "text" DEFAULT 'America/New_York'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
  productivity_rows as materialized (
    select
      report_date,
      agent_key,
      agent_name,
      solved_tickets,
      open_tickets,
      aht_value
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
      and (
        nullif(btrim(p_agent_key), '') is null
        or agent_key = lower(btrim(p_agent_key))
      )
  ),
  all_team_rows as materialized (
    select
      report_date,
      agent_key,
      agent_name,
      solved_tickets,
      open_tickets,
      aht_value
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
  ),
  agent_rows as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      null::text as zendesk_agent_key,
      false as zendesk_mapped,
      sum(solved_tickets)::bigint as solved_tickets,
      (array_agg(
        open_tickets
        order by report_date desc
      ) filter (where open_tickets is not null))[1]::numeric
        as latest_open_tickets,
      round(avg(open_tickets)::numeric, 2) as avg_open_tickets,
      round(
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
      ) as avg_aht_minutes,
      round((percentile_cont(0.5) within group (
        order by aht_value
      ) filter (where aht_value is not null))::numeric, 2)
        as median_aht_minutes,
      count(distinct report_date)::integer as reporting_days,
      null::bigint as responded_tickets,
      null::numeric as avg_first_response_minutes,
      null::numeric as median_first_response_minutes,
      null::bigint as resolved_tickets,
      null::bigint as reopened_tickets,
      null::numeric as avg_resolution_minutes,
      null::numeric as median_resolution_minutes
    from productivity_rows
    group by agent_key
  ),
  team_totals as materialized (
    select
      coalesce(sum(solved_tickets), 0)::numeric as solved_tickets,
      coalesce(sum(avg_open_tickets), 0)::numeric as avg_open_tickets,
      coalesce(sum(latest_open_tickets), 0)::numeric as latest_open_tickets
    from (
      select
        agent_key,
        sum(solved_tickets)::numeric as solved_tickets,
        round(avg(open_tickets)::numeric, 2) as avg_open_tickets,
        (array_agg(
          open_tickets
          order by report_date desc
        ) filter (where open_tickets is not null))[1]::numeric
          as latest_open_tickets
      from all_team_rows
      group by agent_key
    ) as totals
  ),
  enriched_agents as materialized (
    select
      agent_rows.*,
      round(
        case
          when team_totals.solved_tickets > 0
          then agent_rows.solved_tickets::numeric / team_totals.solved_tickets
          else null
        end,
        4
      ) as team_output_share,
      round(
        case
          when team_totals.avg_open_tickets > 0
          then agent_rows.avg_open_tickets / team_totals.avg_open_tickets
          else null
        end,
        4
      ) as workload_share,
      round(
        case
          when team_totals.solved_tickets > 0
            and team_totals.avg_open_tickets > 0
            and agent_rows.avg_open_tickets > 0
          then (
            agent_rows.solved_tickets::numeric / team_totals.solved_tickets
          ) / (
            agent_rows.avg_open_tickets / team_totals.avg_open_tickets
          ) * 100
          else null
        end,
        1
      ) as workload_adjusted_index,
      null::numeric as reopen_rate
    from agent_rows
    cross join team_totals
  ),
  trend_rows as materialized (
    select
      report_date,
      sum(solved_tickets)::bigint as solved_tickets,
      sum(open_tickets)::bigint as open_tickets,
      round(
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
      ) as avg_aht_minutes
    from productivity_rows
    group by report_date
  ),
  agent_options as materialized (
    select
      agent_key,
      max(agent_name) as agent_name
    from public.agent_productivity
    group by agent_key
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
    where report_date between p_start_date and p_end_date
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'source', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'availableMetrics', jsonb_build_array(
        'solved_tickets',
        'open_tickets',
        'aht',
        'one_touch_resolution'
      )
    ),
    'readiness', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'mappedAgents', 0,
      'unmappedAgents', '[]'::jsonb,
      'eventMetricsAvailable', false
    ),
    'summary', jsonb_build_object(
      'scope_solved_tickets', coalesce((
        select sum(solved_tickets)::bigint from enriched_agents
      ), 0),
      'scope_latest_open_tickets', coalesce((
        select sum(latest_open_tickets)::numeric from enriched_agents
      ), 0),
      'team_solved_tickets', (select solved_tickets from team_totals),
      'team_latest_open_tickets', (select latest_open_tickets from team_totals),
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
      ),
      'median_aht_minutes', (
        select round((percentile_cont(0.5) within group (
          order by aht_value
        ))::numeric, 2)
        from productivity_rows
        where aht_value is not null
      ),
      'avg_first_response_minutes', null,
      'avg_resolution_minutes', null,
      'reopen_rate', null,
      'team_one_touch_resolution_rate', (select rate from team_one_touch)
    ),
    'agents', coalesce((
      select jsonb_agg(
        to_jsonb(enriched_agents)
        order by solved_tickets desc, agent_name
      )
      from enriched_agents
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
        select jsonb_agg(
          jsonb_build_object(
            'key', agent_key,
            'label', agent_name,
            'mapped', false
          )
          order by agent_name
        )
        from agent_options
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;


ALTER FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text", "p_time_zone" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text", "p_time_zone" "text") IS 'Returns only the agent solved, open, AHT, and team one-touch metrics available in the synchronized Ticket Productivity and Daily Volume tabs.';



CREATE OR REPLACE FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text" DEFAULT NULL::"text", "p_platform_key" "text" DEFAULT NULL::"text", "p_country_key" "text" DEFAULT NULL::"text", "p_driver_key" "text" DEFAULT NULL::"text", "p_agent_key" "text" DEFAULT NULL::"text", "p_priority" "text" DEFAULT NULL::"text", "p_channel" "text" DEFAULT NULL::"text", "p_time_zone" "text" DEFAULT 'America/New_York'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_result jsonb;
  v_time_zone text;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'dashboard_filter_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'dashboard_filter_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'dashboard_filter_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'dashboard_filter_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  if nullif(btrim(p_app_key), '') is not null
    or nullif(btrim(p_platform_key), '') is not null
    or nullif(btrim(p_country_key), '') is not null
    or nullif(btrim(p_driver_key), '') is not null
    or nullif(btrim(p_agent_key), '') is not null
    or nullif(btrim(p_priority), '') is not null
    or nullif(btrim(p_channel), '') is not null then
    raise exception 'sheet_only_dimension_filters_unavailable';
  end if;

  with
  metric_rows as materialized (
    select *
    from public.daily_ticket_metrics
    where report_date between p_start_date and p_end_date
  ),
  latest_metric as materialized (
    select *
    from metric_rows
    order by report_date desc
    limit 1
  ),
  trend_rows as materialized (
    select
      report_date,
      new_tickets::bigint as tickets_created,
      solved_tickets::bigint as tickets_solved
    from metric_rows
  ),
  breakdown_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      sum(ticket_count)::bigint as ticket_count
    from public.daily_distribution_metrics
    where report_date between p_start_date and p_end_date
    group by dimension_type, dimension_key, dimension_label

    union all

    select
      'driver'::text,
      driver_key,
      max(driver_label),
      sum(ticket_count)::bigint
    from public.ticket_driver_metrics
    where report_date between p_start_date and p_end_date
    group by driver_key
  ),
  breakdown_json as (
    select coalesce(
      jsonb_object_agg(dimension_type, items),
      '{}'::jsonb
    ) as data
    from (
      select
        dimension_type,
        jsonb_agg(
          jsonb_build_object(
            'key', dimension_key,
            'label', dimension_label,
            'ticket_count', ticket_count
          )
          order by ticket_count desc, dimension_label
        ) as items
      from breakdown_rows
      group by dimension_type
    ) as grouped
  ),
  agent_rows as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      sum(solved_tickets)::bigint as solved_tickets,
      (array_agg(
        open_tickets
        order by report_date desc
      ) filter (where open_tickets is not null))[1]::numeric as open_tickets,
      round(
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
      ) as avg_aht_minutes
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
    group by agent_key
  ),
  agent_options as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      sum(solved_tickets)::bigint as solved_tickets
    from public.agent_productivity
    group by agent_key
  ),
  option_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      sum(ticket_count)::bigint as ticket_count
    from public.daily_distribution_metrics
    group by dimension_type, dimension_key, dimension_label

    union all

    select
      'driver'::text,
      driver_key,
      max(driver_label),
      sum(ticket_count)::bigint
    from public.ticket_driver_metrics
    group by driver_key
  ),
  option_json as (
    select coalesce(
      jsonb_object_agg(dimension_type, items),
      '{}'::jsonb
    ) as data
    from (
      select
        dimension_type,
        jsonb_agg(
          jsonb_build_object(
            'key', dimension_key,
            'label', dimension_label,
            'ticket_count', ticket_count
          )
          order by dimension_label
        ) as items
      from option_rows
      group by dimension_type
    ) as grouped
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'source', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'dateFiltersAvailable', true,
      'dimensionFiltersAvailable', false
    ),
    'summary', jsonb_build_object(
      'tickets_created', coalesce((select sum(new_tickets)::bigint from metric_rows), 0),
      'tickets_solved', coalesce((select sum(solved_tickets)::bigint from metric_rows), 0),
      'backlog_open', (select unsolved_tickets::bigint from latest_metric),
      'backlog_over_24h', null,
      'backlog_over_48h', null,
      'first_response_minutes', null,
      'resolution_minutes', null,
      'reopened_tickets', null
    ),
    'trend', coalesce((
      select jsonb_agg(to_jsonb(trend_rows) order by report_date)
      from trend_rows
    ), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from breakdown_json),
    'agents', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'agent_key', agent_key,
          'agent_name', agent_name,
          'solved_tickets', solved_tickets,
          'open_tickets', open_tickets,
          'avg_aht_minutes', avg_aht_minutes
        )
        order by solved_tickets desc, agent_name
      )
      from agent_rows
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'agent', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', agent_key,
            'label', agent_name,
            'ticket_count', solved_tickets
          )
          order by agent_name
        )
        from agent_options
      ), '[]'::jsonb),
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from option_json)
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;


ALTER FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") IS 'Returns date-bounded dashboard data from Google Sheet reporting tables only. Dimension intersections are unavailable in the current workbook.';



CREATE OR REPLACE FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text" DEFAULT NULL::"text", "p_platform_key" "text" DEFAULT NULL::"text", "p_country_key" "text" DEFAULT NULL::"text", "p_driver_key" "text" DEFAULT NULL::"text", "p_agent_key" "text" DEFAULT NULL::"text", "p_priority" "text" DEFAULT NULL::"text", "p_channel" "text" DEFAULT NULL::"text", "p_time_zone" "text" DEFAULT 'America/New_York'::"text", "p_period_kind" "text" DEFAULT 'auto'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text", "p_period_kind" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text", "p_period_kind" "text") IS 'Returns current-versus-previous period comparisons for dashboard summary KPIs using the Step 4 server-filtered data contract.';



CREATE OR REPLACE FUNCTION "public"."get_dashboard_reporting_status"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with latest_run as (
    select *
    from public.dashboard_sync_runs
    order by started_at desc
    limit 1
  ),
  latest_quality as (
    select
      status,
      count(*)::integer as check_count,
      jsonb_agg(
        jsonb_build_object(
          'checkKey', check_key,
          'status', status,
          'observedValue', observed_value,
          'details', details,
          'checkedAt', checked_at
        )
        order by check_key
      ) as checks
    from public.dashboard_data_quality_results
    where sync_run_id = (
      select id::text from latest_run
    )
    group by status
  )
  select jsonb_build_object(
    'reportingSource', 'google_sheet',
    'latestRun', coalesce((
      select to_jsonb(latest_run) from latest_run
    ), '{}'::jsonb),
    'qualityChecks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'status', status,
          'checkCount', check_count,
          'checks', checks
        )
        order by status
      )
      from latest_quality
    ), '[]'::jsonb),
    'latestReportDates', jsonb_build_object(
      'dailyTicketMetrics', (select max(report_date) from public.daily_ticket_metrics),
      'dailyDistributionMetrics', (select max(report_date) from public.daily_distribution_metrics),
      'agentProductivity', (select max(report_date) from public.agent_productivity),
      'ticketDriverMetrics', (select max(report_date) from public.ticket_driver_metrics)
    )
  );
$$;


ALTER FUNCTION "public"."get_dashboard_reporting_status"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_dashboard_reporting_status"() IS 'Returns the latest Google Sheet synchronization and data-quality status.';



CREATE OR REPLACE FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text" DEFAULT NULL::"text", "p_platform_key" "text" DEFAULT NULL::"text", "p_country_key" "text" DEFAULT NULL::"text", "p_driver_key" "text" DEFAULT NULL::"text", "p_agent_key" "text" DEFAULT NULL::"text", "p_priority" "text" DEFAULT NULL::"text", "p_channel" "text" DEFAULT NULL::"text", "p_time_zone" "text" DEFAULT 'America/New_York'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_result jsonb;
  v_time_zone text;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'sla_response_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'sla_response_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'sla_response_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'sla_response_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  with
  bounds as materialized (
    select
      p_start_date::timestamp at time zone v_time_zone as range_start,
      (p_end_date + 1)::timestamp at time zone v_time_zone as range_end
  ),
  sla_state as materialized (
    select last_success_at
    from public.zendesk_sync_state
    where stream_key = 'ticket_metric_events'
  ),
  created_tickets as materialized (
    select ticket_id, min(event_timestamp) as created_at
    from public.ticket_events
    where event_type = 'created'
    group by ticket_id
  ),
  event_dimensions as materialized (
    select
      event.ticket_id,
      (array_agg(
        event.agent_key
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.agent_key is not null
          and event.event_type in ('created', 'assigned')
      ))[1] as agent_key,
      (array_agg(
        event.priority
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.priority is not null
          and event.event_type in ('created', 'priority_changed')
      ))[1] as priority,
      (array_agg(
        event.channel
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.channel is not null
          and event.event_type = 'created'
      ))[1] as channel
    from public.ticket_events as event
    cross join bounds
    where event.event_timestamp < bounds.range_end
    group by event.ticket_id
  ),
  eligible_tickets as materialized (
    select
      created.ticket_id,
      created.created_at,
      dimensions.agent_key,
      profile.app_key,
      profile.platform_key,
      profile.country_key,
      profile.driver_key,
      dimensions.priority,
      dimensions.channel
    from created_tickets as created
    cross join bounds
    left join public.ticket_dimension_profiles as profile
      on profile.ticket_id = created.ticket_id
    left join event_dimensions as dimensions
      on dimensions.ticket_id = created.ticket_id
    where created.created_at < bounds.range_end
  ),
  selected_tickets as materialized (
    select *
    from eligible_tickets
    where (
      nullif(btrim(p_app_key), '') is null or
      app_key = lower(btrim(p_app_key))
    )
      and (
        nullif(btrim(p_platform_key), '') is null or
        platform_key = lower(btrim(p_platform_key))
      )
      and (
        nullif(btrim(p_country_key), '') is null or
        country_key = lower(btrim(p_country_key))
      )
      and (
        nullif(btrim(p_driver_key), '') is null or
        driver_key = lower(btrim(p_driver_key))
      )
      and (
        nullif(btrim(p_agent_key), '') is null or
        agent_key = lower(btrim(p_agent_key))
      )
      and (
        nullif(btrim(p_priority), '') is null or
        priority = lower(btrim(p_priority))
      )
      and (
        nullif(btrim(p_channel), '') is null or
        channel = lower(btrim(p_channel))
      )
  ),
  period_created as materialized (
    select selected.*
    from selected_tickets as selected
    cross join bounds
    where selected.created_at >= bounds.range_start
      and selected.created_at < bounds.range_end
  ),
  response_events as materialized (
    select
      event.ticket_id,
      event.event_timestamp,
      case
        when event.metadata ->> 'calendar_minutes'
          ~ '^[0-9]+([.][0-9]+)?$'
        then (event.metadata ->> 'calendar_minutes')::numeric
        else null
      end as calendar_minutes,
      case
        when event.metadata ->> 'business_minutes'
          ~ '^[0-9]+([.][0-9]+)?$'
        then (event.metadata ->> 'business_minutes')::numeric
        else null
      end as business_minutes
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type = 'first_response'
      and event.event_timestamp >= bounds.range_start
      and event.event_timestamp < bounds.range_end
  ),
  lifecycle_events as materialized (
    select
      event.ticket_id,
      event.source_event_id,
      event.event_timestamp,
      event.event_type in ('solved', 'closed') as is_terminal,
      case event.event_type
        when 'status_changed' then 1
        when 'reopened' then 2
        when 'solved' then 3
        when 'closed' then 4
        else 0
      end as state_order
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type in (
      'status_changed',
      'reopened',
      'solved',
      'closed'
    )
      and event.event_timestamp < bounds.range_end
  ),
  current_state as materialized (
    select distinct on (selected.ticket_id)
      selected.ticket_id,
      selected.created_at,
      lifecycle.event_timestamp,
      coalesce(lifecycle.is_terminal, false) as is_terminal
    from selected_tickets as selected
    left join lifecycle_events as lifecycle using (ticket_id)
    order by
      selected.ticket_id,
      lifecycle.event_timestamp desc nulls last,
      lifecycle.state_order desc nulls last,
      lifecycle.source_event_id desc nulls last
  ),
  resolved_tickets as materialized (
    select
      ticket_id,
      event_timestamp as resolution_at,
      round(
        extract(epoch from (event_timestamp - created_at))::numeric / 60.0,
        2
      ) as resolution_minutes
    from current_state
    cross join bounds
    where is_terminal = true
      and event_timestamp >= bounds.range_start
      and event_timestamp < bounds.range_end
      and event_timestamp >= created_at
  ),
  sla_events as materialized (
    select
      event.ticket_id,
      event.event_timestamp,
      coalesce(nullif(event.metadata ->> 'metric', ''), 'unknown') as metric
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type = 'sla_breached'
      and event.event_timestamp >= bounds.range_start
      and event.event_timestamp < bounds.range_end
  ),
  date_spine as materialized (
    select day_value::date as report_date
    from generate_series(
      p_start_date::timestamp,
      p_end_date::timestamp,
      interval '1 day'
    ) as day_value
  ),
  trend_rows as materialized (
    select
      dates.report_date,
      (
        select round(avg(response.calendar_minutes), 2)
        from response_events as response
        where (response.event_timestamp at time zone v_time_zone)::date =
          dates.report_date
      ) as first_response_minutes,
      (
        select round(avg(resolved.resolution_minutes), 2)
        from resolved_tickets as resolved
        where (resolved.resolution_at at time zone v_time_zone)::date =
          dates.report_date
      ) as resolution_minutes,
      case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (
          select count(*)::bigint
          from sla_events as breach
          where (breach.event_timestamp at time zone v_time_zone)::date =
            dates.report_date
        )
        else null::bigint
      end as sla_breaches
    from date_spine as dates
  ),
  response_bucket_rows as materialized (
    select bucket_key, bucket_label, bucket_order, count(*)::bigint as ticket_count
    from (
      select
        case
          when calendar_minutes < 15 then 'under_15m'
          when calendar_minutes < 60 then '15m_to_1h'
          when calendar_minutes < 240 then '1h_to_4h'
          when calendar_minutes < 1440 then '4h_to_24h'
          else 'over_24h'
        end as bucket_key,
        case
          when calendar_minutes < 15 then 'Under 15 minutes'
          when calendar_minutes < 60 then '15 minutes to 1 hour'
          when calendar_minutes < 240 then '1 to 4 hours'
          when calendar_minutes < 1440 then '4 to 24 hours'
          else 'Over 24 hours'
        end as bucket_label,
        case
          when calendar_minutes < 15 then 1
          when calendar_minutes < 60 then 2
          when calendar_minutes < 240 then 3
          when calendar_minutes < 1440 then 4
          else 5
        end as bucket_order
      from response_events
      where calendar_minutes is not null
    ) as bucketed
    group by bucket_key, bucket_label, bucket_order
  ),
  resolution_bucket_rows as materialized (
    select bucket_key, bucket_label, bucket_order, count(*)::bigint as ticket_count
    from (
      select
        case
          when resolution_minutes < 60 then 'under_1h'
          when resolution_minutes < 240 then '1h_to_4h'
          when resolution_minutes < 1440 then '4h_to_24h'
          when resolution_minutes < 2880 then '1d_to_2d'
          else 'over_2d'
        end as bucket_key,
        case
          when resolution_minutes < 60 then 'Under 1 hour'
          when resolution_minutes < 240 then '1 to 4 hours'
          when resolution_minutes < 1440 then '4 to 24 hours'
          when resolution_minutes < 2880 then '1 to 2 days'
          else 'Over 2 days'
        end as bucket_label,
        case
          when resolution_minutes < 60 then 1
          when resolution_minutes < 240 then 2
          when resolution_minutes < 1440 then 3
          when resolution_minutes < 2880 then 4
          else 5
        end as bucket_order
      from resolved_tickets
    ) as bucketed
    group by bucket_key, bucket_label, bucket_order
  ),
  sla_metric_rows as materialized (
    select
      metric as metric_key,
      initcap(replace(metric, '_', ' ')) as metric_label,
      count(*)::bigint as breach_count
    from sla_events
    group by metric
  ),
  option_source as materialized (
    select 'app'::text as dimension_type, app_key as dimension_key,
      initcap(replace(app_key, '_', ' ')) as dimension_label, ticket_id
    from eligible_tickets where app_key is not null
    union all
    select 'platform', platform_key,
      initcap(replace(platform_key, '_', ' ')), ticket_id
    from eligible_tickets where platform_key is not null
    union all
    select 'country', country_key, upper(country_key), ticket_id
    from eligible_tickets where country_key is not null
    union all
    select 'driver', driver_key,
      initcap(replace(driver_key, '_', ' ')), ticket_id
    from eligible_tickets where driver_key is not null
    union all
    select 'agent', agent_key,
      'Agent ' || replace(agent_key, 'zendesk:', ''), ticket_id
    from eligible_tickets where agent_key is not null
    union all
    select 'priority', priority,
      initcap(replace(priority, '_', ' ')), ticket_id
    from eligible_tickets where priority is not null
    union all
    select 'channel', channel,
      initcap(replace(channel, '_', ' ')), ticket_id
    from eligible_tickets where channel is not null
  ),
  option_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      count(distinct ticket_id)::bigint as ticket_count
    from option_source
    group by dimension_type, dimension_key, dimension_label
  ),
  option_json as (
    select coalesce(jsonb_object_agg(dimension_type, items), '{}'::jsonb) as data
    from (
      select
        dimension_type,
        jsonb_agg(
          jsonb_build_object(
            'key', dimension_key,
            'label', dimension_label,
            'ticket_count', ticket_count
          )
          order by dimension_label
        ) as items
      from option_rows
      group by dimension_type
    ) as grouped
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'readiness', jsonb_build_object(
      'slaAvailable', exists (
        select 1 from sla_state where last_success_at is not null
      ),
      'slaLastSyncAt', (
        select last_success_at from sla_state limit 1
      )
    ),
    'summary', jsonb_build_object(
      'tickets_created', (select count(*)::bigint from period_created),
      'responded_tickets', (
        select count(distinct ticket_id)::bigint from response_events
        where calendar_minutes is not null
      ),
      'avg_first_response_calendar_minutes', (
        select round(avg(calendar_minutes), 2) from response_events
      ),
      'median_first_response_calendar_minutes', (
        select round((percentile_cont(0.5) within group (
          order by calendar_minutes
        ))::numeric, 2)
        from response_events
        where calendar_minutes is not null
      ),
      'p90_first_response_calendar_minutes', (
        select round((percentile_cont(0.9) within group (
          order by calendar_minutes
        ))::numeric, 2)
        from response_events
        where calendar_minutes is not null
      ),
      'avg_first_response_business_minutes', (
        select round(avg(business_minutes), 2) from response_events
      ),
      'resolved_tickets', (
        select count(*)::bigint from resolved_tickets
      ),
      'avg_resolution_minutes', (
        select round(avg(resolution_minutes), 2) from resolved_tickets
      ),
      'median_resolution_minutes', (
        select round((percentile_cont(0.5) within group (
          order by resolution_minutes
        ))::numeric, 2)
        from resolved_tickets
      ),
      'p90_resolution_minutes', (
        select round((percentile_cont(0.9) within group (
          order by resolution_minutes
        ))::numeric, 2)
        from resolved_tickets
      ),
      'sla_breaches', case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (select count(*)::bigint from sla_events)
        else null::bigint
      end,
      'sla_breached_tickets', case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (select count(distinct ticket_id)::bigint from sla_events)
        else null::bigint
      end
    ),
    'trend', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'report_date', report_date,
          'first_response_minutes', first_response_minutes,
          'resolution_minutes', resolution_minutes,
          'sla_breaches', sla_breaches
        )
        order by report_date
      )
      from trend_rows
    ), '[]'::jsonb),
    'responseBuckets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', bucket_key,
          'label', bucket_label,
          'ticket_count', ticket_count
        )
        order by bucket_order
      )
      from response_bucket_rows
    ), '[]'::jsonb),
    'resolutionBuckets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', bucket_key,
          'label', bucket_label,
          'ticket_count', ticket_count
        )
        order by bucket_order
      )
      from resolution_bucket_rows
    ), '[]'::jsonb),
    'slaMetrics', case
      when exists (
        select 1 from sla_state where last_success_at is not null
      ) then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', metric_key,
            'label', metric_label,
            'breach_count', breach_count
          )
          order by breach_count desc, metric_label
        )
        from sla_metric_rows
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'options', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'agent', '[]'::jsonb,
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from option_json)
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$_$;


ALTER FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") IS 'Returns filtered Zendesk first-response, resolution-time, and trusted SLA-breach reporting.';



CREATE OR REPLACE FUNCTION "public"."get_unresolved_zendesk_agent_ids"("p_limit" integer DEFAULT 100) RETURNS TABLE("zendesk_user_id" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  select distinct
    substring(event.agent_key from '^zendesk:([0-9]+)$')::bigint
      as zendesk_user_id
  from public.ticket_events as event
  left join public.zendesk_agent_directory as directory
    on directory.agent_key = event.agent_key
  where event.agent_key ~ '^zendesk:[0-9]+$'
    and (
      directory.agent_key is null
      or directory.updated_at < now() - interval '7 days'
    )
  order by zendesk_user_id
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$_$;


ALTER FUNCTION "public"."get_unresolved_zendesk_agent_ids"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_unresolved_zendesk_agent_ids"("p_limit" integer) IS 'Returns missing or stale Zendesk user IDs for server-side directory refresh.';



CREATE OR REPLACE FUNCTION "public"."normalize_agent_productivity_aht_unit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.aht_unit := 'minutes.seconds';
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_agent_productivity_aht_unit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date" DEFAULT NULL::"date", "p_end_date" "date" DEFAULT NULL::"date") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_event_id bigint;
  v_dataset text := lower(btrim(coalesce(p_dataset, '')));
  v_actor text := coalesce(auth.jwt() ->> 'email', current_user);
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and (
      auth.uid() is null
      or not public.workforce_is_admin()
      or not public.workforce_has_permission('view_workforce_reports')
    ) then
    raise exception 'reporting_operations_admin_required'
      using errcode = '42501';
  end if;

  if v_dataset <> all (array[
    'daily_ticket_metrics',
    'daily_distribution_metrics',
    'agent_productivity',
    'ticket_driver_metrics',
    'agent_dimension_metrics',
    'dashboard_sync_runs',
    'dashboard_data_quality_results',
    'dashboard_alert_events',
    'dashboard_audit_events'
  ]) then
    raise exception 'dashboard_export_dataset_invalid';
  end if;

  if coalesce(p_row_count, -1) < 0 then
    raise exception 'dashboard_export_row_count_invalid';
  end if;

  if p_start_date is not null
    and p_end_date is not null
    and p_start_date > p_end_date then
    raise exception 'dashboard_export_date_range_invalid';
  end if;

  insert into public.dashboard_audit_events (
    event_key,
    event_type,
    severity,
    title,
    details,
    actor_email,
    metadata
  ) values (
    'export:' || md5(clock_timestamp()::text || random()::text || v_dataset),
    'csv_export',
    'info',
    'CSV export created',
    concat(coalesce(p_row_count, 0), ' rows were exported from ', v_dataset, '.'),
    v_actor,
    jsonb_build_object(
      'dataset', v_dataset,
      'rowCount', coalesce(p_row_count, 0),
      'startDate', p_start_date,
      'endDate', p_end_date,
      'reportingSource', 'google_sheet'
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;


ALTER FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date", "p_end_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date", "p_end_date" "date") IS 'Records a Reporting Operations CSV export after verifying administrator scope and view_workforce_reports.';



CREATE OR REPLACE FUNCTION "public"."record_dashboard_quality_operations"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_severity text := case when new.status = 'fail' then 'error' else 'warning' end;
begin
  insert into public.dashboard_audit_events (
    event_key,
    event_type,
    severity,
    title,
    details,
    sync_run_id,
    metadata,
    created_at
  ) values (
    'quality:' || new.sync_run_id || ':' || new.check_key,
    'quality_check',
    case
      when new.status = 'fail' then 'error'
      when new.status = 'warning' then 'warning'
      else 'info'
    end,
    'Data-quality check: ' || new.check_key,
    new.details,
    new.sync_run_id,
    jsonb_build_object(
      'checkKey', new.check_key,
      'status', new.status,
      'observedValue', new.observed_value
    ),
    new.checked_at
  )
  on conflict (event_key) do nothing;

  update public.dashboard_alert_events
  set status = 'resolved',
      resolved_at = new.checked_at
  where alert_type = 'quality_check'
    and status = 'open'
    and metadata ->> 'checkKey' = new.check_key
    and sync_run_id is distinct from new.sync_run_id;

  if new.status in ('warning', 'fail') then
    insert into public.dashboard_alert_events (
      alert_key,
      alert_type,
      severity,
      status,
      title,
      message,
      sync_run_id,
      metadata,
      created_at
    ) values (
      'quality:' || new.sync_run_id || ':' || new.check_key,
      'quality_check',
      v_severity,
      'open',
      case when new.status = 'fail'
        then 'Data-quality check failed'
        else 'Data-quality warning'
      end,
      coalesce(new.details, 'A synchronized reporting quality check needs review.'),
      new.sync_run_id,
      jsonb_build_object(
        'checkKey', new.check_key,
        'status', new.status,
        'observedValue', new.observed_value
      ),
      new.checked_at
    )
    on conflict (alert_key) do update
    set severity = excluded.severity,
        status = 'open',
        resolved_at = null,
        message = excluded.message,
        metadata = excluded.metadata;
  else
    update public.dashboard_alert_events
    set status = 'resolved',
        resolved_at = new.checked_at
    where alert_type = 'quality_check'
      and status = 'open'
      and metadata ->> 'checkKey' = new.check_key;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."record_dashboard_quality_operations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_dashboard_sync_operations"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_run_id text := new.id::text;
  v_success boolean := new.status = 'success';
begin
  if new.status not in ('success', 'failed') then
    return new;
  end if;

  insert into public.dashboard_audit_events (
    event_key,
    event_type,
    severity,
    title,
    details,
    sync_run_id,
    metadata,
    created_at
  ) values (
    'sync:' || v_run_id || ':' || new.status,
    case when v_success then 'sync_success' else 'sync_failure' end,
    case when v_success then 'info' else 'error' end,
    case when v_success
      then 'Google Sheet synchronization completed'
      else 'Google Sheet synchronization failed'
    end,
    case when v_success
      then concat(coalesce(new.rows_imported, 0), ' reporting rows were imported.')
      else coalesce(new.error_message, 'The synchronization failed without an error message.')
    end,
    v_run_id,
    jsonb_build_object(
      'status', new.status,
      'reportDate', new.report_date,
      'rowsImported', coalesce(new.rows_imported, 0),
      'qualityStatus', new.quality_status,
      'syncSource', new.sync_source,
      'reportingSource', new.reporting_source
    ),
    coalesce(new.completed_at, now())
  )
  on conflict (event_key) do nothing;

  if v_success then
    update public.dashboard_alert_events
    set status = 'resolved',
        resolved_at = coalesce(new.completed_at, now())
    where alert_type = 'sync_failure'
      and status = 'open';
  else
    insert into public.dashboard_alert_events (
      alert_key,
      alert_type,
      severity,
      status,
      title,
      message,
      sync_run_id,
      metadata,
      created_at
    ) values (
      'sync_failure:' || v_run_id,
      'sync_failure',
      'error',
      'open',
      'Dashboard synchronization failed',
      coalesce(new.error_message, 'The synchronized Google Sheet import failed.'),
      v_run_id,
      jsonb_build_object(
        'reportDate', new.report_date,
        'syncSource', new.sync_source,
        'reportingSource', new.reporting_source
      ),
      coalesce(new.completed_at, now())
    )
    on conflict (alert_key) do update
    set status = 'open',
        resolved_at = null,
        message = excluded.message,
        metadata = excluded.metadata;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."record_dashboard_sync_operations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_sheet_sync_quality_results"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sync_run_id text := new.id::text;
  v_daily_count bigint;
  v_distribution_count bigint;
  v_productivity_count bigint;
  v_driver_count bigint;
  v_daily_latest date;
  v_distribution_latest date;
  v_productivity_latest date;
  v_driver_latest date;
  v_quality_status text;
begin
  if new.status not in ('success', 'failed') then
    return new;
  end if;

  delete from public.dashboard_data_quality_results
  where sync_run_id = v_sync_run_id;

  if new.status = 'failed' then
    insert into public.dashboard_data_quality_results (
      sync_run_id,
      check_key,
      status,
      observed_value,
      details
    ) values (
      v_sync_run_id,
      'sync_execution',
      'fail',
      jsonb_build_object('status', new.status),
      coalesce(new.error_message, 'The Google Sheet synchronization failed.')
    );

    update public.sheet_sync_runs
    set quality_status = 'fail',
        reporting_source = 'google_sheet'
    where id = new.id;

    return new;
  end if;

  select count(*), max(report_date)
  into v_daily_count, v_daily_latest
  from public.daily_ticket_metrics;

  select count(*), max(report_date)
  into v_distribution_count, v_distribution_latest
  from public.daily_distribution_metrics;

  select count(*), max(report_date)
  into v_productivity_count, v_productivity_latest
  from public.agent_productivity;

  select count(*), max(report_date)
  into v_driver_count, v_driver_latest
  from public.ticket_driver_metrics;

  insert into public.dashboard_data_quality_results (
    sync_run_id,
    check_key,
    status,
    observed_value,
    details
  ) values
  (
    v_sync_run_id,
    'rows_imported',
    case when coalesce(new.rows_imported, 0) > 0 then 'pass' else 'fail' end,
    jsonb_build_object('rowsImported', coalesce(new.rows_imported, 0)),
    'A successful synchronization must import at least one reporting row.'
  ),
  (
    v_sync_run_id,
    'latest_report_date',
    case when new.report_date is not null then 'pass' else 'fail' end,
    jsonb_build_object('reportDate', new.report_date),
    'A successful synchronization must identify the latest Google Sheet report date.'
  ),
  (
    v_sync_run_id,
    'source_tables_populated',
    case
      when v_daily_count > 0
       and v_distribution_count > 0
       and v_productivity_count > 0
       and v_driver_count > 0
      then 'pass'
      else 'fail'
    end,
    jsonb_build_object(
      'dailyTicketMetrics', v_daily_count,
      'dailyDistributionMetrics', v_distribution_count,
      'agentProductivity', v_productivity_count,
      'ticketDriverMetrics', v_driver_count
    ),
    'All four Google Sheet reporting tables must contain synchronized rows.'
  ),
  (
    v_sync_run_id,
    'source_table_latest_dates',
    case
      when new.report_date is not null
       and v_daily_latest = new.report_date
       and v_distribution_latest = new.report_date
       and v_productivity_latest = new.report_date
       and v_driver_latest = new.report_date
      then 'pass'
      else 'warning'
    end,
    jsonb_build_object(
      'syncReportDate', new.report_date,
      'dailyTicketMetrics', v_daily_latest,
      'dailyDistributionMetrics', v_distribution_latest,
      'agentProductivity', v_productivity_latest,
      'ticketDriverMetrics', v_driver_latest
    ),
    'The latest reporting date should match across all synchronized Google Sheet tables.'
  );

  select case
    when exists (
      select 1
      from public.dashboard_data_quality_results
      where sync_run_id = v_sync_run_id
        and status = 'fail'
    ) then 'fail'
    when exists (
      select 1
      from public.dashboard_data_quality_results
      where sync_run_id = v_sync_run_id
        and status = 'warning'
    ) then 'warning'
    else 'pass'
  end
  into v_quality_status;

  update public.sheet_sync_runs
  set quality_status = v_quality_status,
      reporting_source = 'google_sheet'
  where id = new.id;

  return new;
end;
$$;


ALTER FUNCTION "public"."record_sheet_sync_quality_results"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_daily_operations_metrics"("p_start_date" "date" DEFAULT NULL::"date", "p_end_date" "date" DEFAULT NULL::"date", "p_time_zone" "text" DEFAULT 'America/New_York'::"text") RETURNS TABLE("refresh_start_date" "date", "refresh_end_date" "date", "rows_upserted" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
$_$;


ALTER FUNCTION "public"."refresh_daily_operations_metrics"("p_start_date" "date", "p_end_date" "date", "p_time_zone" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."refresh_daily_operations_metrics"("p_start_date" "date", "p_end_date" "date", "p_time_zone" "text") IS 'Refreshes daily operational metrics using materialized ticket-state intervals.';



CREATE OR REPLACE FUNCTION "public"."release_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.zendesk_sync_state
  set
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where stream_key = p_stream_key
    and lease_token = p_lock_token;

  return found;
end;
$$;


ALTER FUNCTION "public"."release_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_article_update_metadata"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  actor_name text;
begin
  select nullif(trim(login.name), '')
  into actor_name
  from public.login as login
  where lower(login.email) = lower(
    coalesce(auth.jwt() ->> 'email', '')
  )
  limit 1;

  new.updated_at := timezone('utc', now());
  new.updated_by_name := coalesce(
    actor_name,
    nullif(trim(new.updated_by_name), ''),
    nullif(trim(new.author_name), ''),
    'Unknown user'
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."set_article_update_metadata"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_ticket_dimension_profiles"("p_profiles" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  affected_rows integer := 0;
begin
  if p_profiles is null or jsonb_typeof(p_profiles) <> 'array' then
    raise exception 'ticket_dimension_profiles_array_required';
  end if;

  with parsed_profiles as (
    select
      profile.ticket_id,
      nullif(btrim(profile.app_key), '') as app_key,
      nullif(btrim(profile.platform_key), '') as platform_key,
      nullif(btrim(profile.country_key), '') as country_key,
      nullif(btrim(profile.concern_key), '') as concern_key,
      profile.source_updated_at,
      coalesce(nullif(btrim(profile.source_system), ''), 'zendesk') as source_system,
      coalesce(nullif(btrim(profile.source_record_type), ''), 'ticket') as source_record_type,
      coalesce(
        nullif(btrim(profile.source_record_id), ''),
        profile.ticket_id::text
      ) as source_record_id,
      coalesce(
        nullif(btrim(profile.profile_version), ''),
        'zendesk-custom-fields-v2'
      ) as profile_version,
      case
        when profile.metadata is null then '{}'::jsonb
        when jsonb_typeof(profile.metadata) = 'object' then profile.metadata
        else '{}'::jsonb
      end as metadata
    from jsonb_to_recordset(p_profiles) as profile (
      ticket_id bigint,
      app_key text,
      platform_key text,
      country_key text,
      concern_key text,
      source_updated_at timestamptz,
      source_system text,
      source_record_type text,
      source_record_id text,
      profile_version text,
      metadata jsonb
    )
    where profile.ticket_id is not null
      and profile.ticket_id > 0
  ),
  upserted as (
    insert into public.ticket_dimension_profiles (
      ticket_id,
      app_key,
      platform_key,
      country_key,
      concern_key,
      source_updated_at,
      source_system,
      source_record_type,
      source_record_id,
      profile_version,
      metadata,
      synced_at,
      updated_at
    )
    select
      ticket_id,
      app_key,
      platform_key,
      country_key,
      concern_key,
      source_updated_at,
      source_system,
      source_record_type,
      source_record_id,
      profile_version,
      metadata,
      now(),
      now()
    from parsed_profiles
    on conflict (ticket_id) do update
    set
      app_key = excluded.app_key,
      platform_key = excluded.platform_key,
      country_key = excluded.country_key,
      concern_key = excluded.concern_key,
      source_updated_at = excluded.source_updated_at,
      source_system = excluded.source_system,
      source_record_type = excluded.source_record_type,
      source_record_id = excluded.source_record_id,
      profile_version = excluded.profile_version,
      metadata = excluded.metadata,
      synced_at = now(),
      updated_at = now()
    where public.ticket_dimension_profiles.source_updated_at is null
       or (
         excluded.source_updated_at is not null
         and excluded.source_updated_at >= public.ticket_dimension_profiles.source_updated_at
       )
    returning 1
  )
  select count(*)::integer
  into affected_rows
  from upserted;

  return affected_rows;
end;
$$;


ALTER FUNCTION "public"."upsert_ticket_dimension_profiles"("p_profiles" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."upsert_ticket_dimension_profiles"("p_profiles" "jsonb") IS 'Upserts current ticket-dimension profiles using concern_key without rewriting immutable ticket lifecycle events.';



CREATE OR REPLACE FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid" DEFAULT NULL::"uuid", "p_supervisor_id" "uuid" DEFAULT NULL::"uuid", "p_timezone" "text" DEFAULT 'Asia/Manila'::"text", "p_permissions" "jsonb" DEFAULT '{}'::"jsonb", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_profile public.profiles%rowtype;
  v_base_role text;
  v_is_agent boolean;
  v_can_edit_articles boolean;
  v_can_manage_payroll boolean;
  v_permission_key text;
  v_is_granted boolean;
  v_existing_grant boolean;
  v_permissions jsonb := '{}'::jsonb;
  v_normalized_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_normalized_employee_id text := nullif(trim(coalesce(p_employee_id, '')), '');
  v_normalized_timezone text := coalesce(nullif(trim(coalesce(p_timezone, '')), ''), 'Asia/Manila');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'Employee user ID is required.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_normalized_name is null then
    raise exception 'Full name is required.';
  end if;

  if v_normalized_employee_id is null then
    raise exception 'Employee ID is required.';
  end if;

  if p_employment_status not in ('active', 'on_leave', 'inactive', 'terminated') then
    raise exception 'Invalid employment status.';
  end if;

  case p_access_type
    when 'admin_agent' then
      v_base_role := 'admin';
      v_is_agent := true;
      v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
    when 'admin' then
      v_base_role := 'admin';
      v_is_agent := false;
      v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
    when 'agent_editor' then
      v_base_role := 'agent';
      v_is_agent := true;
      v_can_edit_articles := true;
    when 'regular_agent' then
      v_base_role := 'agent';
      v_is_agent := true;
      v_can_edit_articles := false;
    else
      raise exception 'Invalid access type.';
  end case;

  v_can_manage_payroll := coalesce((p_permissions ->> 'manage_payroll')::boolean, false);

  if p_team_id is not null and not exists (
    select 1 from public.teams team where team.id = p_team_id
  ) then
    raise exception 'Selected team does not exist.';
  end if;

  if p_supervisor_id = p_user_id then
    raise exception 'An employee cannot supervise their own profile.';
  end if;

  if p_supervisor_id is not null and not exists (
    select 1
    from public.profiles supervisor
    where supervisor.user_id = p_supervisor_id
      and supervisor.employment_status in ('active', 'on_leave')
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  if p_user_id = auth.uid() and (
    v_base_role <> 'admin'
    or coalesce((p_permissions ->> 'manage_employees')::boolean, false) is false
    or p_employment_status not in ('active', 'on_leave')
  ) then
    raise exception 'You cannot remove your own active administrator and employee-management access.';
  end if;

  update public.profiles
  set full_name = v_normalized_name,
      employee_id = v_normalized_employee_id,
      employment_status = p_employment_status,
      base_role = v_base_role,
      is_agent = v_is_agent,
      team_id = p_team_id,
      supervisor_id = p_supervisor_id,
      can_edit_articles = v_can_edit_articles,
      can_manage_payroll = v_can_manage_payroll,
      timezone = v_normalized_timezone,
      updated_at = now()
  where user_id = p_user_id
  returning * into v_profile;

  update public.login
  set name = v_profile.full_name,
      is_admin = v_profile.base_role = 'admin',
      can_edit_articles = v_can_edit_articles
  where lower(email) = lower(v_profile.email);

  foreach v_permission_key in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'correct_attendance',
    'approve_attendance',
    'approve_leave',
    'view_workforce_reports',
    'edit_articles',
    'manage_payroll'
  ] loop
    v_existing_grant := false;

    select permission.is_granted
    into v_existing_grant
    from public.user_permissions permission
    where permission.user_id = p_user_id
      and permission.permission_key = v_permission_key;

    if v_permission_key in ('correct_attendance', 'approve_attendance')
       and not (v_base_role = 'admin' or v_profile.is_system_admin is true) then
      v_is_granted := false;
    elsif v_profile.is_system_admin is true then
      v_is_granted := true;
    elsif v_permission_key = 'edit_articles' then
      v_is_granted := v_can_edit_articles;
    elsif v_permission_key = 'manage_payroll' then
      v_is_granted := v_can_manage_payroll;
    elsif p_permissions ? v_permission_key then
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    else
      v_is_granted := coalesce(v_existing_grant, false);
    end if;

    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      granted_by,
      reason
    ) values (
      p_user_id,
      v_permission_key,
      v_is_granted,
      auth.uid(),
      coalesce(v_reason, 'Updated through workforce employee administration')
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();

    v_permissions := v_permissions || jsonb_build_object(v_permission_key, v_is_granted);
  end loop;

  return jsonb_build_object(
    'profile', to_jsonb(v_profile),
    'permissions', v_permissions,
    'access_type', p_access_type
  );
end;
$$;


ALTER FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid", "p_supervisor_id" "uuid", "p_timezone" "text", "p_permissions" "jsonb", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid", "p_supervisor_id" "uuid", "p_timezone" "text", "p_permissions" "jsonb", "p_reason" "text") IS 'Atomically updates an employee profile, explicit attendance permissions, other workforce permissions, and legacy compatibility fields.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."work_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "team_id" "uuid",
    "shift_date" "date" NOT NULL,
    "shift_sequence" smallint DEFAULT 1 NOT NULL,
    "shift_start" timestamp with time zone,
    "shift_end" timestamp with time zone,
    "timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "is_rest_day" boolean DEFAULT false NOT NULL,
    "is_holiday" boolean DEFAULT false NOT NULL,
    "holiday_name" "text",
    "notes" "text",
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "work_schedules_sequence_positive" CHECK (("shift_sequence" > 0)),
    CONSTRAINT "work_schedules_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'published'::"text", 'changed'::"text", 'cancelled'::"text", 'completed'::"text"]))),
    CONSTRAINT "work_schedules_time_check" CHECK (((("is_rest_day" IS TRUE) AND ("shift_start" IS NULL) AND ("shift_end" IS NULL)) OR (("is_rest_day" IS FALSE) AND ("shift_start" IS NOT NULL) AND ("shift_end" IS NOT NULL) AND ("shift_end" > "shift_start"))))
);


ALTER TABLE "public"."work_schedules" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_admin_save_schedule"("p_schedule_id" "uuid", "p_user_id" "uuid", "p_shift_date" "date", "p_shift_sequence" integer, "p_shift_start" timestamp with time zone, "p_shift_end" timestamp with time zone, "p_timezone" "text", "p_status" "text", "p_is_rest_day" boolean, "p_is_holiday" boolean, "p_holiday_name" "text", "p_notes" "text") RETURNS "public"."work_schedules"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_existing public.work_schedules%rowtype;
  v_result public.work_schedules%rowtype;
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'Asia/Manila');
  v_status text := coalesce(nullif(trim(p_status), ''), 'scheduled');
  v_holiday_name text := nullif(trim(coalesce(p_holiday_name, '')), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_is_rest_day boolean := coalesce(p_is_rest_day, false);
  v_is_holiday boolean := coalesce(p_is_holiday, false);
  v_has_meaningful_change boolean := false;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if p_user_id is null or p_shift_date is null then
    raise exception 'Employee and shift date are required.';
  end if;

  if not public.workforce_can_manage_user(p_user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee schedule.';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_profile.is_agent is not true then
    raise exception 'Schedules can only be assigned to profiles with agent access.';
  end if;

  if v_profile.employment_status not in ('active', 'on_leave') then
    raise exception 'Schedules can only be assigned to active or on-leave employees.';
  end if;

  if p_shift_sequence is null or p_shift_sequence < 1 or p_shift_sequence > 99 then
    raise exception 'Shift sequence must be between 1 and 99.';
  end if;

  if v_status not in ('scheduled', 'published', 'changed', 'cancelled', 'completed') then
    raise exception 'Invalid schedule status.';
  end if;

  perform now() at time zone v_timezone;

  if v_is_rest_day then
    if p_shift_start is not null or p_shift_end is not null then
      raise exception 'Rest days cannot contain shift start or end times.';
    end if;
  else
    if p_shift_start is null or p_shift_end is null then
      raise exception 'Shift start and end times are required.';
    end if;

    if p_shift_end <= p_shift_start then
      raise exception 'Shift end must be later than shift start.';
    end if;

    if (p_shift_start at time zone v_timezone)::date <> p_shift_date then
      raise exception 'Shift start must fall on the selected shift date in the employee timezone.';
    end if;
  end if;

  if v_is_holiday and v_holiday_name is null then
    raise exception 'Holiday name is required when marking a holiday.';
  end if;

  if not v_is_holiday then
    v_holiday_name := null;
  end if;

  if p_schedule_id is not null then
    select * into v_existing
    from public.work_schedules
    where id = p_schedule_id
    for update;

    if not found then
      raise exception 'Schedule entry not found.';
    end if;

    if not public.workforce_can_manage_user(v_existing.user_id, 'manage_schedules') then
      raise exception 'You do not have permission to modify the existing schedule owner.';
    end if;
  end if;

  if exists (
    select 1
    from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date = p_shift_date
      and schedule.shift_sequence = p_shift_sequence
      and (p_schedule_id is null or schedule.id <> p_schedule_id)
  ) then
    raise exception 'This employee already has the selected shift sequence on that date.';
  end if;

  if p_schedule_id is null then
    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, is_rest_day, is_holiday, holiday_name, notes,
      created_by, updated_by
    ) values (
      p_user_id,
      v_profile.team_id,
      p_shift_date,
      p_shift_sequence::smallint,
      case when v_is_rest_day then null else p_shift_start end,
      case when v_is_rest_day then null else p_shift_end end,
      v_timezone,
      v_status,
      v_is_rest_day,
      v_is_holiday,
      v_holiday_name,
      v_notes,
      v_actor,
      v_actor
    ) returning * into v_result;
  else
    v_has_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from p_shift_sequence::smallint
      or v_existing.shift_start is distinct from p_shift_start
      or v_existing.shift_end is distinct from p_shift_end
      or v_existing.timezone is distinct from v_timezone
      or v_existing.is_rest_day is distinct from v_is_rest_day
      or v_existing.is_holiday is distinct from v_is_holiday
      or v_existing.holiday_name is distinct from v_holiday_name;

    if v_existing.status in ('published', 'changed')
       and v_status = 'published'
       and v_has_meaningful_change then
      v_status := 'changed';
    end if;

    update public.work_schedules
    set user_id = p_user_id,
        team_id = v_profile.team_id,
        shift_date = p_shift_date,
        shift_sequence = p_shift_sequence::smallint,
        shift_start = case when v_is_rest_day then null else p_shift_start end,
        shift_end = case when v_is_rest_day then null else p_shift_end end,
        timezone = v_timezone,
        status = v_status,
        is_rest_day = v_is_rest_day,
        is_holiday = v_is_holiday,
        holiday_name = v_holiday_name,
        notes = v_notes,
        updated_by = v_actor
    where id = p_schedule_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."workforce_admin_save_schedule"("p_schedule_id" "uuid", "p_user_id" "uuid", "p_shift_date" "date", "p_shift_sequence" integer, "p_shift_start" timestamp with time zone, "p_shift_end" timestamp with time zone, "p_timezone" "text", "p_status" "text", "p_is_rest_day" boolean, "p_is_holiday" boolean, "p_holiday_name" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_audit_row_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_before jsonb;
  v_after jsonb;
  v_entity_id uuid;
  v_actor uuid;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    v_before := null;
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
    v_after := null;
  end if;

  v_entity_id := nullif(coalesce(v_after, v_before) ->> tg_argv[0], '')::uuid;

  v_actor := coalesce(
    auth.uid(),
    nullif(v_after ->> 'updated_by', '')::uuid,
    nullif(v_after ->> 'corrected_by', '')::uuid,
    nullif(v_after ->> 'reviewed_by', '')::uuid,
    nullif(v_after ->> 'created_by', '')::uuid
  );

  v_reason := coalesce(
    nullif(v_after ->> 'correction_reason', ''),
    nullif(v_after ->> 'review_notes', ''),
    nullif(v_after ->> 'reason', '')
  );

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor,
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    v_before,
    v_after,
    v_reason
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_audit_row_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer DEFAULT 1200) RETURNS TABLE("pre_shift_overtime_minutes" integer, "regular_minutes" integer, "post_shift_overtime_minutes" integer, "total_overtime_minutes" integer, "total_worked_minutes" integer, "minutes_late" integer, "undertime_minutes" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    calculation.pre_shift_overtime_minutes,
    calculation.regular_minutes,
    calculation.post_shift_overtime_minutes,
    calculation.total_overtime_minutes,
    calculation.total_worked_minutes,
    calculation.minutes_late,
    calculation.undertime_minutes
  from public.workforce_calculate_attendance(
    p_scheduled_start,
    p_scheduled_end,
    p_clock_in,
    p_clock_out,
    p_scheduled_work_date,
    p_timezone,
    p_available_overtime_minutes,
    false,
    false
  ) calculation;
$$;


ALTER FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer) IS 'Classifies effective attendance timestamps into credited pre-shift overtime, regular time, credited post-shift overtime, total worked time, lateness, and undertime.';



CREATE OR REPLACE FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer, "p_is_rest_day" boolean, "p_is_holiday" boolean) RETURNS TABLE("pre_shift_overtime_minutes" integer, "regular_minutes" integer, "post_shift_overtime_minutes" integer, "rest_day_overtime_minutes" integer, "holiday_overtime_minutes" integer, "total_overtime_minutes" integer, "total_worked_minutes" integer, "minutes_late" integer, "undertime_minutes" integer)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_available_overtime_minutes integer;
  v_raw_pre_shift_minutes integer := 0;
  v_raw_post_shift_minutes integer := 0;
  v_credited_special_minutes integer := 0;
  v_has_schedule_times boolean;
  v_is_special_day boolean;
begin
  if p_clock_in is null then
    raise exception 'Clock-in is required for attendance calculation.';
  end if;

  if p_scheduled_work_date is null then
    raise exception 'Scheduled work date is required for attendance calculation.';
  end if;

  if nullif(trim(coalesce(p_timezone, '')), '') is null
     or not exists (
       select 1
       from pg_catalog.pg_timezone_names timezone_row
       where timezone_row.name = p_timezone
     ) then
    raise exception 'A valid IANA timezone is required for attendance calculation.';
  end if;

  if (p_scheduled_start is null) <> (p_scheduled_end is null) then
    raise exception 'Scheduled start and end must both be supplied or both be null.';
  end if;

  v_has_schedule_times := p_scheduled_start is not null;
  v_is_special_day := coalesce(p_is_rest_day, false) or coalesce(p_is_holiday, false);

  if v_has_schedule_times then
    if p_scheduled_end <= p_scheduled_start then
      raise exception 'Scheduled end must be later than scheduled start.';
    end if;

    if (p_scheduled_start at time zone p_timezone)::date <> p_scheduled_work_date then
      raise exception 'Scheduled start does not match the scheduled work date in the supplied timezone.';
    end if;
  end if;

  if p_clock_out is not null and p_clock_out < p_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  v_available_overtime_minutes := least(
    1200,
    greatest(0, coalesce(p_available_overtime_minutes, 0))
  );

  total_worked_minutes := case
    when p_clock_out is null then 0
    else floor(extract(epoch from (p_clock_out - p_clock_in)) / 60)::integer
  end;

  pre_shift_overtime_minutes := 0;
  regular_minutes := 0;
  post_shift_overtime_minutes := 0;
  rest_day_overtime_minutes := 0;
  holiday_overtime_minutes := 0;
  total_overtime_minutes := 0;
  minutes_late := 0;
  undertime_minutes := 0;

  if v_is_special_day then
    if p_clock_out is not null then
      v_credited_special_minutes := least(
        total_worked_minutes,
        v_available_overtime_minutes
      );

      if coalesce(p_is_rest_day, false) then
        rest_day_overtime_minutes := v_credited_special_minutes;
      else
        holiday_overtime_minutes := v_credited_special_minutes;
      end if;

      total_overtime_minutes := v_credited_special_minutes;
    end if;

    return next;
    return;
  end if;

  if not v_has_schedule_times then
    pre_shift_overtime_minutes := null;
    regular_minutes := null;
    post_shift_overtime_minutes := null;
    return next;
    return;
  end if;

  minutes_late := greatest(
    0,
    floor(extract(epoch from (p_clock_in - p_scheduled_start)) / 60)::integer
  );

  if p_clock_out is null then
    v_raw_pre_shift_minutes := greatest(
      0,
      floor(extract(epoch from (p_scheduled_start - p_clock_in)) / 60)::integer
    );

    pre_shift_overtime_minutes := least(
      v_raw_pre_shift_minutes,
      v_available_overtime_minutes
    );
    total_overtime_minutes := pre_shift_overtime_minutes;
    return next;
    return;
  end if;

  if p_clock_in < p_scheduled_start then
    v_raw_pre_shift_minutes := greatest(
      0,
      floor(
        extract(
          epoch from (least(p_clock_out, p_scheduled_start) - p_clock_in)
        ) / 60
      )::integer
    );
  end if;

  if p_clock_out > p_scheduled_end then
    v_raw_post_shift_minutes := greatest(
      0,
      floor(
        extract(
          epoch from (p_clock_out - greatest(p_clock_in, p_scheduled_end))
        ) / 60
      )::integer
    );
  end if;

  pre_shift_overtime_minutes := least(
    v_raw_pre_shift_minutes,
    v_available_overtime_minutes
  );

  post_shift_overtime_minutes := least(
    v_raw_post_shift_minutes,
    greatest(0, v_available_overtime_minutes - pre_shift_overtime_minutes)
  );

  total_overtime_minutes :=
    pre_shift_overtime_minutes + post_shift_overtime_minutes;

  regular_minutes := greatest(
    0,
    total_worked_minutes - v_raw_pre_shift_minutes - v_raw_post_shift_minutes
  );

  undertime_minutes := case
    when p_clock_out >= p_scheduled_end then 0
    else greatest(
      0,
      floor(
        extract(
          epoch from (
            p_scheduled_end - greatest(p_clock_out, p_scheduled_start)
          )
        ) / 60
      )::integer
    )
  end;

  return next;
end;
$$;


ALTER FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer, "p_is_rest_day" boolean, "p_is_holiday" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer, "p_is_rest_day" boolean, "p_is_holiday" boolean) IS 'Classifies normal shifts, rest-day work, and holiday work while enforcing the available overtime allowance.';



CREATE OR REPLACE FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_target_user_id is not null
    and exists (
      select 1
      from public.profiles target
      where target.user_id = p_target_user_id
    )
    and public.workforce_is_authorized_attendance_admin('approve_attendance');
$$;


ALTER FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") IS 'Authorizes attendance approval only for explicitly permitted administrators; payroll access does not imply approval.';



CREATE OR REPLACE FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_target_user_id is not null
    and exists (
      select 1
      from public.profiles target
      where target.user_id = p_target_user_id
    )
    and public.workforce_is_authorized_attendance_admin('correct_attendance');
$$;


ALTER FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") IS 'Authorizes attendance correction only for explicitly permitted administrators; supervisor scope alone is insufficient.';



CREATE OR REPLACE FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.workforce_has_permission(p_permission_key)
    and (
      public.workforce_is_admin()
      or public.workforce_is_assigned_supervisor(p_target_user_id)
    );
$$;


ALTER FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.workforce_is_current_identity(p_target_user_id)
    or public.workforce_can_manage_user(p_target_user_id, p_permission_key);
$$;


ALTER FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "leave_type" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "review_notes" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_requests_date_order" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "leave_requests_reason_not_blank" CHECK (("length"(TRIM(BOTH FROM "reason")) > 0)),
    CONSTRAINT "leave_requests_review_check" CHECK (((("status" = 'pending'::"text") AND ("reviewed_by" IS NULL) AND ("reviewed_at" IS NULL)) OR ("status" = 'cancelled'::"text") OR (("status" = ANY (ARRAY['approved'::"text", 'rejected'::"text"])) AND ("reviewed_by" IS NOT NULL) AND ("reviewed_at" IS NOT NULL)))),
    CONSTRAINT "leave_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "leave_requests_type_check" CHECK (("leave_type" = ANY (ARRAY['vacation'::"text", 'sick'::"text", 'emergency'::"text", 'unpaid'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."leave_requests" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  update public.leave_requests
  set status = 'cancelled',
      updated_at = now()
  where id = p_request_id
    and user_id = auth.uid()
    and status = 'pending'
  returning * into v_result;

  if not found then
    raise exception 'Only your own pending leave request can be cancelled.';
  end if;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "schedule_id" "uuid",
    "work_date" "date" NOT NULL,
    "clock_in" timestamp with time zone,
    "clock_out" timestamp with time zone,
    "attendance_status" "text" DEFAULT 'present'::"text" NOT NULL,
    "is_late" boolean DEFAULT false NOT NULL,
    "minutes_late" integer DEFAULT 0 NOT NULL,
    "overtime_minutes" integer DEFAULT 0 NOT NULL,
    "undertime_minutes" integer DEFAULT 0 NOT NULL,
    "correction_reason" "text",
    "admin_notes" "text",
    "corrected_by" "uuid",
    "corrected_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "original_clock_in" timestamp with time zone,
    "original_clock_out" timestamp with time zone,
    "pre_shift_overtime_minutes" integer,
    "regular_minutes" integer,
    "post_shift_overtime_minutes" integer,
    "total_overtime_minutes" integer DEFAULT 0 NOT NULL,
    "total_worked_minutes" integer DEFAULT 0 NOT NULL,
    "is_corrected" boolean DEFAULT false NOT NULL,
    "review_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "rest_day_overtime_minutes" integer DEFAULT 0 NOT NULL,
    "holiday_overtime_minutes" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "attendance_clock_order" CHECK ((("clock_out" IS NULL) OR (("clock_in" IS NOT NULL) AND ("clock_out" >= "clock_in")))),
    CONSTRAINT "attendance_nonnegative_minutes" CHECK ((("minutes_late" >= 0) AND ("overtime_minutes" >= 0) AND ("undertime_minutes" >= 0))),
    CONSTRAINT "attendance_original_clock_order_check" CHECK ((("original_clock_out" IS NULL) OR (("original_clock_in" IS NOT NULL) AND ("original_clock_out" >= "original_clock_in")))),
    CONSTRAINT "attendance_review_metadata_pair_check" CHECK (((("reviewed_by" IS NULL) AND ("reviewed_at" IS NULL)) OR (("reviewed_by" IS NOT NULL) AND ("reviewed_at" IS NOT NULL)))),
    CONSTRAINT "attendance_review_status_check" CHECK (("review_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'corrected'::"text", 'rejected'::"text", 'locked'::"text"]))),
    CONSTRAINT "attendance_status_check" CHECK (("attendance_status" = ANY (ARRAY['present'::"text", 'absent'::"text", 'on_leave'::"text", 'excused'::"text"]))),
    CONSTRAINT "attendance_structured_minutes_nonnegative" CHECK (((("pre_shift_overtime_minutes" IS NULL) OR ("pre_shift_overtime_minutes" >= 0)) AND (("regular_minutes" IS NULL) OR ("regular_minutes" >= 0)) AND (("post_shift_overtime_minutes" IS NULL) OR ("post_shift_overtime_minutes" >= 0)) AND ("rest_day_overtime_minutes" >= 0) AND ("holiday_overtime_minutes" >= 0) AND ("total_overtime_minutes" >= 0) AND ("total_worked_minutes" >= 0))),
    CONSTRAINT "attendance_structured_totals_check" CHECK (((("pre_shift_overtime_minutes" IS NULL) AND ("regular_minutes" IS NULL) AND ("post_shift_overtime_minutes" IS NULL) AND ("rest_day_overtime_minutes" = 0) AND ("holiday_overtime_minutes" = 0) AND ("total_overtime_minutes" = 0)) OR (("pre_shift_overtime_minutes" IS NOT NULL) AND ("regular_minutes" IS NOT NULL) AND ("post_shift_overtime_minutes" IS NOT NULL) AND ("total_overtime_minutes" = ((("pre_shift_overtime_minutes" + "post_shift_overtime_minutes") + "rest_day_overtime_minutes") + "holiday_overtime_minutes")) AND ("total_overtime_minutes" <= 1200) AND (("clock_out" IS NULL) OR ("total_worked_minutes" >= ("regular_minutes" + "total_overtime_minutes")))))),
    CONSTRAINT "attendance_total_overtime_legacy_match" CHECK (("total_overtime_minutes" = "overtime_minutes"))
);


ALTER TABLE "public"."attendance" OWNER TO "postgres";


COMMENT ON COLUMN "public"."attendance"."original_clock_in" IS 'First recorded clock-in. Immutable after capture; effective clock_in may be corrected later.';



COMMENT ON COLUMN "public"."attendance"."original_clock_out" IS 'First recorded clock-out. Immutable after capture; effective clock_out may be corrected later.';



COMMENT ON COLUMN "public"."attendance"."pre_shift_overtime_minutes" IS 'Credited worked minutes before the assigned shift start. Null means structured recalculation is still pending.';



COMMENT ON COLUMN "public"."attendance"."regular_minutes" IS 'Worked minutes overlapping the assigned scheduled shift. Null means structured recalculation is still pending.';



COMMENT ON COLUMN "public"."attendance"."post_shift_overtime_minutes" IS 'Credited worked minutes after the assigned shift end. Null means structured recalculation is still pending.';



COMMENT ON COLUMN "public"."attendance"."total_overtime_minutes" IS 'Credited pre-shift plus post-shift overtime. Kept compatible with legacy overtime_minutes.';



COMMENT ON COLUMN "public"."attendance"."total_worked_minutes" IS 'Elapsed effective clock-in to effective clock-out in whole minutes; zero while the session is open.';



COMMENT ON COLUMN "public"."attendance"."is_corrected" IS 'True when effective timestamps differ from captured originals or correction metadata exists.';



COMMENT ON COLUMN "public"."attendance"."review_status" IS 'Attendance review state: pending, approved, corrected, rejected, or locked.';



COMMENT ON COLUMN "public"."attendance"."reviewed_by" IS 'Workforce user that performed the latest attendance review.';



COMMENT ON COLUMN "public"."attendance"."reviewed_at" IS 'Timestamp of the latest attendance review.';



COMMENT ON COLUMN "public"."attendance"."rest_day_overtime_minutes" IS 'Credited worked minutes on a released rest-day schedule. Included in total_overtime_minutes and displayed as RDOT.';



COMMENT ON COLUMN "public"."attendance"."holiday_overtime_minutes" IS 'Credited worked minutes on a released holiday schedule that is not also a rest day. Included in total_overtime_minutes as normal overtime.';



CREATE OR REPLACE FUNCTION "public"."workforce_clock_in"("p_schedule_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."attendance"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_target_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_has_released_schedule boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
  v_is_special_day boolean := false;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select profile.timezone
  into v_timezone
  from public.profiles profile
  where profile.user_id = v_profile_user_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'America/New_York');
  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;
  v_target_user_id := v_profile_user_id;

  if exists (
    select 1
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
  ) then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1
      from public.work_schedules schedule
      where public.workforce_is_current_identity(schedule.user_id)
        and schedule.status in ('published', 'changed')
        and (
          (
            (schedule.is_rest_day or schedule.is_holiday)
            and (
              schedule.shift_date = v_local_date
              or (
                schedule.shift_date = v_local_date - 1
                and schedule.shift_end is not null
                and schedule.shift_end > v_clock_time
              )
            )
          )
          or (
            not schedule.is_rest_day
            and not schedule.is_holiday
            and schedule.shift_start is not null
            and schedule.shift_end is not null
            and schedule.shift_date between v_local_date - 1 and v_local_date + 1
            and schedule.shift_end > v_clock_time
          )
        )
    )
    into v_has_released_schedule;

    if v_has_released_schedule then
      raise exception 'A released shift or special work date is available. Select it before clocking in.';
    end if;
  else
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id
      and public.workforce_is_current_identity(schedule.user_id);

    if not found then
      raise exception 'The selected schedule does not belong to the current user.';
    end if;

    if v_schedule.status not in ('published', 'changed') then
      raise exception 'Clock-in is not available for this schedule.';
    end if;

    v_is_special_day := v_schedule.is_rest_day or v_schedule.is_holiday;

    if v_is_special_day then
      if not (
        v_schedule.shift_date = v_local_date
        or (
          v_schedule.shift_date = v_local_date - 1
          and v_schedule.shift_end is not null
          and v_schedule.shift_end > v_clock_time
        )
      ) then
        raise exception 'Rest-day and holiday clock-in is available only on the scheduled work date.';
      end if;
    else
      if v_schedule.shift_start is null or v_schedule.shift_end is null then
        raise exception 'The selected schedule does not have valid shift times.';
      end if;

      if v_schedule.shift_date < v_local_date - 1
         or v_schedule.shift_date > v_local_date + 1 then
        raise exception 'The selected schedule is outside the available attendance date range.';
      end if;

      if v_clock_time >= v_schedule.shift_end then
        raise exception 'This shift has already ended and is no longer available for clock-in.';
      end if;
    end if;

    v_work_date := v_schedule.shift_date;
    v_target_user_id := v_schedule.user_id;
  end if;

  if p_schedule_id is null then
    select attendance_row.*
    into v_existing
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.schedule_id is null
      and attendance_row.work_date = v_work_date
    order by attendance_row.created_at asc
    limit 1
    for update;
  else
    select attendance_row.*
    into v_existing
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.schedule_id = p_schedule_id
    order by attendance_row.created_at asc
    limit 1
    for update;
  end if;

  if found and v_existing.clock_in is not null then
    raise exception 'Attendance has already been recorded for this shift.';
  end if;

  if v_existing.id is not null then
    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
        work_date = v_work_date,
        attendance_status = 'present',
        created_by = coalesce(created_by, v_auth_user_id),
        updated_by = v_auth_user_id
    where id = v_existing.id
    returning * into v_result;
  else
    insert into public.attendance (
      user_id,
      schedule_id,
      work_date,
      clock_in,
      attendance_status,
      created_by,
      updated_by
    ) values (
      v_target_user_id,
      p_schedule_id,
      v_work_date,
      v_clock_time,
      'present',
      v_auth_user_id,
      v_auth_user_id
    )
    returning * into v_result;
  end if;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;


ALTER FUNCTION "public"."workforce_clock_in"("p_schedule_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_clock_out"() RETURNS "public"."attendance"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_clock_time timestamptz := now();
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select attendance_row.*
  into v_existing
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
  order by attendance_row.clock_in desc
  limit 1
  for update;

  if not found then
    raise exception 'No open attendance record was found.';
  end if;

  if v_clock_time < v_existing.clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  update public.attendance
  set clock_out = v_clock_time,
      updated_by = v_auth_user_id
  where id = v_existing.id
  returning * into v_result;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;


ALTER FUNCTION "public"."workforce_clock_out"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid" DEFAULT NULL::"uuid", "p_admin_notes" "text" DEFAULT NULL::"text", "p_reason_code" "text" DEFAULT NULL::"text", "p_reason_notes" "text" DEFAULT NULL::"text") RETURNS "public"."attendance"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_attendance public.attendance%rowtype;
  v_previous_calculations jsonb;
  v_new_calculations jsonb;
  v_schedule public.work_schedules%rowtype;
  v_current_profile public.profiles%rowtype;
  v_effective_clock_in timestamptz;
  v_effective_clock_out timestamptz;
  v_calculation record;
  v_work_date date;
  v_timezone text;
  v_available_overtime_minutes integer := 1200;
  v_result public.attendance%rowtype;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_new_status is null then
    raise exception 'Attendance status is required.';
  end if;

  if p_new_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'Attendance status is invalid.';
  end if;

  if p_new_clock_in is not null and p_new_clock_out is not null and p_new_clock_out < p_new_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  if p_reason_code is null then
    raise exception 'A correction reason is required.';
  end if;

  if p_reason_code not in (
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ) then
    raise exception 'Reason code is invalid.';
  end if;

  if p_reason_code = 'other' and length(trim(coalesce(p_reason_notes, ''))) = 0 then
    raise exception 'Written notes are required when reason is other.';
  end if;

  select profile.*
  into v_current_profile
  from public.profiles profile
  where profile.user_id = v_actor_user_id;

  if not found then
    raise exception 'Active workforce profile not found.';
  end if;

  if not public.workforce_can_correct_attendance(v_current_profile.user_id) then
    raise exception 'You do not have permission to correct attendance.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if p_schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id;

    if not found then
      raise exception 'The selected schedule does not exist.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'The schedule does not belong to the same employee.';
    end if;
  end if;

  v_work_date := coalesce(v_attendance.work_date, current_date);
  v_timezone := coalesce(v_current_profile.timezone, 'America/New_York');

  select jsonb_build_object(
    'pre_shift_overtime_minutes', coalesce(v_attendance.pre_shift_overtime_minutes, 0),
    'regular_minutes', coalesce(v_attendance.regular_minutes, 0),
    'post_shift_overtime_minutes', coalesce(v_attendance.post_shift_overtime_minutes, 0),
    'total_overtime_minutes', coalesce(v_attendance.total_overtime_minutes, 0),
    'total_worked_minutes', coalesce(v_attendance.total_worked_minutes, 0),
    'minutes_late', coalesce(v_attendance.minutes_late, 0),
    'undertime_minutes', coalesce(v_attendance.undertime_minutes, 0)
  )
  into v_previous_calculations;

  v_effective_clock_in := p_new_clock_in;
  v_effective_clock_out := p_new_clock_out;

  if v_attendance.schedule_id is not null then
    select *
    into v_calculation
    from public.workforce_calculate_attendance(
      v_schedule.shift_start,
      v_schedule.shift_end,
      v_effective_clock_in,
      v_effective_clock_out,
      v_attendance.work_date,
      v_timezone,
      v_available_overtime_minutes
    );

    v_new_calculations := jsonb_build_object(
      'pre_shift_overtime_minutes', coalesce(v_calculation.pre_shift_overtime_minutes, 0),
      'regular_minutes', coalesce(v_calculation.regular_minutes, 0),
      'post_shift_overtime_minutes', coalesce(v_calculation.post_shift_overtime_minutes, 0),
      'total_overtime_minutes', coalesce(v_calculation.total_overtime_minutes, 0),
      'total_worked_minutes', coalesce(v_calculation.total_worked_minutes, 0),
      'minutes_late', coalesce(v_calculation.minutes_late, 0),
      'undertime_minutes', coalesce(v_calculation.undertime_minutes, 0)
    );
  else
    v_new_calculations := jsonb_build_object(
      'pre_shift_overtime_minutes', null,
      'regular_minutes', null,
      'post_shift_overtime_minutes', null,
      'total_overtime_minutes', 0,
      'total_worked_minutes', coalesce(floor(extract(epoch from (v_effective_clock_out - v_effective_clock_in)) / 60)::integer, 0),
      'minutes_late', 0,
      'undertime_minutes', 0
    );
  end if;

  update public.attendance
  set
    clock_in = p_new_clock_in,
    clock_out = p_new_clock_out,
    attendance_status = p_new_status,
    schedule_id = coalesce(p_schedule_id, schedule_id),
    admin_notes = coalesce(nullif(trim(coalesce(p_admin_notes, '')),''), admin_notes),
    correction_reason = p_reason_code,
    corrected_by = v_actor_user_id,
    corrected_at = now(),
    review_status = 'corrected',
    reviewed_by = v_actor_user_id,
    reviewed_at = now(),
    is_corrected = true,
    pre_shift_overtime_minutes = coalesce((v_new_calculations ->> 'pre_shift_overtime_minutes')::integer, null),
    regular_minutes = coalesce((v_new_calculations ->> 'regular_minutes')::integer, null),
    post_shift_overtime_minutes = coalesce((v_new_calculations ->> 'post_shift_overtime_minutes')::integer, null),
    total_overtime_minutes = coalesce((v_new_calculations ->> 'total_overtime_minutes')::integer, 0),
    total_worked_minutes = coalesce((v_new_calculations ->> 'total_worked_minutes')::integer, 0),
    minutes_late = coalesce((v_new_calculations ->> 'minutes_late')::integer, 0),
    undertime_minutes = coalesce((v_new_calculations ->> 'undertime_minutes')::integer, 0),
    updated_by = v_actor_user_id,
    updated_at = now()
  where id = v_attendance.id
  returning * into v_result;

  insert into public.attendance_corrections (
    attendance_id,
    employee_user_id,
    schedule_id,
    previous_clock_in,
    previous_clock_out,
    new_clock_in,
    new_clock_out,
    previous_status,
    new_status,
    previous_calculations,
    new_calculations,
    reason_code,
    reason_notes,
    corrected_by,
    corrected_at
  )
  values (
    v_result.id,
    v_result.user_id,
    v_result.schedule_id,
    v_attendance.clock_in,
    v_attendance.clock_out,
    v_result.clock_in,
    v_result.clock_out,
    v_attendance.attendance_status,
    v_result.attendance_status,
    v_previous_calculations,
    jsonb_build_object(
      'pre_shift_overtime_minutes', coalesce(v_result.pre_shift_overtime_minutes, 0),
      'regular_minutes', coalesce(v_result.regular_minutes, 0),
      'post_shift_overtime_minutes', coalesce(v_result.post_shift_overtime_minutes, 0),
      'total_overtime_minutes', coalesce(v_result.total_overtime_minutes, 0),
      'total_worked_minutes', coalesce(v_result.total_worked_minutes, 0),
      'minutes_late', coalesce(v_result.minutes_late, 0),
      'undertime_minutes', coalesce(v_result.undertime_minutes, 0)
    ),
    p_reason_code,
    p_reason_notes,
    v_actor_user_id,
    now()
  );

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  )
  values (
    v_actor_user_id,
    'attendance_corrected',
    'attendance',
    v_result.id,
    jsonb_build_object(
      'attendance_id', v_attendance.id,
      'clock_in', v_attendance.clock_in,
      'clock_out', v_attendance.clock_out,
      'status', v_attendance.attendance_status
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'clock_in', v_result.clock_in,
      'clock_out', v_result.clock_out,
      'status', v_result.attendance_status,
      'reason_code', p_reason_code,
      'reason_notes', p_reason_notes,
      'review_status', v_result.review_status,
      'corrected_by', v_actor_user_id
    ),
    'attendance correction recorded'
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid", "p_admin_notes" "text", "p_reason_code" "text", "p_reason_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid", "p_admin_notes" "text", "p_reason_code" "text", "p_reason_notes" "text") IS 'Corrects effective attendance timestamps and status, preserves prior values, recalculates totals, and records structured correction history.';



CREATE OR REPLACE FUNCTION "public"."workforce_current_profile_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select profile.user_id
  from public.profiles profile
  where public.workforce_is_current_identity(profile.user_id)
  order by
    (profile.user_id = auth.uid()) desc,
    (lower(profile.email) = lower(coalesce(auth.jwt() ->> 'email', ''))) desc,
    profile.created_at asc
  limit 1;
$$;


ALTER FUNCTION "public"."workforce_current_profile_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_current_user_is_active"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.profiles profile
    where public.workforce_is_current_identity(profile.user_id)
      and profile.employment_status in ('active', 'on_leave')
  );
$$;


ALTER FUNCTION "public"."workforce_current_user_is_active"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_current_user_is_agent"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.workforce_current_user_is_active()
    and exists (
      select 1
      from public.profiles profile
      where public.workforce_is_current_identity(profile.user_id)
        and profile.employment_status in ('active', 'on_leave')
        and profile.is_agent is true
    );
$$;


ALTER FUNCTION "public"."workforce_current_user_is_agent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_enforce_admin_payroll_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.base_role = 'admin' or new.is_system_admin is true then
    new.can_manage_payroll := true;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_enforce_admin_payroll_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_get_current_access"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_is_active boolean;
  v_permissions jsonb;
  v_linked_profile_ids jsonb := '[]'::jsonb;
  v_legacy_is_admin boolean := false;
  v_legacy_can_edit boolean := false;
begin
  if v_auth_user_id is null then
    return null;
  end if;

  select profile.*
  into v_profile
  from public.profiles profile
  where public.workforce_is_current_identity(profile.user_id)
  order by
    (profile.user_id = v_auth_user_id) desc,
    (lower(profile.email) = lower(coalesce(auth.jwt() ->> 'email', ''))) desc,
    profile.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  v_is_active := public.workforce_current_user_is_active();

  select coalesce(jsonb_agg(profile.user_id order by profile.created_at), '[]'::jsonb)
  into v_linked_profile_ids
  from public.profiles profile
  where public.workforce_is_current_identity(profile.user_id);

  select jsonb_build_object(
    'manage_employees',
      v_is_active and coalesce(bool_or(permission_key = 'manage_employees' and is_granted), false),
    'manage_schedules',
      v_is_active and coalesce(bool_or(permission_key = 'manage_schedules' and is_granted), false),
    'view_team_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'view_team_attendance' and is_granted), false),
    'correct_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'correct_attendance' and is_granted), false),
    'approve_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'approve_attendance' and is_granted), false),
    'approve_leave',
      v_is_active and coalesce(bool_or(permission_key = 'approve_leave' and is_granted), false),
    'view_workforce_reports',
      v_is_active and coalesce(bool_or(permission_key = 'view_workforce_reports' and is_granted), false),
    'edit_articles',
      v_is_active and coalesce(bool_or(permission_key = 'edit_articles' and is_granted), false),
    'manage_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'manage_payroll' and is_granted), false)
  )
  into v_permissions
  from public.user_permissions permission
  where public.workforce_is_current_identity(permission.user_id);

  select
    coalesce((
      select login_user.is_admin
      from public.login login_user
      where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', v_profile.email))
      limit 1
    ), false),
    coalesce((
      select login_user.can_edit_articles
      from public.login login_user
      where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', v_profile.email))
      limit 1
    ), false)
  into v_legacy_is_admin, v_legacy_can_edit;

  return jsonb_build_object(
    'auth_user_id', v_auth_user_id,
    'user_id', v_profile.user_id,
    'linked_profile_ids', v_linked_profile_ids,
    'full_name', v_profile.full_name,
    'email', lower(coalesce(auth.jwt() ->> 'email', v_profile.email)),
    'employee_id', v_profile.employee_id,
    'employment_status', v_profile.employment_status,
    'is_active', v_is_active,
    'base_role', v_profile.base_role,
    'is_admin', public.workforce_is_admin(),
    'is_system_admin', exists (
      select 1
      from public.profiles linked_profile
      where public.workforce_is_current_identity(linked_profile.user_id)
        and linked_profile.is_system_admin is true
        and linked_profile.employment_status in ('active', 'on_leave')
    ),
    'is_agent', v_is_active and v_profile.is_agent,
    'team_id', v_profile.team_id,
    'supervisor_id', v_profile.supervisor_id,
    'timezone', v_profile.timezone,
    'permissions', v_permissions,
    'can_edit_articles', coalesce((v_permissions ->> 'edit_articles')::boolean, false),
    'can_manage_payroll', coalesce((v_permissions ->> 'manage_payroll')::boolean, false),
    'can_correct_attendance', coalesce((v_permissions ->> 'correct_attendance')::boolean, false),
    'can_approve_attendance', coalesce((v_permissions ->> 'approve_attendance')::boolean, false),
    'legacy', jsonb_build_object(
      'is_admin', v_legacy_is_admin,
      'can_edit_articles', v_legacy_can_edit
    )
  );
end;
$$;


ALTER FUNCTION "public"."workforce_get_current_access"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_get_current_access"() IS 'Returns the authenticated workforce profile and effective explicit permissions for shared browser and server authorization.';



CREATE OR REPLACE FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.workforce_current_user_is_active()
    and (
      exists (
        select 1
        from public.user_permissions permission
        where public.workforce_is_current_identity(permission.user_id)
          and permission.permission_key = p_permission_key
          and permission.is_granted is true
      )
      or (
        p_permission_key in (
          'manage_employees',
          'manage_schedules',
          'view_team_attendance',
          'approve_leave',
          'view_workforce_reports'
        )
        and public.workforce_is_admin()
      )
    );
$$;


ALTER FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.workforce_current_user_is_active()
    and (
      exists (
        select 1
        from public.profiles profile
        where public.workforce_is_current_identity(profile.user_id)
          and (
            profile.base_role = 'admin'
            or profile.is_system_admin is true
          )
      )
      or exists (
        select 1
        from public.login login_user
        where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
          and login_user.is_admin is true
      )
    );
$$;


ALTER FUNCTION "public"."workforce_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.profiles target
    left join public.teams team on team.id = target.team_id
    where target.user_id = p_target_user_id
      and (
        public.workforce_is_current_identity(target.supervisor_id)
        or public.workforce_is_current_identity(team.supervisor_id)
      )
  );
$$;


ALTER FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_permission_key in ('correct_attendance', 'approve_attendance')
    and public.workforce_current_user_is_active()
    and public.workforce_is_admin()
    and public.workforce_has_permission(p_permission_key);
$$;


ALTER FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") IS 'Returns true only for an active admin with the requested explicit attendance permission.';



CREATE OR REPLACE FUNCTION "public"."workforce_is_current_identity"("p_target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select auth.uid() is not null
    and p_target_user_id is not null
    and (
      p_target_user_id = auth.uid()
      or exists (
        select 1
        from public.workforce_identity_links identity_link
        where identity_link.auth_user_id = auth.uid()
          and identity_link.profile_user_id = p_target_user_id
          and identity_link.is_active is true
      )
    );
$$;


ALTER FUNCTION "public"."workforce_is_current_identity"("p_target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") RETURNS TABLE("attendance_id" "uuid", "employee_user_id" "uuid", "employee_name" "text", "employee_email" "text", "employee_id" "text", "employee_timezone" "text", "team_id" "uuid", "team_name" "text", "work_date" "date", "schedule_id" "uuid", "shift_sequence" smallint, "scheduled_start" timestamp with time zone, "scheduled_end" timestamp with time zone, "schedule_timezone" "text", "schedule_status" "text", "clock_in" timestamp with time zone, "clock_out" timestamp with time zone, "regular_minutes" integer, "pre_shift_overtime_minutes" integer, "post_shift_overtime_minutes" integer, "total_overtime_minutes" integer, "total_worked_minutes" integer, "minutes_late" integer, "undertime_minutes" integer, "attendance_status" "text", "is_corrected" boolean, "review_status" "text", "corrected_by" "uuid", "corrected_by_name" "text", "corrected_at" timestamp with time zone, "correction_reason" "text", "admin_notes" "text", "is_open" boolean, "is_missing_clock_out" boolean)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception 'You do not have permission to view team attendance.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id,
    attendance_row.user_id,
    employee.full_name,
    employee.email,
    employee.employee_id,
    employee.timezone,
    employee.team_id,
    employee_team.name,
    attendance_row.work_date,
    attendance_row.schedule_id,
    schedule.shift_sequence,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    schedule.status,
    attendance_row.clock_in,
    attendance_row.clock_out,
    attendance_row.regular_minutes,
    attendance_row.pre_shift_overtime_minutes,
    attendance_row.post_shift_overtime_minutes,
    attendance_row.total_overtime_minutes,
    attendance_row.total_worked_minutes,
    attendance_row.minutes_late,
    attendance_row.undertime_minutes,
    attendance_row.attendance_status,
    attendance_row.is_corrected,
    attendance_row.review_status,
    attendance_row.corrected_by,
    case
      when attendance_row.corrected_by is null then null
      when corrector.full_name is not null then corrector.full_name
      else 'Former workforce user'
    end,
    attendance_row.corrected_at,
    attendance_row.correction_reason,
    attendance_row.admin_notes,
    attendance_row.clock_in is not null and attendance_row.clock_out is null,
    attendance_row.clock_in is not null
      and attendance_row.clock_out is null
      and (
        (schedule.shift_end is not null and schedule.shift_end < now())
        or attendance_row.work_date < (
          now() at time zone coalesce(nullif(employee.timezone, ''), 'Asia/Manila')
        )::date
      )
  from public.attendance attendance_row
  join public.profiles employee
    on employee.user_id = attendance_row.user_id
  left join public.teams employee_team
    on employee_team.id = employee.team_id
  left join public.work_schedules schedule
    on schedule.id = attendance_row.schedule_id
  left join public.profiles corrector
    on corrector.user_id = attendance_row.corrected_by
  where attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(
      attendance_row.user_id,
      'view_team_attendance'
    )
  order by
    attendance_row.work_date desc,
    schedule.shift_start desc nulls last,
    attendance_row.clock_in desc nulls last,
    attendance_row.created_at desc;
end;
$$;


ALTER FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") IS 'Returns read-only, permission-scoped team attendance rows for the Step 10 Team Attendance page.';



CREATE OR REPLACE FUNCTION "public"."workforce_normalize_timezone_default"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.timezone is null
     or nullif(trim(new.timezone), '') is null
     or new.timezone = 'Asia/Manila' then
    new.timezone := 'America/New_York';
  end if;

  -- Reject invalid IANA timezone names before the row is stored.
  perform now() at time zone new.timezone;
  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_normalize_timezone_default"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_normalize_timezone_default"() IS 'Maps legacy Manila or blank workforce timezone values to America/New_York and validates other IANA zones.';



CREATE OR REPLACE FUNCTION "public"."workforce_prepare_attendance_storage"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_legacy_overtime_changed boolean := false;
  v_total_overtime_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.original_clock_in is null and new.clock_in is not null then
      new.original_clock_in := new.clock_in;
    end if;

    if new.original_clock_out is null and new.clock_out is not null then
      new.original_clock_out := new.clock_out;
    end if;

    if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then
      if new.total_overtime_minutes = 0 then
        new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
      elsif coalesce(new.overtime_minutes, 0) = 0 then
        new.overtime_minutes := new.total_overtime_minutes;
      else
        raise exception 'overtime_minutes and total_overtime_minutes must match.';
      end if;
    end if;
  else
    if old.original_clock_in is not null then
      if new.original_clock_in is distinct from old.original_clock_in then
        raise exception 'original_clock_in is immutable after capture.';
      end if;
    elsif old.clock_in is null and new.clock_in is not null then
      new.original_clock_in := new.clock_in;
    elsif new.original_clock_in is not null then
      raise exception 'original_clock_in cannot be supplied after the initial clock-in.';
    end if;

    if old.original_clock_out is not null then
      if new.original_clock_out is distinct from old.original_clock_out then
        raise exception 'original_clock_out is immutable after capture.';
      end if;
    elsif old.clock_out is null and new.clock_out is not null then
      new.original_clock_out := new.clock_out;
    elsif new.original_clock_out is not null then
      raise exception 'original_clock_out cannot be supplied after the initial clock-out.';
    end if;

    v_legacy_overtime_changed := new.overtime_minutes is distinct from old.overtime_minutes;
    v_total_overtime_changed := new.total_overtime_minutes is distinct from old.total_overtime_minutes;

    if v_legacy_overtime_changed and v_total_overtime_changed then
      if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then
        raise exception 'overtime_minutes and total_overtime_minutes must match.';
      end if;
    elsif v_legacy_overtime_changed then
      new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
    elsif v_total_overtime_changed then
      new.overtime_minutes := new.total_overtime_minutes;
    end if;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    if new.clock_out < new.clock_in then
      raise exception 'Clock-out cannot be earlier than clock-in.';
    end if;

    new.total_worked_minutes := floor(
      extract(epoch from (new.clock_out - new.clock_in)) / 60
    )::integer;
  else
    new.total_worked_minutes := 0;
  end if;

  new.is_corrected :=
    (
      new.original_clock_in is not null
      and new.clock_in is distinct from new.original_clock_in
    )
    or (
      new.original_clock_out is not null
      and new.clock_out is distinct from new.original_clock_out
    )
    or new.corrected_by is not null
    or new.corrected_at is not null
    or nullif(trim(coalesce(new.correction_reason, '')), '') is not null;

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_prepare_attendance_storage"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_recalculate_attendance"("p_attendance_id" "uuid") RETURNS "public"."attendance"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_user_id uuid;
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_other_overtime_minutes integer := 0;
  v_available_overtime_minutes integer := 1200;
  v_calculation record;
  v_result public.attendance%rowtype;
  v_is_special_day boolean := false;
begin
  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  select attendance_row.user_id
  into v_user_id
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text)::bigint);

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if exists (
    select 1
    from public.attendance attendance_row
    where attendance_row.user_id = v_attendance.user_id
      and attendance_row.id <> v_attendance.id
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
  ) then
    raise exception 'Only one attendance session may remain open at a time.';
  end if;

  if v_attendance.schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = v_attendance.schedule_id
    for share;

    if not found then
      raise exception 'The linked schedule no longer exists.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'Attendance employee does not match the linked schedule employee.';
    end if;

    v_is_special_day := v_schedule.is_rest_day or v_schedule.is_holiday;

    if not v_is_special_day
       and (v_schedule.shift_start is null or v_schedule.shift_end is null) then
      raise exception 'Normal attendance requires a complete scheduled shift.';
    end if;

    if v_attendance.work_date <> v_schedule.shift_date then
      raise exception 'Attendance work date must remain the linked schedule work date.';
    end if;

    if v_schedule.shift_start is not null
       and v_schedule.shift_end is not null
       and exists (
         select 1
         from public.attendance other_attendance
         join public.work_schedules other_schedule
           on other_schedule.id = other_attendance.schedule_id
         where other_attendance.user_id = v_attendance.user_id
           and other_attendance.work_date = v_attendance.work_date
           and other_attendance.id <> v_attendance.id
           and other_schedule.shift_start is not null
           and other_schedule.shift_end is not null
           and v_schedule.shift_start < other_schedule.shift_end
           and other_schedule.shift_start < v_schedule.shift_end
       ) then
      raise exception 'Attendance cannot be calculated for overlapping scheduled shifts.';
    end if;
  end if;

  select coalesce(
    sum(greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)),
    0
  )::integer
  into v_other_overtime_minutes
  from public.attendance attendance_row
  where attendance_row.user_id = v_attendance.user_id
    and attendance_row.work_date = v_attendance.work_date
    and attendance_row.id <> v_attendance.id;

  v_available_overtime_minutes := greatest(
    0,
    1200 - v_other_overtime_minutes
  );

  select *
  into v_calculation
  from public.workforce_calculate_attendance(
    case when v_attendance.schedule_id is null then null else v_schedule.shift_start end,
    case when v_attendance.schedule_id is null then null else v_schedule.shift_end end,
    v_attendance.clock_in,
    v_attendance.clock_out,
    v_attendance.work_date,
    case
      when v_attendance.schedule_id is null then
        coalesce(
          nullif(
            (
              select profile.timezone
              from public.profiles profile
              where profile.user_id = v_attendance.user_id
            ),
            ''
          ),
          'America/New_York'
        )
      else v_schedule.timezone
    end,
    v_available_overtime_minutes,
    case when v_attendance.schedule_id is null then false else v_schedule.is_rest_day end,
    case when v_attendance.schedule_id is null then false else v_schedule.is_holiday end
  );

  update public.attendance
  set pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,
      regular_minutes = v_calculation.regular_minutes,
      post_shift_overtime_minutes = v_calculation.post_shift_overtime_minutes,
      rest_day_overtime_minutes = v_calculation.rest_day_overtime_minutes,
      holiday_overtime_minutes = v_calculation.holiday_overtime_minutes,
      total_overtime_minutes = v_calculation.total_overtime_minutes,
      overtime_minutes = v_calculation.total_overtime_minutes,
      total_worked_minutes = v_calculation.total_worked_minutes,
      minutes_late = v_calculation.minutes_late,
      is_late = v_calculation.minutes_late > 0,
      undertime_minutes = v_calculation.undertime_minutes
  where id = v_attendance.id
  returning * into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."workforce_recalculate_attendance"("p_attendance_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_recalculate_attendance"("p_attendance_id" "uuid") IS 'Locks and recalculates one attendance record while enforcing the aggregate 1,200-minute overtime ceiling for the employee work date.';



CREATE OR REPLACE FUNCTION "public"."workforce_recalculate_attendance_work_date"("p_user_id" "uuid", "p_work_date" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_attendance_id uuid;
begin
  if p_user_id is null or p_work_date is null then
    raise exception 'Employee and work date are required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text)::bigint);

  update public.attendance
  set pre_shift_overtime_minutes = null,
      regular_minutes = null,
      post_shift_overtime_minutes = null,
      rest_day_overtime_minutes = 0,
      holiday_overtime_minutes = 0,
      total_overtime_minutes = 0,
      overtime_minutes = 0
  where user_id = p_user_id
    and work_date = p_work_date
    and schedule_id is not null;

  for v_attendance_id in
    select attendance_row.id
    from public.attendance attendance_row
    join public.work_schedules schedule
      on schedule.id = attendance_row.schedule_id
    where attendance_row.user_id = p_user_id
      and attendance_row.work_date = p_work_date
      and attendance_row.clock_in is not null
    order by
      schedule.shift_date,
      schedule.shift_sequence,
      schedule.shift_start nulls first,
      attendance_row.created_at
  loop
    perform public.workforce_recalculate_attendance(v_attendance_id);
  end loop;
end;
$$;


ALTER FUNCTION "public"."workforce_recalculate_attendance_work_date"("p_user_id" "uuid", "p_work_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_recalculate_attendance_work_date"("p_user_id" "uuid", "p_work_date" "date") IS 'Recalculates scheduled attendance records for one employee work date in shift order so the aggregate overtime ceiling is allocated consistently.';



CREATE OR REPLACE FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text" DEFAULT NULL::"text") RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_result public.leave_requests%rowtype;
  v_conflicting_attendance_count integer := 0;
  v_attendance_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if p_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected.';
  end if;

  select *
  into v_request
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Leave request not found.';
  end if;

  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave') then
    raise exception 'You do not have permission to review this leave request.';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending leave requests can be reviewed.';
  end if;

  if p_status = 'approved' then
    -- Never replace actual clock activity with leave. The reviewer must resolve the
    -- attendance conflict before the leave request can be approved.
    select count(*)
    into v_conflicting_attendance_count
    from public.attendance attendance_row
    where attendance_row.user_id = v_request.user_id
      and attendance_row.work_date between v_request.start_date and v_request.end_date
      and (
        attendance_row.clock_in is not null
        or attendance_row.clock_out is not null
        or attendance_row.total_worked_minutes > 0
      );

    if v_conflicting_attendance_count > 0 then
      raise exception 'Leave overlaps recorded attendance. Resolve the attendance record before approving leave.';
    end if;

    -- Create one payroll-visible leave attendance row for every released working
    -- shift. Rest days and holidays are intentionally excluded from leave usage.
    insert into public.attendance (
      user_id,
      schedule_id,
      work_date,
      attendance_status,
      review_status,
      reviewed_by,
      reviewed_at,
      admin_notes,
      created_by,
      updated_by
    )
    select
      schedule.user_id,
      schedule.id,
      schedule.shift_date,
      'on_leave',
      'approved',
      v_actor_user_id,
      now(),
      concat('Approved ', v_request.leave_type, ' leave request ', v_request.id::text),
      v_actor_user_id,
      v_actor_user_id
    from public.work_schedules schedule
    where schedule.user_id = v_request.user_id
      and schedule.shift_date between v_request.start_date and v_request.end_date
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
    on conflict (user_id, schedule_id) where schedule_id is not null
    do update set
      attendance_status = 'on_leave',
      review_status = 'approved',
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      admin_notes = excluded.admin_notes,
      is_late = false,
      minutes_late = 0,
      undertime_minutes = 0,
      updated_by = excluded.updated_by,
      updated_at = now()
    where attendance.clock_in is null
      and attendance.clock_out is null
      and attendance.total_worked_minutes = 0;

    get diagnostics v_attendance_count = row_count;
  end if;

  update public.leave_requests
  set status = p_status,
      review_notes = nullif(trim(coalesce(p_review_notes, '')), ''),
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_result;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  ) values (
    v_actor_user_id,
    'leave_request_reviewed',
    'leave_request',
    v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', v_result.status,
      'review_notes', v_result.review_notes,
      'attendance_records_marked_on_leave', v_attendance_count
    )
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text") IS 'Reviews pending leave and transactionally marks released working shifts as approved on-leave attendance without overwriting clock activity.';



CREATE OR REPLACE FUNCTION "public"."workforce_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_sync_admin_payroll_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_should_grant boolean;
begin
  v_should_grant := (
    new.base_role = 'admin'
    or new.is_system_admin is true
    or new.can_manage_payroll is true
  );

  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    reason
  ) values (
    new.user_id,
    'manage_payroll',
    v_should_grant,
    case
      when new.base_role = 'admin' or new.is_system_admin is true
        then 'Automatically granted to administrator'
      else 'Synchronized from profile payroll permission'
    end
  )
  on conflict (user_id, permission_key) do update
  set is_granted = excluded.is_granted,
      reason = excluded.reason,
      updated_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_sync_admin_payroll_permission"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_sync_identity_link_from_login"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_auth_user_id uuid;
  v_profile_user_id uuid;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(trim(auth_user.email)) = lower(trim(new.email))
  limit 1;

  select profile.user_id
  into v_profile_user_id
  from public.profiles profile
  where lower(trim(profile.email)) = lower(trim(new.email))
  limit 1;

  if v_auth_user_id is not null and v_profile_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id,
      profile_user_id,
      match_method,
      is_active
    ) values (
      v_auth_user_id,
      v_profile_user_id,
      case
        when v_auth_user_id = v_profile_user_id then 'auth_user_id'
        else 'exact_email'
      end,
      true
    )
    on conflict (auth_user_id, profile_user_id) do update
    set match_method = excluded.match_method,
        is_active = true,
        updated_at = now();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_sync_identity_link_from_login"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_sync_identity_link_from_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_auth_user_id uuid;
begin
  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where auth_user.id = new.user_id
     or lower(trim(auth_user.email)) = lower(trim(new.email))
  order by (auth_user.id = new.user_id) desc
  limit 1;

  update public.workforce_identity_links
  set is_active = false,
      updated_at = now()
  where profile_user_id = new.user_id
    and match_method = 'exact_email'
    and (v_auth_user_id is null or auth_user_id <> v_auth_user_id);

  if v_auth_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id, profile_user_id, match_method, is_active
    ) values (
      v_auth_user_id,
      new.user_id,
      case when v_auth_user_id = new.user_id then 'auth_user_id' else 'exact_email' end,
      true
    )
    on conflict (auth_user_id, profile_user_id) do update
    set match_method = excluded.match_method,
        is_active = true,
        updated_at = now();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_sync_identity_link_from_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_sync_login_record"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_user_id uuid;
  v_email text;
  v_name text;
  v_is_admin boolean;
  v_can_edit boolean;
  v_permission text;
begin
  if tg_op = 'DELETE' then
    update public.profiles
    set employment_status = 'inactive', updated_at = now()
    where lower(email) = lower(old.email);

    update public.user_permissions
    set is_granted = false,
        reason = 'Revoked because the compatibility login record was deleted',
        updated_at = now()
    where user_id in (
      select user_id
      from public.profiles
      where lower(email) = lower(old.email)
    )
    and permission_key in (
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles'
    );

    return old;
  end if;

  v_email := lower(trim(new.email));
  v_name := coalesce(nullif(trim(new.name), ''), split_part(v_email, '@', 1));
  v_is_admin := coalesce(new.is_admin, false);
  v_can_edit := coalesce(new.can_edit_articles, false);

  select id
  into v_user_id
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_user_id is null and tg_op = 'UPDATE' then
    select user_id
    into v_user_id
    from public.profiles
    where lower(email) in (lower(old.email), v_email)
    limit 1;
  end if;

  if v_user_id is null then
    return new;
  end if;

  insert into public.profiles (
    user_id,
    full_name,
    email,
    employee_id,
    employment_status,
    base_role,
    is_agent,
    is_system_admin,
    can_edit_articles,
    can_manage_payroll
  ) values (
    v_user_id,
    v_name,
    v_email,
    'SL-' || upper(substr(replace(v_user_id::text, '-', ''), 1, 8)),
    'active',
    case when v_is_admin then 'admin' else 'agent' end,
    true,
    false,
    v_can_edit,
    false
  )
  on conflict (user_id) do update
  set full_name = excluded.full_name,
      email = excluded.email,
      employment_status = case
        when public.profiles.employment_status in ('inactive', 'terminated')
          then 'active'
        else public.profiles.employment_status
      end,
      base_role = case
        when public.profiles.is_system_admin is true
          then public.profiles.base_role
        else excluded.base_role
      end,
      can_edit_articles = excluded.can_edit_articles,
      updated_at = now();

  foreach v_permission in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'approve_leave',
    'view_workforce_reports'
  ] loop
    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      reason
    ) values (
      v_user_id,
      v_permission,
      v_is_admin,
      'Synchronized from public.login.is_admin'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    reason
  ) values (
    v_user_id,
    'edit_articles',
    v_can_edit,
    'Synchronized from public.login.can_edit_articles'
  )
  on conflict (user_id, permission_key) do update
  set is_granted = excluded.is_granted,
      reason = excluded.reason,
      updated_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_sync_login_record"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."workforce_sync_profile_compatibility"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.login
  set is_admin = (new.base_role = 'admin' or new.is_system_admin is true),
      can_edit_articles = new.can_edit_articles,
      name = coalesce(nullif(trim(name), ''), new.full_name)
  where lower(email) = lower(new.email)
    and (
      is_admin is distinct from (new.base_role = 'admin' or new.is_system_admin is true)
      or can_edit_articles is distinct from new.can_edit_articles
      or nullif(trim(name), '') is null
    );

  return new;
end;
$$;


ALTER FUNCTION "public"."workforce_sync_profile_compatibility"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_dimension_metrics" (
    "report_date" "date" NOT NULL,
    "agent_key" "text" NOT NULL,
    "agent_name" "text" NOT NULL,
    "dimension_type" "text" NOT NULL,
    "dimension_key" "text" NOT NULL,
    "dimension_label" "text" NOT NULL,
    "ticket_count" bigint NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_dimension_metrics_values_check" CHECK ((("agent_key" ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'::"text") AND ("dimension_type" = ANY (ARRAY['app'::"text", 'platform'::"text", 'country'::"text", 'concern'::"text", 'priority'::"text", 'channel'::"text"])) AND ("dimension_key" ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'::"text") AND ("ticket_count" >= 0)))
);


ALTER TABLE "public"."agent_dimension_metrics" OWNER TO "postgres";


COMMENT ON TABLE "public"."agent_dimension_metrics" IS 'Reserved sheet-backed agent dimension table. It remains empty until the existing workbook supplies agent-level dimensions.';



CREATE TABLE IF NOT EXISTS "public"."agent_identity_map" (
    "agent_key" "text" NOT NULL,
    "agent_name" "text" NOT NULL,
    "zendesk_agent_key" "text",
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_identity_map_agent_key_check" CHECK (("agent_key" ~ '^[a-z0-9][a-z0-9_-]*$'::"text")),
    CONSTRAINT "agent_identity_map_agent_name_check" CHECK (("btrim"("agent_name") <> ''::"text"))
);


ALTER TABLE "public"."agent_identity_map" OWNER TO "postgres";


COMMENT ON TABLE "public"."agent_identity_map" IS 'Maps Google Sheet productivity agent keys to Zendesk directory agent keys for combined analytics.';



CREATE TABLE IF NOT EXISTS "public"."agent_productivity" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_date" "date" NOT NULL,
    "agent_key" "text" NOT NULL,
    "agent_name" "text" NOT NULL,
    "solved_tickets" integer NOT NULL,
    "open_tickets" integer,
    "aht_value" numeric,
    "aht_unit" "text" DEFAULT 'minutes.seconds'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "handled_tickets" bigint DEFAULT 0 NOT NULL,
    "handle_minutes_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "responded_tickets" bigint DEFAULT 0 NOT NULL,
    "first_response_minutes_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "first_response_median_minutes" numeric(12,2) DEFAULT 0 NOT NULL,
    "resolved_tickets" bigint DEFAULT 0 NOT NULL,
    "resolution_minutes_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "resolution_median_minutes" numeric(12,2) DEFAULT 0 NOT NULL,
    "reopened_tickets" bigint DEFAULT 0 NOT NULL,
    "one_touch_tickets" bigint DEFAULT 0 NOT NULL,
    "worked_hours" numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT "agent_productivity_step9_values_check" CHECK ((("handled_tickets" >= 0) AND ("handle_minutes_total" >= (0)::numeric) AND ("responded_tickets" >= 0) AND ("responded_tickets" <= "handled_tickets") AND ("first_response_minutes_total" >= (0)::numeric) AND ("first_response_median_minutes" >= (0)::numeric) AND ("resolved_tickets" >= 0) AND ("resolved_tickets" <= "handled_tickets") AND ("resolution_minutes_total" >= (0)::numeric) AND ("resolution_median_minutes" >= (0)::numeric) AND ("reopened_tickets" >= 0) AND ("one_touch_tickets" >= 0) AND ("one_touch_tickets" <= "resolved_tickets") AND ("worked_hours" >= (0)::numeric))),
    CONSTRAINT "agent_productivity_values_check" CHECK ((("solved_tickets" >= 0) AND (("open_tickets" IS NULL) OR ("open_tickets" >= 0)) AND (("aht_value" IS NULL) OR ("aht_value" >= (0)::numeric))))
);


ALTER TABLE "public"."agent_productivity" OWNER TO "postgres";


COMMENT ON COLUMN "public"."agent_productivity"."aht_value" IS 'Average handle time stored as decimal minutes and displayed as minutes:seconds.';



COMMENT ON COLUMN "public"."agent_productivity"."aht_unit" IS 'Confirmed AHT unit. The canonical value is minutes.seconds.';



COMMENT ON COLUMN "public"."agent_productivity"."handle_minutes_total" IS 'Total handle minutes from the normalized Ticket Productivity tab.';



COMMENT ON COLUMN "public"."agent_productivity"."worked_hours" IS 'Hours worked by the agent for the reporting date.';



CREATE TABLE IF NOT EXISTS "public"."articles" (
    "id" bigint NOT NULL,
    "title" "text" DEFAULT 'not null'::"text",
    "content" "text" DEFAULT 'not null'::"text",
    "author_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tag" "text" DEFAULT '''not null''::text'::"text",
    "published" boolean DEFAULT true NOT NULL,
    "description" "text" DEFAULT '''not null''::text'::"text",
    "image_url" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_by_name" "text",
    CONSTRAINT "articles_tag_check" CHECK (("tag" = ANY (ARRAY['tickets'::"text", 'cashouts'::"text"])))
);


ALTER TABLE "public"."articles" OWNER TO "postgres";


ALTER TABLE "public"."articles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."articles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."attendance_corrections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attendance_id" "uuid" NOT NULL,
    "employee_user_id" "uuid" NOT NULL,
    "schedule_id" "uuid",
    "previous_clock_in" timestamp with time zone,
    "previous_clock_out" timestamp with time zone,
    "new_clock_in" timestamp with time zone,
    "new_clock_out" timestamp with time zone,
    "previous_status" "text" NOT NULL,
    "new_status" "text" NOT NULL,
    "previous_calculations" "jsonb",
    "new_calculations" "jsonb",
    "reason_code" "text" NOT NULL,
    "reason_notes" "text",
    "corrected_by" "uuid" NOT NULL,
    "corrected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "attendance_corrections_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['forgot_clock_in'::"text", 'forgot_clock_out'::"text", 'system_issue'::"text", 'connection_issue'::"text", 'incorrect_schedule'::"text", 'approved_overtime'::"text", 'manager_confirmed'::"text", 'other'::"text"]))),
    CONSTRAINT "attendance_corrections_reason_notes_check" CHECK ((("reason_code" <> 'other'::"text") OR ("length"(TRIM(BOTH FROM COALESCE("reason_notes", ''::"text"))) > 0)))
);


ALTER TABLE "public"."attendance_corrections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_distribution_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_date" "date" NOT NULL,
    "dimension_type" "text" NOT NULL,
    "dimension_key" "text" NOT NULL,
    "dimension_label" "text" NOT NULL,
    "ticket_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "daily_distribution_metrics_dimension_type_check" CHECK (("dimension_type" = ANY (ARRAY['app'::"text", 'platform'::"text", 'country'::"text"]))),
    CONSTRAINT "daily_distribution_metrics_values_check" CHECK (("ticket_count" >= 0))
);


ALTER TABLE "public"."daily_distribution_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_operations_metrics" (
    "report_date" "date" NOT NULL,
    "report_timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "tickets_created" bigint DEFAULT 0 NOT NULL,
    "tickets_solved" bigint DEFAULT 0 NOT NULL,
    "backlog_open" bigint DEFAULT 0 NOT NULL,
    "backlog_over_24h" bigint DEFAULT 0 NOT NULL,
    "backlog_over_48h" bigint DEFAULT 0 NOT NULL,
    "first_response_minutes" numeric(14,2),
    "resolution_minutes" numeric(14,2),
    "sla_breaches" bigint,
    "reopened_tickets" bigint DEFAULT 0 NOT NULL,
    "csat_score" numeric(10,2),
    "calculated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_system" "text" DEFAULT 'ticket_events'::"text" NOT NULL,
    CONSTRAINT "daily_operations_metrics_backlog_open_check" CHECK (("backlog_open" >= 0)),
    CONSTRAINT "daily_operations_metrics_backlog_over_24h_check" CHECK (("backlog_over_24h" >= 0)),
    CONSTRAINT "daily_operations_metrics_backlog_over_48h_check" CHECK (("backlog_over_48h" >= 0)),
    CONSTRAINT "daily_operations_metrics_csat_score_check" CHECK ((("csat_score" IS NULL) OR ("csat_score" >= (0)::numeric))),
    CONSTRAINT "daily_operations_metrics_first_response_minutes_check" CHECK ((("first_response_minutes" IS NULL) OR ("first_response_minutes" >= (0)::numeric))),
    CONSTRAINT "daily_operations_metrics_reopened_tickets_check" CHECK (("reopened_tickets" >= 0)),
    CONSTRAINT "daily_operations_metrics_resolution_minutes_check" CHECK ((("resolution_minutes" IS NULL) OR ("resolution_minutes" >= (0)::numeric))),
    CONSTRAINT "daily_operations_metrics_sla_breaches_check" CHECK ((("sla_breaches" IS NULL) OR ("sla_breaches" >= 0))),
    CONSTRAINT "daily_operations_metrics_tickets_created_check" CHECK (("tickets_created" >= 0)),
    CONSTRAINT "daily_operations_metrics_tickets_solved_check" CHECK (("tickets_solved" >= 0))
);


ALTER TABLE "public"."daily_operations_metrics" OWNER TO "postgres";


COMMENT ON TABLE "public"."daily_operations_metrics" IS 'Daily operational metrics derived from normalized Zendesk ticket events.';



COMMENT ON COLUMN "public"."daily_operations_metrics"."first_response_minutes" IS 'Average calendar first-response minutes for responses occurring on report_date.';



COMMENT ON COLUMN "public"."daily_operations_metrics"."resolution_minutes" IS 'Average elapsed minutes from creation to the latest terminal lifecycle event for tickets finally resolved on report_date.';



COMMENT ON COLUMN "public"."daily_operations_metrics"."sla_breaches" IS 'Reserved for a trusted Zendesk SLA metric source; null until imported.';



COMMENT ON COLUMN "public"."daily_operations_metrics"."csat_score" IS 'Reserved for a trusted Zendesk CSAT source; null until imported.';



CREATE TABLE IF NOT EXISTS "public"."daily_ticket_metrics" (
    "id" bigint NOT NULL,
    "report_date" "date",
    "new_tickets" integer DEFAULT 0 NOT NULL,
    "solved_tickets" integer DEFAULT 0 NOT NULL,
    "unsolved_tickets" integer DEFAULT 0 NOT NULL,
    "one_touch_resolution" numeric(6,4) DEFAULT 0,
    "reopened_rate" numeric(6,4) DEFAULT 0,
    "total_ticket_concerns" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "responded_tickets" bigint DEFAULT 0 NOT NULL,
    "first_response_minutes_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "first_response_median_minutes" numeric(12,2) DEFAULT 0 NOT NULL,
    "resolved_tickets" bigint DEFAULT 0 NOT NULL,
    "resolution_minutes_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "resolution_median_minutes" numeric(12,2) DEFAULT 0 NOT NULL,
    "reopened_tickets" bigint DEFAULT 0 NOT NULL,
    "one_touch_tickets" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "daily_ticket_metrics_step9_values_check" CHECK ((("responded_tickets" >= 0) AND ("first_response_minutes_total" >= (0)::numeric) AND ("first_response_median_minutes" >= (0)::numeric) AND ("resolved_tickets" >= 0) AND ("resolution_minutes_total" >= (0)::numeric) AND ("resolution_median_minutes" >= (0)::numeric) AND ("reopened_tickets" >= 0) AND ("one_touch_tickets" >= 0) AND ("one_touch_tickets" <= "resolved_tickets"))),
    CONSTRAINT "daily_ticket_metrics_values_check" CHECK ((("new_tickets" >= 0) AND ("unsolved_tickets" >= 0) AND ("solved_tickets" >= 0) AND (("one_touch_resolution" >= (0)::numeric) AND ("one_touch_resolution" <= (1)::numeric)) AND (("reopened_rate" >= (0)::numeric) AND ("reopened_rate" <= (1)::numeric))))
);


ALTER TABLE "public"."daily_ticket_metrics" OWNER TO "postgres";


ALTER TABLE "public"."daily_ticket_metrics" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."daily_ticket_metrics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."dashboard_alert_events" (
    "id" bigint NOT NULL,
    "alert_key" "text" NOT NULL,
    "alert_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "sync_run_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "dashboard_alert_events_severity_check" CHECK (("severity" = ANY (ARRAY['warning'::"text", 'error'::"text"]))),
    CONSTRAINT "dashboard_alert_events_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'resolved'::"text"]))),
    CONSTRAINT "dashboard_alert_events_type_check" CHECK (("alert_type" = ANY (ARRAY['sync_failure'::"text", 'quality_check'::"text"])))
);


ALTER TABLE "public"."dashboard_alert_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_alert_events" IS 'Stored in-app reporting alerts generated from synchronization failures and data-quality warnings or failures.';



CREATE TABLE IF NOT EXISTS "public"."sheet_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "report_date" "date",
    "rows_imported" integer DEFAULT 0,
    "error_message" "text",
    "sync_source" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reporting_source" "text" DEFAULT 'google_sheet'::"text" NOT NULL,
    "quality_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    CONSTRAINT "sheet_sync_runs_quality_status_check" CHECK (("quality_status" = ANY (ARRAY['pending'::"text", 'pass'::"text", 'warning'::"text", 'fail'::"text"]))),
    CONSTRAINT "sheet_sync_runs_reporting_source_check" CHECK (("reporting_source" = 'google_sheet'::"text")),
    CONSTRAINT "valid_status" CHECK (("status" = ANY (ARRAY['running'::"text", 'success'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."sheet_sync_runs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dashboard_sync_runs" WITH ("security_invoker"='true') AS
 SELECT "id",
    "started_at",
    "completed_at",
    "status",
    "report_date",
    "rows_imported",
    "error_message",
    "sync_source",
    "reporting_source",
    "quality_status"
   FROM "public"."sheet_sync_runs";


ALTER VIEW "public"."dashboard_sync_runs" OWNER TO "postgres";


COMMENT ON VIEW "public"."dashboard_sync_runs" IS 'Google Sheet dashboard synchronization history exposed as the Phase 3 reporting run contract.';



CREATE OR REPLACE VIEW "public"."dashboard_active_alerts" WITH ("security_invoker"='true') AS
 WITH "latest_success" AS (
         SELECT ("dashboard_sync_runs"."id")::"text" AS "sync_run_id",
            "dashboard_sync_runs"."completed_at",
            "dashboard_sync_runs"."report_date"
           FROM "public"."dashboard_sync_runs"
          WHERE ("dashboard_sync_runs"."status" = 'success'::"text")
          ORDER BY "dashboard_sync_runs"."completed_at" DESC NULLS LAST
         LIMIT 1
        ), "stored_alerts" AS (
         SELECT "dashboard_alert_events"."alert_key",
            "dashboard_alert_events"."alert_type",
            "dashboard_alert_events"."severity",
            "dashboard_alert_events"."title",
            "dashboard_alert_events"."message",
            "dashboard_alert_events"."sync_run_id",
            "dashboard_alert_events"."metadata",
            "dashboard_alert_events"."created_at"
           FROM "public"."dashboard_alert_events"
          WHERE ("dashboard_alert_events"."status" = 'open'::"text")
        ), "stale_alert" AS (
         SELECT 'computed:stale_sync'::"text" AS "alert_key",
            'stale_sync'::"text" AS "alert_type",
            'warning'::"text" AS "severity",
            'Synchronized reporting data may be stale'::"text" AS "title",
                CASE
                    WHEN ("latest_success"."completed_at" IS NULL) THEN 'No completed Google Sheet synchronization is available.'::"text"
                    ELSE 'The latest successful Google Sheet synchronization completed more than 30 hours ago.'::"text"
                END AS "message",
            "latest_success"."sync_run_id",
            "jsonb_build_object"('completedAt', "latest_success"."completed_at", 'reportDate', "latest_success"."report_date", 'thresholdHours', 30) AS "metadata",
            COALESCE("latest_success"."completed_at", "now"()) AS "created_at"
           FROM "latest_success"
          WHERE (("latest_success"."completed_at" IS NULL) OR ("latest_success"."completed_at" < ("now"() - '30:00:00'::interval)))
        ), "missing_success" AS (
         SELECT 'computed:stale_sync'::"text" AS "alert_key",
            'stale_sync'::"text" AS "alert_type",
            'error'::"text" AS "severity",
            'No successful Google Sheet synchronization'::"text" AS "title",
            'Run syncAllDashboardData() and verify the protected dashboard synchronization endpoint.'::"text" AS "message",
            NULL::"text" AS "sync_run_id",
            "jsonb_build_object"('thresholdHours', 30) AS "metadata",
            "now"() AS "created_at"
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM "latest_success")))
        )
 SELECT "stored_alerts"."alert_key",
    "stored_alerts"."alert_type",
    "stored_alerts"."severity",
    "stored_alerts"."title",
    "stored_alerts"."message",
    "stored_alerts"."sync_run_id",
    "stored_alerts"."metadata",
    "stored_alerts"."created_at"
   FROM "stored_alerts"
UNION ALL
 SELECT "stale_alert"."alert_key",
    "stale_alert"."alert_type",
    "stale_alert"."severity",
    "stale_alert"."title",
    "stale_alert"."message",
    "stale_alert"."sync_run_id",
    "stale_alert"."metadata",
    "stale_alert"."created_at"
   FROM "stale_alert"
UNION ALL
 SELECT "missing_success"."alert_key",
    "missing_success"."alert_type",
    "missing_success"."severity",
    "missing_success"."title",
    "missing_success"."message",
    "missing_success"."sync_run_id",
    "missing_success"."metadata",
    "missing_success"."created_at"
   FROM "missing_success";


ALTER VIEW "public"."dashboard_active_alerts" OWNER TO "postgres";


COMMENT ON VIEW "public"."dashboard_active_alerts" IS 'Open stored alerts plus a computed stale-sync alert when no successful synchronization completed within 30 hours.';



CREATE SEQUENCE IF NOT EXISTS "public"."dashboard_alert_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dashboard_alert_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dashboard_alert_events_id_seq" OWNED BY "public"."dashboard_alert_events"."id";



CREATE TABLE IF NOT EXISTS "public"."dashboard_audit_events" (
    "id" bigint NOT NULL,
    "event_key" "text",
    "event_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "details" "text",
    "sync_run_id" "text",
    "actor_email" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dashboard_audit_events_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'error'::"text"]))),
    CONSTRAINT "dashboard_audit_events_type_check" CHECK (("event_type" = ANY (ARRAY['sync_success'::"text", 'sync_failure'::"text", 'quality_check'::"text", 'csv_export'::"text"])))
);


ALTER TABLE "public"."dashboard_audit_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_audit_events" IS 'Append-only operational history for Google Sheet synchronization, quality checks, and CSV exports.';



CREATE SEQUENCE IF NOT EXISTS "public"."dashboard_audit_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dashboard_audit_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dashboard_audit_events_id_seq" OWNED BY "public"."dashboard_audit_events"."id";



CREATE TABLE IF NOT EXISTS "public"."dashboard_data_quality_results" (
    "id" bigint NOT NULL,
    "sync_run_id" "text" NOT NULL,
    "check_key" "text" NOT NULL,
    "status" "text" NOT NULL,
    "observed_value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "details" "text",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dashboard_data_quality_results_status_check" CHECK (("status" = ANY (ARRAY['pass'::"text", 'warning'::"text", 'fail'::"text"])))
);


ALTER TABLE "public"."dashboard_data_quality_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_data_quality_results" IS 'Per-run validation results for the Google Sheet reporting synchronization.';



CREATE SEQUENCE IF NOT EXISTS "public"."dashboard_data_quality_results_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dashboard_data_quality_results_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dashboard_data_quality_results_id_seq" OWNED BY "public"."dashboard_data_quality_results"."id";



CREATE OR REPLACE VIEW "public"."dashboard_filter_capabilities" WITH ("security_invoker"='true') AS
 SELECT "dimension_type",
    ("count"(DISTINCT "dimension_key"))::integer AS "option_count",
    ("count"(DISTINCT "agent_key"))::integer AS "agent_count",
    "min"("report_date") AS "first_report_date",
    "max"("report_date") AS "latest_report_date",
    ("sum"("ticket_count"))::bigint AS "ticket_count"
   FROM "public"."agent_dimension_metrics"
  GROUP BY "dimension_type";


ALTER VIEW "public"."dashboard_filter_capabilities" OWNER TO "postgres";


COMMENT ON VIEW "public"."dashboard_filter_capabilities" IS 'Availability summary for agent-level app, platform, country, concern, priority, and channel filters supplied by agent_dimension_metrics.';



CREATE TABLE IF NOT EXISTS "public"."dashboard_targets" (
    "metric_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "target_value" numeric NOT NULL,
    "comparison_operator" "text" DEFAULT 'at_least'::"text" NOT NULL,
    "unit" "text" DEFAULT 'count'::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dashboard_targets_metric_key_check" CHECK (("metric_key" ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'::"text")),
    CONSTRAINT "dashboard_targets_operator_check" CHECK (("comparison_operator" = ANY (ARRAY['at_least'::"text", 'at_most'::"text"]))),
    CONSTRAINT "dashboard_targets_unit_check" CHECK (("unit" = ANY (ARRAY['count'::"text", 'ratio'::"text", 'percent'::"text", 'minutes'::"text", 'index'::"text"])))
);


ALTER TABLE "public"."dashboard_targets" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_targets" IS 'Optional Step 11 performance targets used for synchronized Google Sheet dashboard comparisons.';



CREATE TABLE IF NOT EXISTS "public"."google_calendar_connections" (
    "user_id" "uuid" NOT NULL,
    "encrypted_refresh_token" "text" NOT NULL,
    "calendar_id" "text" DEFAULT 'primary'::"text" NOT NULL,
    "calendar_summary" "text",
    "calendar_timezone" "text",
    "granted_scope" "text" NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone,
    "last_error" "text"
);


ALTER TABLE "public"."google_calendar_connections" OWNER TO "postgres";


COMMENT ON TABLE "public"."google_calendar_connections" IS 'Server-only Google Calendar OAuth connections. Refresh tokens are AES-GCM encrypted before storage.';



COMMENT ON COLUMN "public"."google_calendar_connections"."encrypted_refresh_token" IS 'Versioned AES-GCM ciphertext produced with the GOOGLE_TOKEN_ENCRYPTION_KEY Cloudflare secret.';



CREATE TABLE IF NOT EXISTS "public"."google_calendar_oauth_states" (
    "state_hash" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "return_to" "text" DEFAULT './home.html'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."google_calendar_oauth_states" OWNER TO "postgres";


COMMENT ON TABLE "public"."google_calendar_oauth_states" IS 'Single-use hashed OAuth state values used to bind Google authorization callbacks to authenticated users.';



CREATE TABLE IF NOT EXISTS "public"."login" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" character varying,
    "is_admin" boolean DEFAULT false,
    "can_edit_articles" boolean DEFAULT false,
    "name" "text" DEFAULT 'not_null'::"text"
);


ALTER TABLE "public"."login" OWNER TO "postgres";


COMMENT ON TABLE "public"."login" IS 'list of users allowed to login';



ALTER TABLE "public"."login" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."login_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "user_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "employee_id" "text" NOT NULL,
    "employment_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "base_role" "text" DEFAULT 'agent'::"text" NOT NULL,
    "team_id" "uuid",
    "supervisor_id" "uuid",
    "can_edit_articles" boolean DEFAULT false NOT NULL,
    "can_manage_payroll" boolean DEFAULT false NOT NULL,
    "timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_agent" boolean DEFAULT true NOT NULL,
    "is_system_admin" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_base_role_check" CHECK (("base_role" = ANY (ARRAY['admin'::"text", 'agent'::"text"]))),
    CONSTRAINT "profiles_email_not_blank" CHECK (("length"(TRIM(BOTH FROM "email")) > 0)),
    CONSTRAINT "profiles_employee_id_not_blank" CHECK (("length"(TRIM(BOTH FROM "employee_id")) > 0)),
    CONSTRAINT "profiles_employment_status_check" CHECK (("employment_status" = ANY (ARRAY['active'::"text", 'on_leave'::"text", 'inactive'::"text", 'terminated'::"text"]))),
    CONSTRAINT "profiles_full_name_not_blank" CHECK (("length"(TRIM(BOTH FROM "full_name")) > 0)),
    CONSTRAINT "profiles_no_self_supervision" CHECK ((("supervisor_id" IS NULL) OR ("supervisor_id" <> "user_id")))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'Workforce employee profiles. public.login remains the compatibility access source during Phase 1.';



COMMENT ON COLUMN "public"."profiles"."is_agent" IS 'Whether the profile participates in agent workflows such as schedules, attendance, and leave. Admin-only users set this to false.';



COMMENT ON COLUMN "public"."profiles"."is_system_admin" IS 'Hidden site-owner capability. Grants effective administrator scope without changing the visible base role or agent access type.';



CREATE TABLE IF NOT EXISTS "public"."raw_sheet_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sync_run_id" "uuid",
    "sheet_name" "text" NOT NULL,
    "report_date" "date",
    "raw_data" "jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."raw_sheet_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reporting_data_dictionary" (
    "contract_version" integer NOT NULL,
    "tab_name" "text" NOT NULL,
    "column_name" "text" NOT NULL,
    "data_type" "text" NOT NULL,
    "required" boolean NOT NULL,
    "definition" "text" NOT NULL,
    "validation_rule" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reporting_data_dictionary_values_check" CHECK ((("contract_version" > 0) AND ("length"(TRIM(BOTH FROM "tab_name")) > 0) AND ("length"(TRIM(BOTH FROM "column_name")) > 0) AND ("length"(TRIM(BOTH FROM "data_type")) > 0) AND ("length"(TRIM(BOTH FROM "definition")) > 0) AND ("length"(TRIM(BOTH FROM "validation_rule")) > 0)))
);


ALTER TABLE "public"."reporting_data_dictionary" OWNER TO "postgres";


COMMENT ON TABLE "public"."reporting_data_dictionary" IS 'Versioned business definitions and validation rules for the Google Sheet reporting contract.';



CREATE TABLE IF NOT EXISTS "public"."sheet_sync_metadata" (
    "sync_run_id" "text" NOT NULL,
    "contract_version" integer NOT NULL,
    "generated_at" timestamp with time zone NOT NULL,
    "source_time_zone" "text" NOT NULL,
    "test_window_start" "date" NOT NULL,
    "test_window_end" "date" NOT NULL,
    "test_days_count" integer NOT NULL,
    "producer" "text" NOT NULL,
    "ready_for_production" boolean DEFAULT false NOT NULL,
    "latest_report_date" "date",
    "rows_imported" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sheet_sync_metadata_values_check" CHECK ((("contract_version" = 3) AND ("source_time_zone" = 'America/New_York'::"text") AND ("test_window_end" >= "test_window_start") AND ("test_days_count" >= 1) AND ("rows_imported" >= 0)))
);


ALTER TABLE "public"."sheet_sync_metadata" OWNER TO "postgres";


COMMENT ON TABLE "public"."sheet_sync_metadata" IS 'One record per Step 9 sync run, including the seven-day rollout readiness state.';



CREATE TABLE IF NOT EXISTS "public"."teams" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "supervisor_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "teams_name_not_blank" CHECK (("length"(TRIM(BOTH FROM "name")) > 0))
);


ALTER TABLE "public"."teams" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_dimension_profiles" (
    "ticket_id" bigint NOT NULL,
    "app_key" "text",
    "platform_key" "text",
    "country_key" "text",
    "concern_key" "text",
    "source_updated_at" timestamp with time zone,
    "source_system" "text" DEFAULT 'zendesk'::"text" NOT NULL,
    "source_record_type" "text" DEFAULT 'ticket'::"text" NOT NULL,
    "source_record_id" "text" NOT NULL,
    "profile_version" "text" DEFAULT 'zendesk-custom-fields-v1'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "driver_key" "text" GENERATED ALWAYS AS ("concern_key") STORED,
    CONSTRAINT "ticket_dimension_profiles_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "ticket_dimension_profiles_ticket_id_check" CHECK (("ticket_id" > 0))
);


ALTER TABLE "public"."ticket_dimension_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."ticket_dimension_profiles" IS 'Server-only current Zendesk ticket dimensions used for app, platform, country, and concern reporting.';



COMMENT ON COLUMN "public"."ticket_dimension_profiles"."concern_key" IS 'Normalized Zendesk Concerns ticket-field value.';



COMMENT ON COLUMN "public"."ticket_dimension_profiles"."driver_key" IS 'Generated compatibility alias for concern_key used by the existing Step 4 dashboard RPC.';



CREATE TABLE IF NOT EXISTS "public"."ticket_driver_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_date" "date" NOT NULL,
    "driver_group_key" "text" NOT NULL,
    "driver_group_label" "text" NOT NULL,
    "driver_key" "text" NOT NULL,
    "driver_label" "text" NOT NULL,
    "ticket_count" integer DEFAULT 0 NOT NULL,
    "source_column" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ticket_driver_metrics_values_check" CHECK (("ticket_count" >= 0))
);


ALTER TABLE "public"."ticket_driver_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" bigint NOT NULL,
    "source_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_timestamp" timestamp with time zone NOT NULL,
    "agent_key" "text",
    "ticket_status" "text",
    "priority" "text",
    "channel" "text",
    "app_key" "text",
    "platform_key" "text",
    "country_key" "text",
    "driver_key" "text",
    "source_system" "text" DEFAULT 'zendesk'::"text" NOT NULL,
    "source_record_type" "text" NOT NULL,
    "source_record_id" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ticket_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['created'::"text", 'assigned'::"text", 'first_response'::"text", 'status_changed'::"text", 'priority_changed'::"text", 'solved'::"text", 'reopened'::"text", 'closed'::"text", 'sla_breached'::"text", 'csat_rating'::"text"]))),
    CONSTRAINT "ticket_events_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "ticket_events_ticket_id_check" CHECK (("ticket_id" > 0))
);


ALTER TABLE "public"."ticket_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."ticket_events" IS 'Normalized, deduplicated Zendesk ticket lifecycle events.';



COMMENT ON COLUMN "public"."ticket_events"."source_event_id" IS 'Immutable source identifier used to make imports idempotent.';



CREATE TABLE IF NOT EXISTS "public"."user_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL,
    "is_granted" boolean DEFAULT true NOT NULL,
    "granted_by" "uuid",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_permissions_permission_key_check" CHECK (("permission_key" = ANY (ARRAY['manage_employees'::"text", 'manage_schedules'::"text", 'view_team_attendance'::"text", 'correct_attendance'::"text", 'approve_attendance'::"text", 'approve_leave'::"text", 'view_workforce_reports'::"text", 'edit_articles'::"text", 'manage_payroll'::"text"])))
);


ALTER TABLE "public"."user_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_permissions" IS 'Effective workforce, article-editor, and future payroll permission grants.';



CREATE TABLE IF NOT EXISTS "public"."workforce_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "before_data" "jsonb",
    "after_data" "jsonb",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workforce_audit_logs_action_not_blank" CHECK (("length"(TRIM(BOTH FROM "action")) > 0)),
    CONSTRAINT "workforce_audit_logs_entity_not_blank" CHECK (("length"(TRIM(BOTH FROM "entity_type")) > 0))
);


ALTER TABLE "public"."workforce_audit_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."workforce_audit_logs" IS 'Append-only audit history populated by database triggers.';



CREATE TABLE IF NOT EXISTS "public"."workforce_identity_links" (
    "auth_user_id" "uuid" NOT NULL,
    "profile_user_id" "uuid" NOT NULL,
    "match_method" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workforce_identity_links_match_method_check" CHECK (("match_method" = ANY (ARRAY['auth_user_id'::"text", 'exact_email'::"text", 'unique_name_alias'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."workforce_identity_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."zendesk_agent_directory" (
    "agent_key" "text" NOT NULL,
    "zendesk_user_id" bigint NOT NULL,
    "agent_name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "role" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "zendesk_agent_directory_agent_key_check" CHECK (("agent_key" ~ '^zendesk:[0-9]+$'::"text")),
    CONSTRAINT "zendesk_agent_directory_agent_name_check" CHECK (("btrim"("agent_name") <> ''::"text")),
    CONSTRAINT "zendesk_agent_directory_zendesk_user_id_check" CHECK (("zendesk_user_id" > 0))
);


ALTER TABLE "public"."zendesk_agent_directory" OWNER TO "postgres";


COMMENT ON TABLE "public"."zendesk_agent_directory" IS 'Cached Zendesk user names used to replace numeric agent IDs in dashboards.';



CREATE TABLE IF NOT EXISTS "public"."zendesk_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stream_key" "text" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" NOT NULL,
    "trigger_source" "text" NOT NULL,
    "cursor_before" "text",
    "cursor_after" "text",
    "tickets_processed" integer DEFAULT 0 NOT NULL,
    "events_seen" integer DEFAULT 0 NOT NULL,
    "events_imported" integer DEFAULT 0 NOT NULL,
    "duplicate_events" integer DEFAULT 0 NOT NULL,
    "warnings_count" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    CONSTRAINT "zendesk_sync_runs_duplicate_events_check" CHECK (("duplicate_events" >= 0)),
    CONSTRAINT "zendesk_sync_runs_events_imported_check" CHECK (("events_imported" >= 0)),
    CONSTRAINT "zendesk_sync_runs_events_seen_check" CHECK (("events_seen" >= 0)),
    CONSTRAINT "zendesk_sync_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'success'::"text", 'failed'::"text"]))),
    CONSTRAINT "zendesk_sync_runs_tickets_processed_check" CHECK (("tickets_processed" >= 0)),
    CONSTRAINT "zendesk_sync_runs_trigger_source_check" CHECK (("trigger_source" = ANY (ARRAY['manual'::"text", 'scheduled'::"text"]))),
    CONSTRAINT "zendesk_sync_runs_warnings_count_check" CHECK (("warnings_count" >= 0))
);


ALTER TABLE "public"."zendesk_sync_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."zendesk_sync_runs" IS 'Server-only execution history for Zendesk event synchronization.';



CREATE TABLE IF NOT EXISTS "public"."zendesk_sync_state" (
    "stream_key" "text" NOT NULL,
    "cursor" "text",
    "start_time" bigint,
    "last_event_timestamp" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "lease_token" "uuid",
    "lease_expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "zendesk_sync_state_start_time_check" CHECK ((("start_time" IS NULL) OR ("start_time" > 0)))
);


ALTER TABLE "public"."zendesk_sync_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."zendesk_sync_state" IS 'Server-only cursor and lease state for incremental Zendesk exports.';



ALTER TABLE ONLY "public"."dashboard_alert_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dashboard_alert_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."dashboard_audit_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dashboard_audit_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."dashboard_data_quality_results" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dashboard_data_quality_results_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agent_dimension_metrics"
    ADD CONSTRAINT "agent_dimension_metrics_pkey" PRIMARY KEY ("report_date", "agent_key", "dimension_type", "dimension_key");



ALTER TABLE ONLY "public"."agent_identity_map"
    ADD CONSTRAINT "agent_identity_map_pkey" PRIMARY KEY ("agent_key");



ALTER TABLE ONLY "public"."agent_identity_map"
    ADD CONSTRAINT "agent_identity_map_zendesk_agent_key_key" UNIQUE ("zendesk_agent_key");



ALTER TABLE ONLY "public"."agent_productivity"
    ADD CONSTRAINT "agent_productivity_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."articles"
    ADD CONSTRAINT "articles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance_corrections"
    ADD CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_distribution_metrics"
    ADD CONSTRAINT "daily_distribution_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_distribution_metrics"
    ADD CONSTRAINT "daily_distribution_metrics_report_date_dimension_type_dimen_key" UNIQUE ("report_date", "dimension_type", "dimension_key");



ALTER TABLE ONLY "public"."daily_operations_metrics"
    ADD CONSTRAINT "daily_operations_metrics_pkey" PRIMARY KEY ("report_date");



ALTER TABLE ONLY "public"."daily_ticket_metrics"
    ADD CONSTRAINT "daily_ticket_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_ticket_metrics"
    ADD CONSTRAINT "daily_ticket_metrics_report_date_key" UNIQUE ("report_date");



ALTER TABLE ONLY "public"."dashboard_alert_events"
    ADD CONSTRAINT "dashboard_alert_events_alert_key_key" UNIQUE ("alert_key");



ALTER TABLE ONLY "public"."dashboard_alert_events"
    ADD CONSTRAINT "dashboard_alert_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_audit_events"
    ADD CONSTRAINT "dashboard_audit_events_event_key_key" UNIQUE ("event_key");



ALTER TABLE ONLY "public"."dashboard_audit_events"
    ADD CONSTRAINT "dashboard_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_data_quality_results"
    ADD CONSTRAINT "dashboard_data_quality_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_data_quality_results"
    ADD CONSTRAINT "dashboard_data_quality_results_sync_run_id_check_key_key" UNIQUE ("sync_run_id", "check_key");



ALTER TABLE ONLY "public"."dashboard_targets"
    ADD CONSTRAINT "dashboard_targets_pkey" PRIMARY KEY ("metric_key");



ALTER TABLE ONLY "public"."google_calendar_connections"
    ADD CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."google_calendar_oauth_states"
    ADD CONSTRAINT "google_calendar_oauth_states_pkey" PRIMARY KEY ("state_hash");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."login"
    ADD CONSTRAINT "login_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."raw_sheet_imports"
    ADD CONSTRAINT "raw_sheet_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reporting_data_dictionary"
    ADD CONSTRAINT "reporting_data_dictionary_pkey" PRIMARY KEY ("contract_version", "tab_name", "column_name");



ALTER TABLE ONLY "public"."sheet_sync_metadata"
    ADD CONSTRAINT "sheet_sync_metadata_pkey" PRIMARY KEY ("sync_run_id");



ALTER TABLE ONLY "public"."sheet_sync_runs"
    ADD CONSTRAINT "sheet_sync_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_dimension_profiles"
    ADD CONSTRAINT "ticket_dimension_profiles_pkey" PRIMARY KEY ("ticket_id");



ALTER TABLE ONLY "public"."ticket_driver_metrics"
    ADD CONSTRAINT "ticket_driver_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_driver_metrics"
    ADD CONSTRAINT "ticket_driver_metrics_report_date_driver_key_key" UNIQUE ("report_date", "driver_key");



ALTER TABLE ONLY "public"."ticket_events"
    ADD CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_events"
    ADD CONSTRAINT "ticket_events_source_event_id_key" UNIQUE ("source_event_id");



ALTER TABLE ONLY "public"."agent_productivity"
    ADD CONSTRAINT "unique_agent_report" UNIQUE ("report_date", "agent_key");



ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "user_permissions_user_key_unique" UNIQUE ("user_id", "permission_key");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_user_date_sequence_unique" UNIQUE ("user_id", "shift_date", "shift_sequence");



ALTER TABLE ONLY "public"."workforce_audit_logs"
    ADD CONSTRAINT "workforce_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workforce_identity_links"
    ADD CONSTRAINT "workforce_identity_links_pkey" PRIMARY KEY ("auth_user_id", "profile_user_id");



ALTER TABLE ONLY "public"."zendesk_agent_directory"
    ADD CONSTRAINT "zendesk_agent_directory_pkey" PRIMARY KEY ("agent_key");



ALTER TABLE ONLY "public"."zendesk_agent_directory"
    ADD CONSTRAINT "zendesk_agent_directory_zendesk_user_id_key" UNIQUE ("zendesk_user_id");



ALTER TABLE ONLY "public"."zendesk_sync_runs"
    ADD CONSTRAINT "zendesk_sync_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."zendesk_sync_state"
    ADD CONSTRAINT "zendesk_sync_state_pkey" PRIMARY KEY ("stream_key");



CREATE INDEX "agent_dimension_metrics_agent_idx" ON "public"."agent_dimension_metrics" USING "btree" ("agent_key", "report_date" DESC);



CREATE INDEX "agent_dimension_metrics_date_idx" ON "public"."agent_dimension_metrics" USING "btree" ("report_date" DESC);



CREATE INDEX "agent_dimension_metrics_type_idx" ON "public"."agent_dimension_metrics" USING "btree" ("dimension_type", "dimension_key", "report_date" DESC);



CREATE INDEX "agent_identity_map_name_idx" ON "public"."agent_identity_map" USING "btree" ("lower"("agent_name"));



CREATE UNIQUE INDEX "agent_productivity_key_uidx" ON "public"."agent_productivity" USING "btree" ("report_date", "agent_key");



CREATE INDEX "attendance_corrected_date_idx" ON "public"."attendance" USING "btree" ("work_date" DESC, "is_corrected") WHERE ("is_corrected" IS TRUE);



CREATE INDEX "attendance_corrections_attendance_idx" ON "public"."attendance_corrections" USING "btree" ("attendance_id", "corrected_at" DESC);



CREATE INDEX "attendance_corrections_employee_idx" ON "public"."attendance_corrections" USING "btree" ("employee_user_id", "corrected_at" DESC);



CREATE UNIQUE INDEX "attendance_one_open_session_per_user_idx" ON "public"."attendance" USING "btree" ("user_id") WHERE (("clock_in" IS NOT NULL) AND ("clock_out" IS NULL));



CREATE INDEX "attendance_review_status_date_idx" ON "public"."attendance" USING "btree" ("review_status", "work_date" DESC);



CREATE INDEX "attendance_reviewed_by_at_idx" ON "public"."attendance" USING "btree" ("reviewed_by", "reviewed_at" DESC) WHERE ("reviewed_by" IS NOT NULL);



CREATE INDEX "attendance_schedule_id_idx" ON "public"."attendance" USING "btree" ("schedule_id");



CREATE INDEX "attendance_status_date_idx" ON "public"."attendance" USING "btree" ("attendance_status", "work_date");



CREATE INDEX "attendance_user_date_idx" ON "public"."attendance" USING "btree" ("user_id", "work_date");



CREATE UNIQUE INDEX "attendance_user_schedule_unique" ON "public"."attendance" USING "btree" ("user_id", "schedule_id") WHERE ("schedule_id" IS NOT NULL);



CREATE UNIQUE INDEX "attendance_user_unscheduled_date_unique" ON "public"."attendance" USING "btree" ("user_id", "work_date") WHERE ("schedule_id" IS NULL);



CREATE UNIQUE INDEX "daily_distribution_metrics_key_uidx" ON "public"."daily_distribution_metrics" USING "btree" ("report_date", "dimension_type", "dimension_key");



CREATE INDEX "daily_operations_metrics_calculated_idx" ON "public"."daily_operations_metrics" USING "btree" ("calculated_at" DESC);



CREATE UNIQUE INDEX "daily_ticket_metrics_report_date_uidx" ON "public"."daily_ticket_metrics" USING "btree" ("report_date");



CREATE INDEX "dashboard_alert_events_status_idx" ON "public"."dashboard_alert_events" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "dashboard_alert_events_sync_idx" ON "public"."dashboard_alert_events" USING "btree" ("sync_run_id", "created_at" DESC);



CREATE INDEX "dashboard_audit_events_created_idx" ON "public"."dashboard_audit_events" USING "btree" ("created_at" DESC);



CREATE INDEX "dashboard_audit_events_sync_idx" ON "public"."dashboard_audit_events" USING "btree" ("sync_run_id", "created_at" DESC);



CREATE INDEX "dashboard_data_quality_results_run_idx" ON "public"."dashboard_data_quality_results" USING "btree" ("sync_run_id", "checked_at" DESC);



CREATE INDEX "dashboard_data_quality_results_status_idx" ON "public"."dashboard_data_quality_results" USING "btree" ("status", "checked_at" DESC);



CREATE INDEX "dashboard_targets_active_idx" ON "public"."dashboard_targets" USING "btree" ("active", "metric_key");



CREATE INDEX "distribution_date_type_idx" ON "public"."daily_distribution_metrics" USING "btree" ("report_date" DESC, "dimension_type");



CREATE INDEX "driver_date_group_idx" ON "public"."ticket_driver_metrics" USING "btree" ("report_date" DESC, "driver_group_key");



CREATE INDEX "google_calendar_oauth_states_expires_at_idx" ON "public"."google_calendar_oauth_states" USING "btree" ("expires_at");



CREATE INDEX "google_calendar_oauth_states_user_id_idx" ON "public"."google_calendar_oauth_states" USING "btree" ("user_id");



CREATE INDEX "idx_agent_productivity_agent_key" ON "public"."agent_productivity" USING "btree" ("agent_key");



CREATE INDEX "idx_agent_productivity_report_date" ON "public"."agent_productivity" USING "btree" ("report_date");



CREATE INDEX "idx_daily_distribution_metrics_date" ON "public"."daily_distribution_metrics" USING "btree" ("report_date");



CREATE INDEX "idx_daily_distribution_metrics_dimension" ON "public"."daily_distribution_metrics" USING "btree" ("dimension_type", "dimension_key");



CREATE INDEX "idx_sheet_sync_runs_report_date" ON "public"."sheet_sync_runs" USING "btree" ("report_date");



CREATE INDEX "idx_sheet_sync_runs_status" ON "public"."sheet_sync_runs" USING "btree" ("status");



CREATE INDEX "idx_ticket_driver_metrics_driver_group_key" ON "public"."ticket_driver_metrics" USING "btree" ("driver_group_key");



CREATE INDEX "idx_ticket_driver_metrics_driver_key" ON "public"."ticket_driver_metrics" USING "btree" ("driver_key");



CREATE INDEX "idx_ticket_driver_metrics_report_date" ON "public"."ticket_driver_metrics" USING "btree" ("report_date");



CREATE INDEX "leave_requests_status_idx" ON "public"."leave_requests" USING "btree" ("status", "created_at");



CREATE INDEX "leave_requests_user_dates_idx" ON "public"."leave_requests" USING "btree" ("user_id", "start_date", "end_date");



CREATE INDEX "productivity_date_agent_idx" ON "public"."agent_productivity" USING "btree" ("report_date" DESC, "agent_key");



CREATE UNIQUE INDEX "profiles_email_lower_unique" ON "public"."profiles" USING "btree" ("lower"("email"));



CREATE UNIQUE INDEX "profiles_employee_id_lower_unique" ON "public"."profiles" USING "btree" ("lower"("employee_id"));



CREATE INDEX "profiles_employment_status_idx" ON "public"."profiles" USING "btree" ("employment_status");



CREATE INDEX "profiles_supervisor_id_idx" ON "public"."profiles" USING "btree" ("supervisor_id");



CREATE INDEX "profiles_team_id_idx" ON "public"."profiles" USING "btree" ("team_id");



CREATE INDEX "raw_sheet_imports_report_date_idx" ON "public"."raw_sheet_imports" USING "btree" ("report_date");



CREATE INDEX "raw_sheet_imports_sync_run_idx" ON "public"."raw_sheet_imports" USING "btree" ("sync_run_id");



CREATE INDEX "sheet_sync_metadata_generated_idx" ON "public"."sheet_sync_metadata" USING "btree" ("generated_at" DESC);



CREATE UNIQUE INDEX "teams_name_lower_unique" ON "public"."teams" USING "btree" ("lower"("name"));



CREATE INDEX "ticket_dimension_profiles_app_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("app_key") WHERE ("app_key" IS NOT NULL);



CREATE INDEX "ticket_dimension_profiles_concern_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("concern_key") WHERE ("concern_key" IS NOT NULL);



CREATE INDEX "ticket_dimension_profiles_country_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("country_key") WHERE ("country_key" IS NOT NULL);



CREATE INDEX "ticket_dimension_profiles_driver_compat_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("driver_key") WHERE ("driver_key" IS NOT NULL);



CREATE INDEX "ticket_dimension_profiles_platform_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("platform_key") WHERE ("platform_key" IS NOT NULL);



CREATE INDEX "ticket_dimension_profiles_source_updated_idx" ON "public"."ticket_dimension_profiles" USING "btree" ("source_updated_at" DESC) WHERE ("source_updated_at" IS NOT NULL);



CREATE UNIQUE INDEX "ticket_driver_metrics_key_uidx" ON "public"."ticket_driver_metrics" USING "btree" ("report_date", "driver_key");



CREATE INDEX "ticket_events_agent_timestamp_idx" ON "public"."ticket_events" USING "btree" ("agent_key", "event_timestamp" DESC) WHERE ("agent_key" IS NOT NULL);



CREATE INDEX "ticket_events_app_timestamp_idx" ON "public"."ticket_events" USING "btree" ("app_key", "event_timestamp" DESC) WHERE ("app_key" IS NOT NULL);



CREATE INDEX "ticket_events_channel_timestamp_idx" ON "public"."ticket_events" USING "btree" ("channel", "event_timestamp" DESC) WHERE ("channel" IS NOT NULL);



CREATE INDEX "ticket_events_country_timestamp_idx" ON "public"."ticket_events" USING "btree" ("country_key", "event_timestamp" DESC) WHERE ("country_key" IS NOT NULL);



CREATE INDEX "ticket_events_driver_timestamp_idx" ON "public"."ticket_events" USING "btree" ("driver_key", "event_timestamp" DESC) WHERE ("driver_key" IS NOT NULL);



CREATE INDEX "ticket_events_event_timestamp_idx" ON "public"."ticket_events" USING "btree" ("event_timestamp" DESC);



CREATE INDEX "ticket_events_event_type_timestamp_idx" ON "public"."ticket_events" USING "btree" ("event_type", "event_timestamp" DESC);



CREATE INDEX "ticket_events_platform_timestamp_idx" ON "public"."ticket_events" USING "btree" ("platform_key", "event_timestamp" DESC) WHERE ("platform_key" IS NOT NULL);



CREATE INDEX "ticket_events_priority_timestamp_idx" ON "public"."ticket_events" USING "btree" ("priority", "event_timestamp" DESC) WHERE ("priority" IS NOT NULL);



CREATE INDEX "ticket_events_ticket_timestamp_idx" ON "public"."ticket_events" USING "btree" ("ticket_id", "event_timestamp" DESC);



CREATE INDEX "user_permissions_lookup_idx" ON "public"."user_permissions" USING "btree" ("user_id", "permission_key", "is_granted");



CREATE INDEX "work_schedules_status_idx" ON "public"."work_schedules" USING "btree" ("status");



CREATE INDEX "work_schedules_team_date_idx" ON "public"."work_schedules" USING "btree" ("team_id", "shift_date");



CREATE INDEX "work_schedules_user_date_idx" ON "public"."work_schedules" USING "btree" ("user_id", "shift_date");



CREATE INDEX "workforce_audit_logs_actor_idx" ON "public"."workforce_audit_logs" USING "btree" ("actor_user_id", "created_at" DESC);



CREATE INDEX "workforce_audit_logs_created_at_idx" ON "public"."workforce_audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "workforce_audit_logs_entity_idx" ON "public"."workforce_audit_logs" USING "btree" ("entity_type", "entity_id", "created_at" DESC);



CREATE INDEX "workforce_identity_links_profile_idx" ON "public"."workforce_identity_links" USING "btree" ("profile_user_id", "is_active");



CREATE INDEX "zendesk_agent_directory_name_idx" ON "public"."zendesk_agent_directory" USING "btree" ("lower"("agent_name"));



CREATE INDEX "zendesk_sync_runs_started_at_idx" ON "public"."zendesk_sync_runs" USING "btree" ("started_at" DESC);



CREATE INDEX "zendesk_sync_runs_stream_started_idx" ON "public"."zendesk_sync_runs" USING "btree" ("stream_key", "started_at" DESC);



CREATE OR REPLACE TRIGGER "attendance_prepare_storage" BEFORE INSERT OR UPDATE ON "public"."attendance" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_prepare_attendance_storage"();



CREATE OR REPLACE TRIGGER "attendance_set_updated_at" BEFORE UPDATE ON "public"."attendance" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "attendance_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."attendance" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('id');



CREATE OR REPLACE TRIGGER "capture_agent_identity_from_productivity" AFTER INSERT OR UPDATE OF "agent_key", "agent_name" ON "public"."agent_productivity" FOR EACH ROW EXECUTE FUNCTION "public"."capture_agent_identity_from_productivity"();



CREATE OR REPLACE TRIGGER "dashboard_quality_operations_trigger" AFTER INSERT ON "public"."dashboard_data_quality_results" FOR EACH ROW EXECUTE FUNCTION "public"."record_dashboard_quality_operations"();



CREATE OR REPLACE TRIGGER "dashboard_sync_operations_trigger" AFTER UPDATE OF "status" ON "public"."sheet_sync_runs" FOR EACH ROW WHEN ((("new"."status" IS DISTINCT FROM "old"."status") AND (("new"."status" = 'success'::"text") OR ("new"."status" = 'failed'::"text")))) EXECUTE FUNCTION "public"."record_dashboard_sync_operations"();



CREATE OR REPLACE TRIGGER "enforce_admin_article_access_trigger" BEFORE INSERT OR UPDATE ON "public"."login" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_admin_article_access"();



CREATE OR REPLACE TRIGGER "leave_requests_set_updated_at" BEFORE UPDATE ON "public"."leave_requests" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "leave_requests_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."leave_requests" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('id');



CREATE OR REPLACE TRIGGER "login_workforce_sync" AFTER INSERT OR DELETE OR UPDATE ON "public"."login" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_sync_login_record"();



CREATE OR REPLACE TRIGGER "normalize_agent_productivity_aht_unit" BEFORE INSERT OR UPDATE ON "public"."agent_productivity" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_agent_productivity_aht_unit"();



CREATE OR REPLACE TRIGGER "profiles_enforce_admin_payroll" BEFORE INSERT OR UPDATE OF "base_role", "is_system_admin", "can_manage_payroll" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_enforce_admin_payroll_profile"();



CREATE OR REPLACE TRIGGER "profiles_login_compatibility_sync" AFTER INSERT OR UPDATE OF "base_role", "is_system_admin", "can_edit_articles", "email" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_sync_profile_compatibility"();



CREATE OR REPLACE TRIGGER "profiles_normalize_timezone_default" BEFORE INSERT OR UPDATE OF "timezone" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_normalize_timezone_default"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_sync_admin_payroll_permission" AFTER INSERT OR UPDATE OF "base_role", "is_system_admin", "can_manage_payroll" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_sync_admin_payroll_permission"();



CREATE OR REPLACE TRIGGER "profiles_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('user_id');



CREATE OR REPLACE TRIGGER "profiles_workforce_identity_link" AFTER INSERT OR UPDATE OF "email" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_sync_identity_link_from_profile"();



CREATE OR REPLACE TRIGGER "set_article_update_metadata_trigger" BEFORE INSERT OR UPDATE ON "public"."articles" FOR EACH ROW EXECUTE FUNCTION "public"."set_article_update_metadata"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."daily_ticket_metrics" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."ticket_driver_metrics" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "sheet_sync_quality_results_trigger" AFTER UPDATE OF "status", "completed_at", "report_date", "rows_imported" ON "public"."sheet_sync_runs" FOR EACH ROW WHEN ((("new"."status" = 'success'::"text") OR ("new"."status" = 'failed'::"text"))) EXECUTE FUNCTION "public"."record_sheet_sync_quality_results"();



CREATE OR REPLACE TRIGGER "teams_set_updated_at" BEFORE UPDATE ON "public"."teams" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "teams_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."teams" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('id');



CREATE OR REPLACE TRIGGER "update_agent_productivity_updated_at" BEFORE UPDATE ON "public"."agent_productivity" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_daily_distribution_metrics_updated_at" BEFORE UPDATE ON "public"."daily_distribution_metrics" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "user_permissions_set_updated_at" BEFORE UPDATE ON "public"."user_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "user_permissions_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."user_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('id');



CREATE OR REPLACE TRIGGER "work_schedules_normalize_timezone_default" BEFORE INSERT OR UPDATE OF "timezone" ON "public"."work_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_normalize_timezone_default"();



CREATE OR REPLACE TRIGGER "work_schedules_set_updated_at" BEFORE UPDATE ON "public"."work_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_set_updated_at"();



CREATE OR REPLACE TRIGGER "work_schedules_workforce_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."work_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_audit_row_change"('id');



CREATE OR REPLACE TRIGGER "zz_login_workforce_identity_link" AFTER INSERT OR UPDATE OF "email" ON "public"."login" FOR EACH ROW EXECUTE FUNCTION "public"."workforce_sync_identity_link_from_login"();



ALTER TABLE ONLY "public"."agent_identity_map"
    ADD CONSTRAINT "agent_identity_map_zendesk_agent_key_fkey" FOREIGN KEY ("zendesk_agent_key") REFERENCES "public"."zendesk_agent_directory"("agent_key") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attendance_corrections"
    ADD CONSTRAINT "attendance_corrections_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendance"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance_corrections"
    ADD CONSTRAINT "attendance_corrections_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."attendance_corrections"
    ADD CONSTRAINT "attendance_corrections_employee_user_id_fkey" FOREIGN KEY ("employee_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."attendance_corrections"
    ADD CONSTRAINT "attendance_corrections_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."work_schedules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."work_schedules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."google_calendar_connections"
    ADD CONSTRAINT "google_calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."google_calendar_oauth_states"
    ADD CONSTRAINT "google_calendar_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_supervisor_profile_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."profiles"("user_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."raw_sheet_imports"
    ADD CONSTRAINT "raw_sheet_imports_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_supervisor_profile_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."profiles"("user_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workforce_identity_links"
    ADD CONSTRAINT "workforce_identity_links_profile_user_id_fkey" FOREIGN KEY ("profile_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE CASCADE;



CREATE POLICY "Admins can delete attendance correction history" ON "public"."attendance_corrections" FOR DELETE USING (("public"."workforce_current_user_is_active"() AND "public"."workforce_is_admin"()));



CREATE POLICY "Admins can insert attendance correction history" ON "public"."attendance_corrections" FOR INSERT WITH CHECK (("public"."workforce_current_user_is_active"() AND "public"."workforce_is_admin"()));



CREATE POLICY "Admins can update attendance correction history" ON "public"."attendance_corrections" FOR UPDATE USING (("public"."workforce_current_user_is_active"() AND "public"."workforce_is_admin"()));



CREATE POLICY "Admins can view attendance" ON "public"."attendance" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view attendance correction history" ON "public"."attendance_corrections" FOR SELECT USING (("public"."workforce_current_user_is_active"() AND "public"."workforce_is_admin"()));



CREATE POLICY "Admins can view leave requests" ON "public"."leave_requests" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view work schedules" ON "public"."work_schedules" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view workforce audit logs" ON "public"."workforce_audit_logs" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view workforce permissions" ON "public"."user_permissions" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view workforce profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Admins can view workforce teams" ON "public"."teams" FOR SELECT TO "authenticated" USING ("public"."workforce_is_admin"());



CREATE POLICY "Allow authenticated users to read login" ON "public"."login" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Article editors can delete articles" ON "public"."articles" FOR DELETE TO "authenticated" USING ("public"."current_user_can_edit_articles"());



CREATE POLICY "Article editors can update articles" ON "public"."articles" FOR UPDATE TO "authenticated" USING ("public"."current_user_can_edit_articles"()) WITH CHECK ("public"."current_user_can_edit_articles"());



CREATE POLICY "Authenticated users can read Zendesk agent names" ON "public"."zendesk_agent_directory" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read active dashboard targets" ON "public"."dashboard_targets" FOR SELECT TO "authenticated" USING (("active" = true));



CREATE POLICY "Authenticated users can read agent dimension metrics" ON "public"."agent_dimension_metrics" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read agent identity mappings" ON "public"."agent_identity_map" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read agent productivity" ON "public"."agent_productivity" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read articles" ON "public"."articles" FOR SELECT TO "authenticated" USING ((("published" = true) OR "public"."current_user_can_edit_articles"()));



CREATE POLICY "Authenticated users can read daily operations metrics" ON "public"."daily_operations_metrics" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read daily ticket metrics" ON "public"."daily_ticket_metrics" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read distribution metrics" ON "public"."daily_distribution_metrics" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read reporting data dictionary" ON "public"."reporting_data_dictionary" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read sheet sync metadata" ON "public"."sheet_sync_metadata" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read ticket driver metrics" ON "public"."ticket_driver_metrics" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read ticket events" ON "public"."ticket_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authorized users can delete attendance" ON "public"."attendance" FOR DELETE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_schedules'::"text")));



CREATE POLICY "Authorized users can delete work schedules" ON "public"."work_schedules" FOR DELETE TO "authenticated" USING ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Authorized users can insert attendance" ON "public"."attendance" FOR INSERT TO "authenticated" WITH CHECK ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Authorized users can insert work schedules" ON "public"."work_schedules" FOR INSERT TO "authenticated" WITH CHECK ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Authorized users can update attendance" ON "public"."attendance" FOR UPDATE TO "authenticated" USING ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text")) WITH CHECK ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Authorized users can update leave requests" ON "public"."leave_requests" FOR UPDATE TO "authenticated" USING ("public"."workforce_can_manage_user"("user_id", 'approve_leave'::"text")) WITH CHECK ("public"."workforce_can_manage_user"("user_id", 'approve_leave'::"text"));



CREATE POLICY "Authorized users can update work schedules" ON "public"."work_schedules" FOR UPDATE TO "authenticated" USING ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text")) WITH CHECK ("public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Editors can insert articles" ON "public"."articles" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Reporting administrators can read dashboard alert events" ON "public"."dashboard_alert_events" FOR SELECT TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('view_workforce_reports'::"text")));



COMMENT ON POLICY "Reporting administrators can read dashboard alert events" ON "public"."dashboard_alert_events" IS 'Restricts Reporting Operations alerts to active administrators with view_workforce_reports.';



CREATE POLICY "Reporting administrators can read dashboard audit events" ON "public"."dashboard_audit_events" FOR SELECT TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('view_workforce_reports'::"text")));



COMMENT ON POLICY "Reporting administrators can read dashboard audit events" ON "public"."dashboard_audit_events" IS 'Restricts Reporting Operations audit history to active administrators with view_workforce_reports.';



CREATE POLICY "Reporting administrators can read dashboard data quality result" ON "public"."dashboard_data_quality_results" FOR SELECT TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('view_workforce_reports'::"text")));



COMMENT ON POLICY "Reporting administrators can read dashboard data quality result" ON "public"."dashboard_data_quality_results" IS 'Restricts Reporting Operations quality results to active administrators with view_workforce_reports.';



CREATE POLICY "Reporting administrators can read sheet synchronization runs" ON "public"."sheet_sync_runs" FOR SELECT TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('view_workforce_reports'::"text")));



COMMENT ON POLICY "Reporting administrators can read sheet synchronization runs" ON "public"."sheet_sync_runs" IS 'Restricts synchronization history to active administrators with view_workforce_reports.';



CREATE POLICY "Users can submit their own leave requests" ON "public"."leave_requests" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."workforce_current_user_is_agent"() AND ("status" = 'pending'::"text") AND ("reviewed_by" IS NULL) AND ("reviewed_at" IS NULL)));



CREATE POLICY "Users can view permitted attendance" ON "public"."attendance" FOR SELECT TO "authenticated" USING (("public"."workforce_is_current_identity"("user_id") OR "public"."workforce_can_manage_user"("user_id", 'view_team_attendance'::"text") OR "public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text")));



CREATE POLICY "Users can view permitted work schedules" ON "public"."work_schedules" FOR SELECT TO "authenticated" USING ("public"."workforce_can_view_user"("user_id", 'manage_schedules'::"text"));



CREATE POLICY "Users can view permitted workforce profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("public"."workforce_is_current_identity"("user_id") OR "public"."workforce_can_manage_user"("user_id", 'manage_employees'::"text") OR "public"."workforce_can_manage_user"("user_id", 'manage_schedules'::"text") OR "public"."workforce_can_manage_user"("user_id", 'view_team_attendance'::"text") OR "public"."workforce_can_manage_user"("user_id", 'approve_leave'::"text") OR "public"."workforce_can_manage_user"("user_id", 'view_workforce_reports'::"text")));



CREATE POLICY "Users can view their own permissions" ON "public"."user_permissions" FOR SELECT TO "authenticated" USING (("public"."workforce_is_current_identity"("user_id") OR ("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text"))));



CREATE POLICY "Workforce admins can delete leave requests" ON "public"."leave_requests" FOR DELETE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('approve_leave'::"text")));



CREATE POLICY "Workforce admins can delete permissions" ON "public"."user_permissions" FOR DELETE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can delete profiles" ON "public"."profiles" FOR DELETE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can delete teams" ON "public"."teams" FOR DELETE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can insert permissions" ON "public"."user_permissions" FOR INSERT TO "authenticated" WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can insert profiles" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can insert teams" ON "public"."teams" FOR INSERT TO "authenticated" WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can update permissions" ON "public"."user_permissions" FOR UPDATE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text"))) WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can update profiles" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text"))) WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



CREATE POLICY "Workforce admins can update teams" ON "public"."teams" FOR UPDATE TO "authenticated" USING (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text"))) WITH CHECK (("public"."workforce_is_admin"() AND "public"."workforce_has_permission"('manage_employees'::"text")));



ALTER TABLE "public"."agent_dimension_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_identity_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_productivity" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."articles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance_corrections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_distribution_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_operations_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_ticket_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_alert_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_data_quality_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_targets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_calendar_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_calendar_oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leave_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."login" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."raw_sheet_imports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reporting_data_dictionary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sheet_sync_metadata" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sheet_sync_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ticket_dimension_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ticket_driver_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ticket_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."work_schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workforce_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workforce_identity_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."zendesk_agent_directory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."zendesk_sync_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."zendesk_sync_state" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."acquire_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid", "p_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acquire_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid", "p_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."advance_zendesk_sync_state"("p_stream_key" "text", "p_lock_token" "uuid", "p_cursor" "text", "p_start_time" bigint, "p_last_event_timestamp" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."advance_zendesk_sync_state"("p_stream_key" "text", "p_lock_token" "uuid", "p_cursor" "text", "p_start_time" bigint, "p_last_event_timestamp" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."capture_agent_identity_from_productivity"() TO "anon";
GRANT ALL ON FUNCTION "public"."capture_agent_identity_from_productivity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."capture_agent_identity_from_productivity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_user_can_edit_articles"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_can_edit_articles"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_edit_articles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_edit_articles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_admin_article_access"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_admin_article_access"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_admin_article_access"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text", "p_time_zone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text", "p_time_zone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_agent_analytics_dashboard"("p_start_date" "date", "p_end_date" "date", "p_agent_key" "text", "p_time_zone" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_filtered_data"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text", "p_period_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text", "p_period_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_period_comparison"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text", "p_period_kind" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dashboard_reporting_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_reporting_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_reporting_status"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sla_response_dashboard"("p_start_date" "date", "p_end_date" "date", "p_app_key" "text", "p_platform_key" "text", "p_country_key" "text", "p_driver_key" "text", "p_agent_key" "text", "p_priority" "text", "p_channel" "text", "p_time_zone" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_unresolved_zendesk_agent_ids"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_unresolved_zendesk_agent_ids"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_agent_productivity_aht_unit"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_agent_productivity_aht_unit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_agent_productivity_aht_unit"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date", "p_end_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_dashboard_export"("p_dataset" "text", "p_row_count" integer, "p_start_date" "date", "p_end_date" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_dashboard_quality_operations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_dashboard_quality_operations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_dashboard_sync_operations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_dashboard_sync_operations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_sheet_sync_quality_results"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_sheet_sync_quality_results"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_daily_operations_metrics"("p_start_date" "date", "p_end_date" "date", "p_time_zone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_daily_operations_metrics"("p_start_date" "date", "p_end_date" "date", "p_time_zone" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_zendesk_sync_lock"("p_stream_key" "text", "p_lock_token" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_article_update_metadata"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_article_update_metadata"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_article_update_metadata"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_article_update_metadata"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_ticket_dimension_profiles"("p_profiles" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_ticket_dimension_profiles"("p_profiles" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid", "p_supervisor_id" "uuid", "p_timezone" "text", "p_permissions" "jsonb", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid", "p_supervisor_id" "uuid", "p_timezone" "text", "p_permissions" "jsonb", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_admin_save_employee"("p_user_id" "uuid", "p_full_name" "text", "p_employee_id" "text", "p_employment_status" "text", "p_access_type" "text", "p_team_id" "uuid", "p_supervisor_id" "uuid", "p_timezone" "text", "p_permissions" "jsonb", "p_reason" "text") TO "service_role";



GRANT ALL ON TABLE "public"."work_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."work_schedules" TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_admin_save_schedule"("p_schedule_id" "uuid", "p_user_id" "uuid", "p_shift_date" "date", "p_shift_sequence" integer, "p_shift_start" timestamp with time zone, "p_shift_end" timestamp with time zone, "p_timezone" "text", "p_status" "text", "p_is_rest_day" boolean, "p_is_holiday" boolean, "p_holiday_name" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_admin_save_schedule"("p_schedule_id" "uuid", "p_user_id" "uuid", "p_shift_date" "date", "p_shift_sequence" integer, "p_shift_start" timestamp with time zone, "p_shift_end" timestamp with time zone, "p_timezone" "text", "p_status" "text", "p_is_rest_day" boolean, "p_is_holiday" boolean, "p_holiday_name" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_admin_save_schedule"("p_schedule_id" "uuid", "p_user_id" "uuid", "p_shift_date" "date", "p_shift_sequence" integer, "p_shift_start" timestamp with time zone, "p_shift_end" timestamp with time zone, "p_timezone" "text", "p_status" "text", "p_is_rest_day" boolean, "p_is_holiday" boolean, "p_holiday_name" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_audit_row_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_audit_row_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_audit_row_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer, "p_is_rest_day" boolean, "p_is_holiday" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_calculate_attendance"("p_scheduled_start" timestamp with time zone, "p_scheduled_end" timestamp with time zone, "p_clock_in" timestamp with time zone, "p_clock_out" timestamp with time zone, "p_scheduled_work_date" "date", "p_timezone" "text", "p_available_overtime_minutes" integer, "p_is_rest_day" boolean, "p_is_holiday" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_can_approve_attendance"("p_target_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_can_correct_attendance"("p_target_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_can_manage_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_can_view_user"("p_target_user_id" "uuid", "p_permission_key" "text") TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leave_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."leave_requests" TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_cancel_leave_request"("p_request_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."attendance" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance" TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_clock_in"("p_schedule_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_clock_in"("p_schedule_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_clock_in"("p_schedule_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_clock_out"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_clock_out"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_clock_out"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid", "p_admin_notes" "text", "p_reason_code" "text", "p_reason_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid", "p_admin_notes" "text", "p_reason_code" "text", "p_reason_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_correct_attendance"("p_attendance_id" "uuid", "p_new_clock_in" timestamp with time zone, "p_new_clock_out" timestamp with time zone, "p_new_status" "text", "p_schedule_id" "uuid", "p_admin_notes" "text", "p_reason_code" "text", "p_reason_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."workforce_current_profile_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_current_profile_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_current_profile_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_current_profile_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_current_user_is_active"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_active"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_active"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_active"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_current_user_is_agent"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_agent"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_agent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_current_user_is_agent"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_enforce_admin_payroll_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_enforce_admin_payroll_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_enforce_admin_payroll_profile"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_get_current_access"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_get_current_access"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_get_current_access"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_has_permission"("p_permission_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_is_assigned_supervisor"("p_target_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_is_authorized_attendance_admin"("p_permission_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."workforce_is_current_identity"("p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_is_current_identity"("p_target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_is_current_identity"("p_target_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_list_team_attendance"("p_start_date" "date", "p_end_date" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."workforce_normalize_timezone_default"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_normalize_timezone_default"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_normalize_timezone_default"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_normalize_timezone_default"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_prepare_attendance_storage"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_prepare_attendance_storage"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_prepare_attendance_storage"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_recalculate_attendance"("p_attendance_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_recalculate_attendance"("p_attendance_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_recalculate_attendance_work_date"("p_user_id" "uuid", "p_work_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_recalculate_attendance_work_date"("p_user_id" "uuid", "p_work_date" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."workforce_review_leave_request"("p_request_id" "uuid", "p_status" "text", "p_review_notes" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."workforce_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_sync_admin_payroll_permission"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_sync_admin_payroll_permission"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_sync_admin_payroll_permission"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_login"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_login"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_login"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_sync_identity_link_from_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_sync_login_record"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_sync_login_record"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_sync_login_record"() TO "service_role";



GRANT ALL ON FUNCTION "public"."workforce_sync_profile_compatibility"() TO "anon";
GRANT ALL ON FUNCTION "public"."workforce_sync_profile_compatibility"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."workforce_sync_profile_compatibility"() TO "service_role";


















GRANT ALL ON TABLE "public"."agent_dimension_metrics" TO "service_role";
GRANT SELECT ON TABLE "public"."agent_dimension_metrics" TO "authenticated";



GRANT ALL ON TABLE "public"."agent_identity_map" TO "anon";
GRANT ALL ON TABLE "public"."agent_identity_map" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_identity_map" TO "service_role";



GRANT ALL ON TABLE "public"."agent_productivity" TO "service_role";
GRANT SELECT ON TABLE "public"."agent_productivity" TO "authenticated";



GRANT ALL ON TABLE "public"."articles" TO "anon";
GRANT ALL ON TABLE "public"."articles" TO "authenticated";
GRANT ALL ON TABLE "public"."articles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."articles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."articles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."articles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_corrections" TO "anon";
GRANT ALL ON TABLE "public"."attendance_corrections" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_corrections" TO "service_role";



GRANT ALL ON TABLE "public"."daily_distribution_metrics" TO "service_role";
GRANT SELECT ON TABLE "public"."daily_distribution_metrics" TO "authenticated";



GRANT ALL ON TABLE "public"."daily_operations_metrics" TO "service_role";
GRANT SELECT ON TABLE "public"."daily_operations_metrics" TO "authenticated";



GRANT ALL ON TABLE "public"."daily_ticket_metrics" TO "service_role";
GRANT SELECT ON TABLE "public"."daily_ticket_metrics" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."daily_ticket_metrics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_ticket_metrics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_ticket_metrics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_alert_events" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_alert_events" TO "authenticated";



GRANT ALL ON TABLE "public"."sheet_sync_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."sheet_sync_runs" TO "authenticated";



GRANT ALL ON TABLE "public"."dashboard_sync_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_sync_runs" TO "authenticated";



GRANT ALL ON TABLE "public"."dashboard_active_alerts" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_active_alerts" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."dashboard_alert_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dashboard_alert_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dashboard_alert_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_audit_events" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_audit_events" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."dashboard_audit_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dashboard_audit_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dashboard_audit_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_data_quality_results" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_data_quality_results" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."dashboard_data_quality_results_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dashboard_data_quality_results_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dashboard_data_quality_results_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_filter_capabilities" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_filter_capabilities" TO "authenticated";



GRANT ALL ON TABLE "public"."dashboard_targets" TO "service_role";
GRANT SELECT ON TABLE "public"."dashboard_targets" TO "authenticated";



GRANT ALL ON TABLE "public"."google_calendar_connections" TO "service_role";



GRANT ALL ON TABLE "public"."google_calendar_oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."login" TO "anon";
GRANT ALL ON TABLE "public"."login" TO "authenticated";
GRANT ALL ON TABLE "public"."login" TO "service_role";



GRANT ALL ON SEQUENCE "public"."login_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."login_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."login_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."raw_sheet_imports" TO "anon";
GRANT ALL ON TABLE "public"."raw_sheet_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."raw_sheet_imports" TO "service_role";



GRANT ALL ON TABLE "public"."reporting_data_dictionary" TO "service_role";
GRANT SELECT ON TABLE "public"."reporting_data_dictionary" TO "authenticated";



GRANT ALL ON TABLE "public"."sheet_sync_metadata" TO "service_role";
GRANT SELECT ON TABLE "public"."sheet_sync_metadata" TO "authenticated";



GRANT ALL ON TABLE "public"."teams" TO "authenticated";
GRANT ALL ON TABLE "public"."teams" TO "service_role";



GRANT ALL ON TABLE "public"."ticket_dimension_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."ticket_driver_metrics" TO "service_role";
GRANT SELECT ON TABLE "public"."ticket_driver_metrics" TO "authenticated";



GRANT ALL ON TABLE "public"."ticket_events" TO "service_role";
GRANT SELECT ON TABLE "public"."ticket_events" TO "authenticated";



GRANT ALL ON TABLE "public"."user_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."user_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."workforce_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."workforce_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."workforce_identity_links" TO "service_role";



GRANT ALL ON TABLE "public"."zendesk_agent_directory" TO "service_role";
GRANT SELECT ON TABLE "public"."zendesk_agent_directory" TO "authenticated";



GRANT ALL ON TABLE "public"."zendesk_sync_runs" TO "service_role";



GRANT ALL ON TABLE "public"."zendesk_sync_state" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

revoke references on table "public"."agent_dimension_metrics" from "anon";

revoke trigger on table "public"."agent_dimension_metrics" from "anon";

revoke truncate on table "public"."agent_dimension_metrics" from "anon";

revoke references on table "public"."agent_dimension_metrics" from "authenticated";

revoke trigger on table "public"."agent_dimension_metrics" from "authenticated";

revoke truncate on table "public"."agent_dimension_metrics" from "authenticated";

revoke references on table "public"."agent_productivity" from "anon";

revoke trigger on table "public"."agent_productivity" from "anon";

revoke truncate on table "public"."agent_productivity" from "anon";

revoke references on table "public"."agent_productivity" from "authenticated";

revoke trigger on table "public"."agent_productivity" from "authenticated";

revoke truncate on table "public"."agent_productivity" from "authenticated";

revoke references on table "public"."attendance" from "anon";

revoke trigger on table "public"."attendance" from "anon";

revoke truncate on table "public"."attendance" from "anon";

revoke references on table "public"."daily_distribution_metrics" from "anon";

revoke trigger on table "public"."daily_distribution_metrics" from "anon";

revoke truncate on table "public"."daily_distribution_metrics" from "anon";

revoke references on table "public"."daily_distribution_metrics" from "authenticated";

revoke trigger on table "public"."daily_distribution_metrics" from "authenticated";

revoke truncate on table "public"."daily_distribution_metrics" from "authenticated";

revoke references on table "public"."daily_operations_metrics" from "anon";

revoke trigger on table "public"."daily_operations_metrics" from "anon";

revoke truncate on table "public"."daily_operations_metrics" from "anon";

revoke references on table "public"."daily_operations_metrics" from "authenticated";

revoke trigger on table "public"."daily_operations_metrics" from "authenticated";

revoke truncate on table "public"."daily_operations_metrics" from "authenticated";

revoke references on table "public"."daily_ticket_metrics" from "anon";

revoke trigger on table "public"."daily_ticket_metrics" from "anon";

revoke truncate on table "public"."daily_ticket_metrics" from "anon";

revoke references on table "public"."daily_ticket_metrics" from "authenticated";

revoke trigger on table "public"."daily_ticket_metrics" from "authenticated";

revoke truncate on table "public"."daily_ticket_metrics" from "authenticated";

revoke references on table "public"."dashboard_alert_events" from "anon";

revoke trigger on table "public"."dashboard_alert_events" from "anon";

revoke truncate on table "public"."dashboard_alert_events" from "anon";

revoke references on table "public"."dashboard_alert_events" from "authenticated";

revoke trigger on table "public"."dashboard_alert_events" from "authenticated";

revoke truncate on table "public"."dashboard_alert_events" from "authenticated";

revoke references on table "public"."dashboard_audit_events" from "anon";

revoke trigger on table "public"."dashboard_audit_events" from "anon";

revoke truncate on table "public"."dashboard_audit_events" from "anon";

revoke references on table "public"."dashboard_audit_events" from "authenticated";

revoke trigger on table "public"."dashboard_audit_events" from "authenticated";

revoke truncate on table "public"."dashboard_audit_events" from "authenticated";

revoke references on table "public"."dashboard_data_quality_results" from "anon";

revoke trigger on table "public"."dashboard_data_quality_results" from "anon";

revoke truncate on table "public"."dashboard_data_quality_results" from "anon";

revoke references on table "public"."dashboard_data_quality_results" from "authenticated";

revoke trigger on table "public"."dashboard_data_quality_results" from "authenticated";

revoke truncate on table "public"."dashboard_data_quality_results" from "authenticated";

revoke references on table "public"."dashboard_targets" from "anon";

revoke trigger on table "public"."dashboard_targets" from "anon";

revoke truncate on table "public"."dashboard_targets" from "anon";

revoke references on table "public"."dashboard_targets" from "authenticated";

revoke trigger on table "public"."dashboard_targets" from "authenticated";

revoke truncate on table "public"."dashboard_targets" from "authenticated";

revoke references on table "public"."google_calendar_connections" from "anon";

revoke trigger on table "public"."google_calendar_connections" from "anon";

revoke truncate on table "public"."google_calendar_connections" from "anon";

revoke references on table "public"."google_calendar_connections" from "authenticated";

revoke trigger on table "public"."google_calendar_connections" from "authenticated";

revoke truncate on table "public"."google_calendar_connections" from "authenticated";

revoke references on table "public"."google_calendar_oauth_states" from "anon";

revoke trigger on table "public"."google_calendar_oauth_states" from "anon";

revoke truncate on table "public"."google_calendar_oauth_states" from "anon";

revoke references on table "public"."google_calendar_oauth_states" from "authenticated";

revoke trigger on table "public"."google_calendar_oauth_states" from "authenticated";

revoke truncate on table "public"."google_calendar_oauth_states" from "authenticated";

revoke references on table "public"."leave_requests" from "anon";

revoke trigger on table "public"."leave_requests" from "anon";

revoke truncate on table "public"."leave_requests" from "anon";

revoke references on table "public"."profiles" from "anon";

revoke trigger on table "public"."profiles" from "anon";

revoke truncate on table "public"."profiles" from "anon";

revoke references on table "public"."reporting_data_dictionary" from "anon";

revoke trigger on table "public"."reporting_data_dictionary" from "anon";

revoke truncate on table "public"."reporting_data_dictionary" from "anon";

revoke references on table "public"."reporting_data_dictionary" from "authenticated";

revoke trigger on table "public"."reporting_data_dictionary" from "authenticated";

revoke truncate on table "public"."reporting_data_dictionary" from "authenticated";

revoke references on table "public"."sheet_sync_metadata" from "anon";

revoke trigger on table "public"."sheet_sync_metadata" from "anon";

revoke truncate on table "public"."sheet_sync_metadata" from "anon";

revoke references on table "public"."sheet_sync_metadata" from "authenticated";

revoke trigger on table "public"."sheet_sync_metadata" from "authenticated";

revoke truncate on table "public"."sheet_sync_metadata" from "authenticated";

revoke references on table "public"."sheet_sync_runs" from "anon";

revoke trigger on table "public"."sheet_sync_runs" from "anon";

revoke truncate on table "public"."sheet_sync_runs" from "anon";

revoke references on table "public"."sheet_sync_runs" from "authenticated";

revoke trigger on table "public"."sheet_sync_runs" from "authenticated";

revoke truncate on table "public"."sheet_sync_runs" from "authenticated";

revoke references on table "public"."teams" from "anon";

revoke trigger on table "public"."teams" from "anon";

revoke truncate on table "public"."teams" from "anon";

revoke references on table "public"."ticket_dimension_profiles" from "anon";

revoke trigger on table "public"."ticket_dimension_profiles" from "anon";

revoke truncate on table "public"."ticket_dimension_profiles" from "anon";

revoke references on table "public"."ticket_dimension_profiles" from "authenticated";

revoke trigger on table "public"."ticket_dimension_profiles" from "authenticated";

revoke truncate on table "public"."ticket_dimension_profiles" from "authenticated";

revoke references on table "public"."ticket_driver_metrics" from "anon";

revoke trigger on table "public"."ticket_driver_metrics" from "anon";

revoke truncate on table "public"."ticket_driver_metrics" from "anon";

revoke references on table "public"."ticket_driver_metrics" from "authenticated";

revoke trigger on table "public"."ticket_driver_metrics" from "authenticated";

revoke truncate on table "public"."ticket_driver_metrics" from "authenticated";

revoke references on table "public"."ticket_events" from "anon";

revoke trigger on table "public"."ticket_events" from "anon";

revoke truncate on table "public"."ticket_events" from "anon";

revoke references on table "public"."ticket_events" from "authenticated";

revoke trigger on table "public"."ticket_events" from "authenticated";

revoke truncate on table "public"."ticket_events" from "authenticated";

revoke references on table "public"."user_permissions" from "anon";

revoke trigger on table "public"."user_permissions" from "anon";

revoke truncate on table "public"."user_permissions" from "anon";

revoke references on table "public"."work_schedules" from "anon";

revoke trigger on table "public"."work_schedules" from "anon";

revoke truncate on table "public"."work_schedules" from "anon";

revoke references on table "public"."workforce_audit_logs" from "anon";

revoke trigger on table "public"."workforce_audit_logs" from "anon";

revoke truncate on table "public"."workforce_audit_logs" from "anon";

revoke references on table "public"."workforce_identity_links" from "anon";

revoke trigger on table "public"."workforce_identity_links" from "anon";

revoke truncate on table "public"."workforce_identity_links" from "anon";

revoke references on table "public"."workforce_identity_links" from "authenticated";

revoke trigger on table "public"."workforce_identity_links" from "authenticated";

revoke truncate on table "public"."workforce_identity_links" from "authenticated";

revoke references on table "public"."zendesk_agent_directory" from "anon";

revoke trigger on table "public"."zendesk_agent_directory" from "anon";

revoke truncate on table "public"."zendesk_agent_directory" from "anon";

revoke references on table "public"."zendesk_agent_directory" from "authenticated";

revoke trigger on table "public"."zendesk_agent_directory" from "authenticated";

revoke truncate on table "public"."zendesk_agent_directory" from "authenticated";

revoke references on table "public"."zendesk_sync_runs" from "anon";

revoke trigger on table "public"."zendesk_sync_runs" from "anon";

revoke truncate on table "public"."zendesk_sync_runs" from "anon";

revoke references on table "public"."zendesk_sync_runs" from "authenticated";

revoke trigger on table "public"."zendesk_sync_runs" from "authenticated";

revoke truncate on table "public"."zendesk_sync_runs" from "authenticated";

revoke references on table "public"."zendesk_sync_state" from "anon";

revoke trigger on table "public"."zendesk_sync_state" from "anon";

revoke truncate on table "public"."zendesk_sync_state" from "anon";

revoke references on table "public"."zendesk_sync_state" from "authenticated";

revoke trigger on table "public"."zendesk_sync_state" from "authenticated";

revoke truncate on table "public"."zendesk_sync_state" from "authenticated";


  create policy "Article editors can delete article images"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'article-images'::text) AND public.current_user_can_edit_articles()));



  create policy "Article editors can upload article images"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'article-images'::text) AND public.current_user_can_edit_articles()));



  create policy "Public can view article images"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'article-images'::text));


