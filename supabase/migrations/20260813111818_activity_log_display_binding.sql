drop function if exists public.activity_log_list(text, date, date, text, text, integer, integer);
create or replace function public.activity_log_list(
  p_category text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_search text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  activity_id uuid,
  occurred_at timestamptz,
  category text,
  action_label text,
  done_by text,
  affected_user text,
  summary text,
  display_details text,
  status text,
  technical_details jsonb
)
language plpgsql
stable security definer
set search_path = ''
as $$
begin
  if not public.workforce_is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;

  return query
  with source_events as (
    select
      audit.id,
      audit.created_at,
      audit.action,
      audit.entity_type,
      audit.actor_user_id,
      audit.entity_id,
      audit.reason,
      coalesce(audit.after_data, '{}'::jsonb) as after_data,
      coalesce(audit.before_data, '{}'::jsonb) as before_data,
      null::uuid as payroll_record_id
    from public.workforce_audit_logs audit
    union all
    select
      audit.id,
      audit.created_at,
      audit.action,
      audit.entity_type,
      audit.actor_user_id,
      audit.entity_id,
      audit.reason,
      coalesce(audit.after_data, '{}'::jsonb) as after_data,
      coalesce(audit.before_data, '{}'::jsonb) as before_data,
      audit.payroll_record_id
    from public.payroll_audit_logs audit
  ), normalized as (
    select
      event.id,
      event.created_at,
      case
        when event.action like '%payroll%' or event.entity_type like 'payroll%' then 'Payroll'
        when event.action like '%attendance%' or event.entity_type = 'attendance' then 'Attendance'
        when event.action like '%schedule%' or event.entity_type like '%schedule%' then 'Schedules'
        when event.action like '%leave%' or event.entity_type = 'leave_request' then 'Leave'
        when event.action like '%permission%' or event.entity_type in ('profile', 'user', 'team', 'workforce_identity_link') then 'Users & Access'
        when event.action like '%admin%' then 'Admin Tools'
        when event.action like '%setting%' then 'Settings'
        else 'System'
      end as category,
      case event.action
        when 'attendance_correction_created' then 'Attendance corrected'
        when 'admin_assisted_clock_in' then 'Admin assisted clock-in'
        when 'admin_assisted_clock_out' then 'Admin assisted clock-out'
        when 'payroll_recalculated' then 'Payroll recalculated'
        when 'payroll_approved' then 'Payroll approved'
        when 'schedule_updated' then 'Schedule updated'
        when 'leave_approved' then 'Leave approved'
        when 'leave_rejected' then 'Leave rejected'
        when 'user_permission_changed' then 'User access updated'
        else initcap(replace(replace(event.action, '_', ' '), '-', ' '))
      end as action_label,
      case when actor.is_system_admin then 'System Admin'
        else coalesce(actor.full_name, 'An admin') end as done_by,
      coalesce(target.full_name, target.employee_id, '') as affected_user,
      coalesce(nullif(trim(event.reason), ''), nullif(event.after_data ->> 'summary', ''),
        initcap(replace(replace(event.action, '_', ' '), '-', ' '))) as summary,
      case
        when event.action like '%reject%' or event.action like '%fail%' or event.action like '%void%' then 'Needs attention'
        else 'Completed'
      end as status,
      jsonb_strip_nulls(jsonb_build_object(
        'action', event.action,
        'actor_is_system_admin', coalesce(actor.is_system_admin, false),
        'record_id', coalesce(event.entity_id, event.payroll_record_id),
        'entity_type', event.entity_type,
        'reason', nullif(trim(event.reason), ''),
        'before', case when event.before_data = '{}'::jsonb then null else event.before_data end,
        'after', case when event.after_data = '{}'::jsonb then null else event.after_data end
      )) as details
    from source_events event
    left join public.profiles actor on actor.user_id = event.actor_user_id
    left join public.profiles target on target.user_id = coalesce(
      nullif(event.after_data ->> 'target_employee_id', '')::uuid,
      case when event.entity_type in ('profile', 'user', 'employee') then event.entity_id end
    )
  )
  select normalized.id, normalized.created_at, normalized.category,
    normalized.action_label, normalized.done_by, normalized.affected_user,
    normalized.summary, normalized.summary as display_details,
    normalized.status, normalized.details as technical_details
  from normalized
  where (p_category is null or p_category = '' or normalized.category = p_category)
    and (p_date_from is null or normalized.created_at::date >= p_date_from)
    and (p_date_to is null or normalized.created_at::date <= p_date_to)
    and (p_status is null or p_status = '' or normalized.status = p_status)
    and (p_search is null or p_search = '' or concat_ws(' ', normalized.category,
      normalized.action_label, normalized.done_by, normalized.affected_user,
      normalized.summary) ilike '%' || p_search || '%')
  order by normalized.created_at desc, normalized.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.activity_log_list(text, date, date, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.activity_log_list(text, date, date, text, text, integer, integer) to authenticated;
