-- Phase 1 Workforce Foundation
--
-- This migration is additive. It preserves public.login as the compatibility
-- source for the existing dashboard, user-management, and article features.
-- Apply in a non-production Supabase project first and run the companion
-- verification script before production deployment.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  supervisor_id uuid,
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teams_name_not_blank check (length(trim(name)) > 0)
);

create unique index if not exists teams_name_lower_unique
  on public.teams (lower(name));

create table if not exists public.profiles (
  user_id uuid primary key,
  full_name text not null,
  email text not null,
  employee_id text not null,
  employment_status text not null default 'active',
  base_role text not null default 'agent',
  team_id uuid references public.teams(id) on delete set null,
  supervisor_id uuid,
  can_edit_articles boolean not null default false,
  can_manage_payroll boolean not null default false,
  timezone text not null default 'Asia/Manila',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_not_blank check (length(trim(full_name)) > 0),
  constraint profiles_email_not_blank check (length(trim(email)) > 0),
  constraint profiles_employee_id_not_blank check (length(trim(employee_id)) > 0),
  constraint profiles_employment_status_check check (
    employment_status in ('active', 'on_leave', 'inactive', 'terminated')
  ),
  constraint profiles_base_role_check check (base_role in ('admin', 'agent')),
  constraint profiles_no_self_supervision check (supervisor_id is null or supervisor_id <> user_id)
);

create unique index if not exists profiles_email_lower_unique
  on public.profiles (lower(email));

create unique index if not exists profiles_employee_id_lower_unique
  on public.profiles (lower(employee_id));

create index if not exists profiles_team_id_idx
  on public.profiles (team_id);

create index if not exists profiles_supervisor_id_idx
  on public.profiles (supervisor_id);

create index if not exists profiles_employment_status_idx
  on public.profiles (employment_status);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'teams_supervisor_profile_fk'
      and conrelid = 'public.teams'::regclass
  ) then
    alter table public.teams
      add constraint teams_supervisor_profile_fk
      foreign key (supervisor_id)
      references public.profiles(user_id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_supervisor_profile_fk'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_supervisor_profile_fk
      foreign key (supervisor_id)
      references public.profiles(user_id)
      on delete set null;
  end if;
end
$$;

create table if not exists public.user_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete restrict,
  permission_key text not null,
  is_granted boolean not null default true,
  granted_by uuid,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_permissions_permission_key_check check (
    permission_key in (
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles',
      'manage_payroll'
    )
  ),
  constraint user_permissions_user_key_unique unique (user_id, permission_key)
);

create index if not exists user_permissions_lookup_idx
  on public.user_permissions (user_id, permission_key, is_granted);

create table if not exists public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete restrict,
  team_id uuid references public.teams(id) on delete set null,
  shift_date date not null,
  shift_sequence smallint not null default 1,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text not null default 'Asia/Manila',
  status text not null default 'scheduled',
  is_rest_day boolean not null default false,
  is_holiday boolean not null default false,
  holiday_name text,
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_schedules_sequence_positive check (shift_sequence > 0),
  constraint work_schedules_status_check check (
    status in ('scheduled', 'published', 'changed', 'cancelled', 'completed')
  ),
  constraint work_schedules_time_check check (
    (
      is_rest_day is true
      and shift_start is null
      and shift_end is null
    )
    or
    (
      is_rest_day is false
      and shift_start is not null
      and shift_end is not null
      and shift_end > shift_start
    )
  ),
  constraint work_schedules_user_date_sequence_unique
    unique (user_id, shift_date, shift_sequence)
);

create index if not exists work_schedules_user_date_idx
  on public.work_schedules (user_id, shift_date);

create index if not exists work_schedules_team_date_idx
  on public.work_schedules (team_id, shift_date);

create index if not exists work_schedules_status_idx
  on public.work_schedules (status);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete restrict,
  schedule_id uuid references public.work_schedules(id) on delete set null,
  work_date date not null,
  clock_in timestamptz,
  clock_out timestamptz,
  attendance_status text not null default 'present',
  is_late boolean not null default false,
  minutes_late integer not null default 0,
  overtime_minutes integer not null default 0,
  undertime_minutes integer not null default 0,
  correction_reason text,
  admin_notes text,
  corrected_by uuid,
  corrected_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_status_check check (
    attendance_status in ('present', 'absent', 'on_leave', 'excused')
  ),
  constraint attendance_nonnegative_minutes check (
    minutes_late >= 0
    and overtime_minutes >= 0
    and undertime_minutes >= 0
  ),
  constraint attendance_clock_order check (
    clock_out is null or (clock_in is not null and clock_out >= clock_in)
  ),
  constraint attendance_user_work_date_unique unique (user_id, work_date)
);

