with checks as (
  select
    'required_objects'::text as check_name,
    (
      to_regclass('public.ticket_dimension_profiles') is not null
      and to_regprocedure(
        'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'
      ) is not null
    ) as passed

  union all

  select
    'ticket_profile_uniqueness',
    not exists (
      select ticket_id
      from public.ticket_dimension_profiles
      group by ticket_id
      having count(*) > 1
    )

  union all

  select
    'ticket_profile_rls',
    coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.ticket_dimension_profiles'::regclass
    ), false)

  union all

  select
    'server_only_profile_table',
    not has_table_privilege(
      'authenticated',
      'public.ticket_dimension_profiles',
      'SELECT'
    )
    and not has_table_privilege(
      'anon',
      'public.ticket_dimension_profiles',
      'SELECT'
    )

  union all

  select
    'authenticated_filter_rpc',
    has_function_privilege(
      'authenticated',
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)',
      'EXECUTE'
    )

  union all

  select
    'dimension_backfill_cursor',
    (
      select count(*) = 1
      from public.zendesk_sync_state
      where stream_key = 'ticket_dimensions_backfill'
    )
)
select
  check_name,
  case when passed then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
