-- Phase 1 Workforce access-type hardening
--
-- Distinguishes Admin from Admin and Agent, and ensures every elevated
-- permission remains explicitly grantable and revocable.

alter table public.profiles
  add column if not exists is_agent boolean not null default true;

comment on column public.profiles.is_agent is
  'Whether the profile participates in agent workflows such as schedules, attendance, and leave. Admin-only users set this to false.';

create or replace function public.workforce_current_user_is_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_current_user_is_active()
    and exists (
      select 1
      from public.profiles profile
      where profile.user_id = auth.uid()
        and profile.is_agent is true
    );
$$;

-- Permissions are explicit. Administrator status determines global scope, but
-- it does not override an individual permission that has not been granted.
create or replace function public.workforce_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_current_user_is_active()
    and exists (
      select 1
      from public.user_permissions permission
      where permission.user_id = auth.uid()
        and permission.permission_key = p_permission_key
        and permission.is_granted is true
    );
$$;

revoke all on function public.workforce_current_user_is_agent() from public;
grant execute on function public.workforce_current_user_is_agent() to authenticated;

-- Replace clock-in with an agent-participation check.
create or replace function public.workforce_clock_in(p_schedule_id uuid default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_work_date date;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  select timezone
  into v_timezone
  from public.profiles
  where user_id = v_user_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'Asia/Manila');
  v_work_date := (now() at time zone v_timezone)::date;

  if p_schedule_id is not null then
    select *
    into v_schedule
    from public.work_schedules
    where id = p_schedule_id
      and user_id = v_user_id;

    if not found then
      raise exception 'The selected schedule does not belong to the current user.';
    end if;

    if v_schedule.shift_date <> v_work_date then
      raise exception 'The selected schedule is not for the current work date.';
    end if;

    if v_schedule.is_rest_day or v_schedule.status = 'cancelled' then
      raise exception 'Clock-in is not available for this schedule.';
    end if;
  end if;

  select *
  into v_existing
  from public.attendance
  where user_id = v_user_id
    and work_date = v_work_date;

  if found then
    if v_existing.clock_in is not null then
      raise exception 'A clock-in has already been recorded for today.';
    end if;

    update public.attendance
    set clock_in = now(),
        schedule_id = coalesce(p_schedule_id, schedule_id),
        attendance_status = 'present',
        created_by = coalesce(created_by, v_user_id),
        updated_by = v_user_id
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
      v_user_id,
      p_schedule_id,
      v_work_date,
      now(),
      'present',
      v_user_id,
      v_user_id
    )
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

create or replace function public.workforce_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_work_date date;
  v_result public.attendance%rowtype;
begin
  if v_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  select timezone
  into v_timezone
  from public.profiles
  where user_id = v_user_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'Asia/Manila');
  v_work_date := (now() at time zone v_timezone)::date;

  update public.attendance
  set clock_out = now(),
      updated_by = v_user_id
  where user_id = v_user_id
    and work_date = v_work_date
    and clock_in is not null
    and clock_out is null
  returning * into v_result;

  if not found then
    raise exception 'No open attendance record was found for today.';
  end if;

  return v_result;
end;
$$;

-- Only profiles that participate as agents can submit leave requests for
-- themselves. Reviewers still use approve_leave and team/global scope.
drop policy if exists "Users can submit their own leave requests" on public.leave_requests;
create policy "Users can submit their own leave requests"
on public.leave_requests
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.workforce_current_user_is_agent()
  and status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
);