create index if not exists attendance_user_date_idx
  on public.attendance (user_id, work_date);

create index if not exists attendance_status_date_idx
  on public.attendance (attendance_status, work_date);

create index if not exists attendance_schedule_id_idx
  on public.attendance (schedule_id);

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete restrict,
  leave_type text not null,
  start_date date not null,
  end_date date not null,
  reason text not null,
  status text not null default 'pending',
  review_notes text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_requests_type_check check (
    leave_type in ('vacation', 'sick', 'emergency', 'unpaid', 'other')
  ),
  constraint leave_requests_status_check check (
    status in ('pending', 'approved', 'rejected', 'cancelled')
  ),
  constraint leave_requests_date_order check (end_date >= start_date),
  constraint leave_requests_reason_not_blank check (length(trim(reason)) > 0),
  constraint leave_requests_review_check check (
    (
      status = 'pending'
      and reviewed_by is null
      and reviewed_at is null
    )
    or status = 'cancelled'
    or (
      status in ('approved', 'rejected')
      and reviewed_by is not null
      and reviewed_at is not null
    )
  )
);

create index if not exists leave_requests_user_dates_idx
  on public.leave_requests (user_id, start_date, end_date);

create index if not exists leave_requests_status_idx
  on public.leave_requests (status, created_at);

create table if not exists public.workforce_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now(),
  constraint workforce_audit_logs_action_not_blank check (length(trim(action)) > 0),
  constraint workforce_audit_logs_entity_not_blank check (length(trim(entity_type)) > 0)
);

create index if not exists workforce_audit_logs_entity_idx
  on public.workforce_audit_logs (entity_type, entity_id, created_at desc);

create index if not exists workforce_audit_logs_actor_idx
  on public.workforce_audit_logs (actor_user_id, created_at desc);

create index if not exists workforce_audit_logs_created_at_idx
  on public.workforce_audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------

create or replace function public.workforce_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.workforce_audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

-- Updated-at triggers.
drop trigger if exists teams_set_updated_at on public.teams;
create trigger teams_set_updated_at
before update on public.teams
for each row execute function public.workforce_set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.workforce_set_updated_at();

drop trigger if exists user_permissions_set_updated_at on public.user_permissions;
create trigger user_permissions_set_updated_at
before update on public.user_permissions
for each row execute function public.workforce_set_updated_at();

drop trigger if exists work_schedules_set_updated_at on public.work_schedules;
create trigger work_schedules_set_updated_at
before update on public.work_schedules
for each row execute function public.workforce_set_updated_at();

drop trigger if exists attendance_set_updated_at on public.attendance;
create trigger attendance_set_updated_at
before update on public.attendance
for each row execute function public.workforce_set_updated_at();

drop trigger if exists leave_requests_set_updated_at on public.leave_requests;
create trigger leave_requests_set_updated_at
before update on public.leave_requests
for each row execute function public.workforce_set_updated_at();

-- Audit triggers.
drop trigger if exists teams_workforce_audit on public.teams;
create trigger teams_workforce_audit
after insert or update or delete on public.teams
for each row execute function public.workforce_audit_row_change('id');

drop trigger if exists profiles_workforce_audit on public.profiles;
create trigger profiles_workforce_audit
after insert or update or delete on public.profiles
for each row execute function public.workforce_audit_row_change('user_id');

drop trigger if exists user_permissions_workforce_audit on public.user_permissions;
create trigger user_permissions_workforce_audit
after insert or update or delete on public.user_permissions
for each row execute function public.workforce_audit_row_change('id');

drop trigger if exists work_schedules_workforce_audit on public.work_schedules;
create trigger work_schedules_workforce_audit
after insert or update or delete on public.work_schedules
for each row execute function public.workforce_audit_row_change('id');

drop trigger if exists attendance_workforce_audit on public.attendance;
create trigger attendance_workforce_audit
after insert or update or delete on public.attendance
for each row execute function public.workforce_audit_row_change('id');

drop trigger if exists leave_requests_workforce_audit on public.leave_requests;
create trigger leave_requests_workforce_audit
after insert or update or delete on public.leave_requests
for each row execute function public.workforce_audit_row_change('id');

