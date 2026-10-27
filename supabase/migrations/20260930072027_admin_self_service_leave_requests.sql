create or replace function public.workforce_submit_leave_request(
  p_leave_type text,
  p_start_date date,
  p_end_date date,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_profile_user_id uuid := public.workforce_current_profile_id();
  v_leave_type text := lower(trim(coalesce(p_leave_type, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null
     or v_profile_user_id is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_current_user_is_agent()
       or public.workforce_is_admin()
     ) then
    raise exception 'Authentication and an active workforce agent or administrator profile are required.';
  end if;

  if v_leave_type not in (
    'incentive_vl', 'birthday_vl', 'leave_without_pay'
  ) then
    raise exception 'Select a valid leave type.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date cannot be earlier than start date.';
  end if;

  if v_reason is null then
    raise exception 'Explain the reason for this leave request.';
  end if;

  if exists (
    select 1
    from public.leave_requests request
    where request.user_id = v_profile_user_id
      and request.status in ('pending', 'approved')
      and daterange(request.start_date, request.end_date, '[]')
        && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception 'A pending or approved leave request already overlaps these dates.';
  end if;

  insert into public.leave_requests (
    user_id,
    leave_type,
    start_date,
    end_date,
    reason,
    status
  ) values (
    v_profile_user_id,
    v_leave_type,
    p_start_date,
    p_end_date,
    v_reason,
    'pending'
  )
  returning * into v_result;

  return v_result;
end;
$function$;;
