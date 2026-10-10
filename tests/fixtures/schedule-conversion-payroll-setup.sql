create role anon;
create role authenticated;
create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.profiles(
  user_id uuid primary key, team_id uuid, is_agent boolean not null default true,
  employment_status text not null default 'active'
);
create table public.work_schedule_template_assignments(id uuid primary key, user_id uuid, effective_from date, effective_until date, is_active boolean);
create table public.work_schedule_templates(id uuid primary key, timezone text, updated_at timestamptz);
create table public.work_schedules(
  id uuid primary key, user_id uuid not null, team_id uuid, shift_date date not null, shift_sequence smallint not null default 1,
  shift_start timestamptz, shift_end timestamptz, planned_paid_minutes integer,
  timezone text not null default 'America/New_York', status text not null default 'published',
  is_rest_day boolean not null default false, is_holiday boolean not null default false, holiday_name text,
  is_leave boolean not null default false, is_absent boolean not null default false,
  schedule_template_id uuid, schedule_version bigint not null default 1,
  updated_at timestamptz not null default now(), notes text, created_by uuid, updated_by uuid
);
create table public.leave_requests(
  id uuid primary key default gen_random_uuid(), user_id uuid not null, leave_type text not null default 'other',
  start_date date not null, end_date date not null, reason text not null, status text not null default 'pending',
  review_notes text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
  request_category text not null default 'leave', request_type text not null default 'leave',
  target_schedule_id uuid references public.work_schedules(id), requested_shift_start timestamptz,
  requested_shift_end timestamptz, requested_planned_paid_minutes integer,
  current_rest_weekdays smallint[], requested_rest_weekdays smallint[], target_schedule_version bigint,
  target_schedule_updated_at timestamptz, original_shift_start timestamptz, original_shift_end timestamptz,
  original_planned_paid_minutes integer, original_schedule_status text,
  leave_duration text not null default 'whole_day', leave_half text,
  requested_schedule_id uuid, requested_schedule_start timestamptz, requested_schedule_end timestamptz,
  requested_schedule_timezone text, requested_leave_start timestamptz, requested_leave_end timestamptz,
  requested_leave_minutes integer, constraint leave_requests_date_order check(end_date >= start_date)
);
create table public.attendance(id uuid primary key default gen_random_uuid(), user_id uuid not null, work_date date not null, schedule_id uuid, voided_at timestamptz, payroll_approved_at timestamptz);
create table public.payroll_periods(id uuid primary key default gen_random_uuid(), period_start date, period_end date, status text);
create table public.payroll_records(id uuid primary key default gen_random_uuid(), payroll_period_id uuid, employee_id uuid, status text);
create table public.payroll_v2_periods(id uuid primary key, period_start date, period_end date, status text);
create table public.payroll_v2_records(id uuid primary key, payroll_v2_period_id uuid, employee_user_id uuid, status text);
create table public.payroll_v2_attendance_snapshots(id uuid primary key default gen_random_uuid(), payroll_v2_record_id uuid, work_date date, source_schedule_ids uuid[]);
create table public.payroll_v2_committed_hours_snapshots(id uuid primary key default gen_random_uuid(), payroll_v2_record_id uuid, work_date date, commitment_source_id uuid);
create table public.payroll_prepaid_commitments(id uuid primary key, employee_id uuid, work_date date, superseded_at timestamptz, payroll_record_id uuid);
create table public.payroll_items(id uuid primary key default gen_random_uuid(), payroll_record_id uuid, metadata jsonb);
create table public.workforce_audit_logs(
  id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text, entity_type text,
  entity_id uuid, before_data jsonb, after_data jsonb, reason text, created_at timestamptz default now()
);
create function public.workforce_current_profile_id() returns uuid language sql stable as $$ select auth.uid() $$;
create function public.workforce_current_user_is_active() returns boolean language sql stable as $$ select auth.uid() is not null $$;
create function public.workforce_current_user_is_agent() returns boolean language sql stable as $$ select coalesce(current_setting('test.is_agent', true), 'false') = 'true' $$;
create function public.workforce_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.is_admin', true), 'false') = 'true' $$;
create function public.workforce_can_manage_user(p_user_id uuid, p_permission text) returns boolean language sql stable as $$ select public.workforce_is_admin() and coalesce(current_setting('test.can_manage', true), 'false') = 'true' $$;
create function public.workforce_effective_weekly_assignment(p_user_id uuid, p_work_date date)
returns table(assignment_id uuid, template_id uuid) language sql stable as $$ select null::uuid, null::uuid where false $$;
insert into public.profiles(user_id, is_agent, employment_status)
values ('11111111-1111-1111-1111-111111111111', true, 'active');