-- ---------------------------------------------------------------------------
-- Backfill and compatibility synchronization
-- ---------------------------------------------------------------------------

insert into public.profiles (
  user_id,
  full_name,
  email,
  employee_id,
  employment_status,
  base_role,
  can_edit_articles,
  can_manage_payroll
)
select
  auth_user.id,
  coalesce(
    nullif(trim(login_user.name), ''),
    nullif(trim(auth_user.raw_user_meta_data ->> 'name'), ''),
    split_part(auth_user.email, '@', 1)
  ),
  lower(auth_user.email),
  'SL-' || upper(substr(replace(auth_user.id::text, '-', ''), 1, 8)),
  'active',
  case when login_user.is_admin is true then 'admin' else 'agent' end,
  coalesce(login_user.can_edit_articles, false),
  false
from auth.users auth_user
join public.login login_user
  on lower(login_user.email) = lower(auth_user.email)
where auth_user.email is not null
on conflict (user_id) do update
set
  full_name = excluded.full_name,
  email = excluded.email,
  base_role = excluded.base_role,
  can_edit_articles = excluded.can_edit_articles,
  updated_at = now();

insert into public.user_permissions (user_id, permission_key, is_granted, reason)
select profile.user_id, permission.permission_key, true, 'Backfilled from existing administrator access'
from public.profiles profile
cross join (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text)
) as permission(permission_key)
where profile.base_role = 'admin'
on conflict (user_id, permission_key) do update
set is_granted = excluded.is_granted,
    reason = excluded.reason,
    updated_at = now();

insert into public.user_permissions (user_id, permission_key, is_granted, reason)
select user_id, 'edit_articles', true, 'Backfilled from existing article-editor access'
from public.profiles
where can_edit_articles is true
on conflict (user_id, permission_key) do update
set is_granted = excluded.is_granted,
    reason = excluded.reason,
    updated_at = now();

create or replace function public.workforce_sync_login_record()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
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
    can_edit_articles,
    can_manage_payroll
  ) values (
    v_user_id,
    v_name,
    v_email,
    'SL-' || upper(substr(replace(v_user_id::text, '-', ''), 1, 8)),
    'active',
    case when v_is_admin then 'admin' else 'agent' end,
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
      base_role = excluded.base_role,
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

drop trigger if exists login_workforce_sync on public.login;
create trigger login_workforce_sync
after insert or update or delete on public.login
for each row execute function public.workforce_sync_login_record();

-- ---------------------------------------------------------------------------
-- Permission and scope helpers
-- ---------------------------------------------------------------------------

create or replace function public.workforce_current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.user_id = auth.uid()
      and profile.employment_status in ('active', 'on_leave')
  );
$$;

create or replace function public.workforce_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_current_user_is_active()
    and (
      exists (
        select 1
        from public.profiles profile
        where profile.user_id = auth.uid()
          and profile.base_role = 'admin'
      )
      or exists (
        select 1
        from public.login login_user
        where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
          and login_user.is_admin is true
      )
    );
$$;

create or replace function public.workforce_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_current_user_is_active()
    and (
      exists (
        select 1
        from public.user_permissions permission
        where permission.user_id = auth.uid()
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

create or replace function public.workforce_is_assigned_supervisor(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles target
    left join public.teams team on team.id = target.team_id
    where target.user_id = p_target_user_id
      and (
        target.supervisor_id = auth.uid()
        or team.supervisor_id = auth.uid()
      )
  );
$$;

create or replace function public.workforce_can_manage_user(
  p_target_user_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_has_permission(p_permission_key)
    and (
      public.workforce_is_admin()
      or public.workforce_is_assigned_supervisor(p_target_user_id)
    );
$$;

create or replace function public.workforce_can_view_user(
  p_target_user_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() = p_target_user_id
    or public.workforce_can_manage_user(p_target_user_id, p_permission_key);
$$;

revoke all on function public.workforce_current_user_is_active() from public;
revoke all on function public.workforce_is_admin() from public;
revoke all on function public.workforce_has_permission(text) from public;
revoke all on function public.workforce_is_assigned_supervisor(uuid) from public;
revoke all on function public.workforce_can_manage_user(uuid, text) from public;
revoke all on function public.workforce_can_view_user(uuid, text) from public;

grant execute on function public.workforce_current_user_is_active() to authenticated;
grant execute on function public.workforce_is_admin() to authenticated;
grant execute on function public.workforce_has_permission(text) to authenticated;
grant execute on function public.workforce_is_assigned_supervisor(uuid) to authenticated;
grant execute on function public.workforce_can_manage_user(uuid, text) to authenticated;
grant execute on function public.workforce_can_view_user(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Secure attendance and leave workflow functions
-- ---------------------------------------------------------------------------

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
  if v_user_id is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
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
  if v_user_id is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
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

create or replace function public.workforce_cancel_leave_request(p_request_id uuid)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
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

create or replace function public.workforce_review_leave_request(
  p_request_id uuid,
  p_status text,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.leave_requests%rowtype;
  v_result public.leave_requests%rowtype;
begin
  if p_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected.';
  end if;

  select *
  into v_request
  from public.leave_requests
  where id = p_request_id;

  if not found then
    raise exception 'Leave request not found.';
  end if;

  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave') then
    raise exception 'You do not have permission to review this leave request.';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending leave requests can be reviewed.';
  end if;

  update public.leave_requests
  set status = p_status,
      review_notes = nullif(trim(coalesce(p_review_notes, '')), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public;
revoke all on function public.workforce_clock_out() from public;
revoke all on function public.workforce_cancel_leave_request(uuid) from public;
revoke all on function public.workforce_review_leave_request(uuid, text, text) from public;

grant execute on function public.workforce_clock_in(uuid) to authenticated;
grant execute on function public.workforce_clock_out() to authenticated;
grant execute on function public.workforce_cancel_leave_request(uuid) to authenticated;
grant execute on function public.workforce_review_leave_request(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.teams enable row level security;
alter table public.profiles enable row level security;
alter table public.user_permissions enable row level security;
alter table public.work_schedules enable row level security;
alter table public.attendance enable row level security;
alter table public.leave_requests enable row level security;
alter table public.workforce_audit_logs enable row level security;

-- Teams
drop policy if exists "Workforce users can view relevant teams" on public.teams;
create policy "Workforce users can view relevant teams"
on public.teams
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles self_profile
    where self_profile.user_id = auth.uid()
      and (
        self_profile.team_id = teams.id
        or teams.supervisor_id = auth.uid()
      )
  )
  or public.workforce_is_admin()
);

drop policy if exists "Workforce admins can insert teams" on public.teams;
create policy "Workforce admins can insert teams"
on public.teams
for insert
to authenticated
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

drop policy if exists "Workforce admins can update teams" on public.teams;
create policy "Workforce admins can update teams"
on public.teams
for update
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
)
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

drop policy if exists "Workforce admins can delete teams" on public.teams;
create policy "Workforce admins can delete teams"
on public.teams
for delete
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

-- Profiles
drop policy if exists "Users can view permitted workforce profiles" on public.profiles;
create policy "Users can view permitted workforce profiles"
on public.profiles
for select
to authenticated
using (
  auth.uid() = user_id
  or public.workforce_can_manage_user(user_id, 'manage_employees')
  or public.workforce_can_manage_user(user_id, 'manage_schedules')
  or public.workforce_can_manage_user(user_id, 'view_team_attendance')
  or public.workforce_can_manage_user(user_id, 'approve_leave')
  or public.workforce_can_manage_user(user_id, 'view_workforce_reports')
);

drop policy if exists "Workforce admins can insert profiles" on public.profiles;
create policy "Workforce admins can insert profiles"
on public.profiles
for insert
to authenticated
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

drop policy if exists "Authorized users can update workforce profiles" on public.profiles;
create policy "Authorized users can update workforce profiles"
on public.profiles
for update
to authenticated
using (public.workforce_can_manage_user(user_id, 'manage_employees'))
with check (public.workforce_can_manage_user(user_id, 'manage_employees'));

drop policy if exists "Workforce admins can delete profiles" on public.profiles;
create policy "Workforce admins can delete profiles"
on public.profiles
for delete
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

-- User permissions
drop policy if exists "Users can view their own permissions" on public.user_permissions;
create policy "Users can view their own permissions"
on public.user_permissions
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  )
);

drop policy if exists "Workforce admins can insert permissions" on public.user_permissions;
create policy "Workforce admins can insert permissions"
on public.user_permissions
for insert
to authenticated
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

drop policy if exists "Workforce admins can update permissions" on public.user_permissions;
create policy "Workforce admins can update permissions"
on public.user_permissions
for update
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
)
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

drop policy if exists "Workforce admins can delete permissions" on public.user_permissions;
create policy "Workforce admins can delete permissions"
on public.user_permissions
for delete
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);

-- Work schedules
drop policy if exists "Users can view permitted work schedules" on public.work_schedules;
create policy "Users can view permitted work schedules"
on public.work_schedules
for select
to authenticated
using (public.workforce_can_view_user(user_id, 'manage_schedules'));

drop policy if exists "Authorized users can insert work schedules" on public.work_schedules;
create policy "Authorized users can insert work schedules"
on public.work_schedules
for insert
to authenticated
with check (public.workforce_can_manage_user(user_id, 'manage_schedules'));

drop policy if exists "Authorized users can update work schedules" on public.work_schedules;
create policy "Authorized users can update work schedules"
on public.work_schedules
for update
to authenticated
using (public.workforce_can_manage_user(user_id, 'manage_schedules'))
with check (public.workforce_can_manage_user(user_id, 'manage_schedules'));

drop policy if exists "Authorized users can delete work schedules" on public.work_schedules;
create policy "Authorized users can delete work schedules"
on public.work_schedules
for delete
to authenticated
using (public.workforce_can_manage_user(user_id, 'manage_schedules'));

-- Attendance
drop policy if exists "Users can view permitted attendance" on public.attendance;
create policy "Users can view permitted attendance"
on public.attendance
for select
to authenticated
using (
  auth.uid() = user_id
  or public.workforce_can_manage_user(user_id, 'view_team_attendance')
  or public.workforce_can_manage_user(user_id, 'manage_schedules')
);

drop policy if exists "Authorized users can insert attendance" on public.attendance;
create policy "Authorized users can insert attendance"
on public.attendance
for insert
to authenticated
with check (public.workforce_can_manage_user(user_id, 'manage_schedules'));

drop policy if exists "Authorized users can update attendance" on public.attendance;
create policy "Authorized users can update attendance"
on public.attendance
for update
to authenticated
using (public.workforce_can_manage_user(user_id, 'manage_schedules'))
with check (public.workforce_can_manage_user(user_id, 'manage_schedules'));

drop policy if exists "Authorized users can delete attendance" on public.attendance;
create policy "Authorized users can delete attendance"
on public.attendance
for delete
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_schedules')
);

-- Leave requests
drop policy if exists "Users can view permitted leave requests" on public.leave_requests;
create policy "Users can view permitted leave requests"
on public.leave_requests
for select
to authenticated
using (public.workforce_can_view_user(user_id, 'approve_leave'));

drop policy if exists "Users can submit their own leave requests" on public.leave_requests;
create policy "Users can submit their own leave requests"
on public.leave_requests
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.workforce_current_user_is_active()
  and status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
);

drop policy if exists "Authorized users can update leave requests" on public.leave_requests;
create policy "Authorized users can update leave requests"
on public.leave_requests
for update
to authenticated
using (public.workforce_can_manage_user(user_id, 'approve_leave'))
with check (public.workforce_can_manage_user(user_id, 'approve_leave'));

drop policy if exists "Workforce admins can delete leave requests" on public.leave_requests;
create policy "Workforce admins can delete leave requests"
on public.leave_requests
for delete
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('approve_leave')
);

-- Audit logs
drop policy if exists "Workforce admins can view audit logs" on public.workforce_audit_logs;
create policy "Workforce admins can view audit logs"
on public.workforce_audit_logs
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

-- No insert, update, or delete policies are created for authenticated users on
-- workforce_audit_logs. Entries are written by security-definer triggers.

-- ---------------------------------------------------------------------------
-- Table privileges. RLS remains authoritative.
-- ---------------------------------------------------------------------------

revoke all on public.teams from anon;
revoke all on public.profiles from anon;
revoke all on public.user_permissions from anon;
revoke all on public.work_schedules from anon;
revoke all on public.attendance from anon;
revoke all on public.leave_requests from anon;
revoke all on public.workforce_audit_logs from anon;

grant select, insert, update, delete on public.teams to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.user_permissions to authenticated;
grant select, insert, update, delete on public.work_schedules to authenticated;
grant select, insert, update, delete on public.attendance to authenticated;
grant select, insert, update, delete on public.leave_requests to authenticated;
grant select on public.workforce_audit_logs to authenticated;

comment on table public.profiles is
  'Workforce employee profiles. public.login remains the compatibility access source during Phase 1.';

comment on table public.user_permissions is
  'Effective workforce, article-editor, and future payroll permission grants.';

comment on table public.workforce_audit_logs is
  'Append-only audit history populated by database triggers.';
