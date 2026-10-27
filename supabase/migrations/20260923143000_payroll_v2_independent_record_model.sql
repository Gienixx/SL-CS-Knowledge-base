-- Establish Payroll V2's employee-level persistence model without creating
-- records, items, or snapshots while an employee is only being viewed.

create table public.payroll_v2_records (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_period_id uuid not null
    references public.payroll_v2_periods(id) on delete restrict,
  employee_user_id uuid not null
    references public.profiles(user_id) on delete restrict,
  status text not null,
  calculated_at timestamptz not null,
  approved_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_records_status_check
    check (status in ('calculated', 'approved', 'finalized', 'void')),
  constraint payroll_v2_records_approval_timestamp_check
    check (status not in ('approved', 'finalized') or approved_at is not null),
  constraint payroll_v2_records_finalization_timestamp_check
    check (status <> 'finalized' or finalized_at is not null),
  constraint payroll_v2_records_id_employee_key
    unique (id, employee_user_id)
);

create unique index payroll_v2_records_one_active_employee_period_idx
  on public.payroll_v2_records (payroll_v2_period_id, employee_user_id)
  where status <> 'void';

create index payroll_v2_records_employee_period_idx
  on public.payroll_v2_records (employee_user_id, payroll_v2_period_id);

create table public.payroll_v2_items (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_record_id uuid not null
    references public.payroll_v2_records(id) on delete restrict,
  item_type text not null,
  description text not null,
  work_date date,
  source_type text not null,
  source_id uuid,
  minutes integer,
  rate numeric(12, 4),
  amount numeric(12, 2) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_items_minutes_check
    check (minutes is null or minutes >= 0),
  constraint payroll_v2_items_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index payroll_v2_items_record_idx
  on public.payroll_v2_items (payroll_v2_record_id, created_at, id);

create table public.payroll_v2_attendance_snapshots (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_record_id uuid not null,
  employee_user_id uuid not null references public.profiles(user_id) on delete restrict,
  work_date date not null,
  source_attendance_ids uuid[] not null default '{}'::uuid[],
  source_schedule_ids uuid[] not null default '{}'::uuid[],
  classification text not null,
  regular_minutes integer not null default 0,
  additional_minutes integer not null default 0,
  payable_minutes integer not null default 0,
  approval_state text not null,
  payroll_readiness_state text not null,
  payroll_readiness_blockers text[] not null default '{}'::text[],
  billed_timestamps jsonb not null default '[]'::jsonb,
  schedule_details jsonb not null default '[]'::jsonb,
  source_rows jsonb not null default '[]'::jsonb,
  source_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_attendance_snapshots_record_employee_fkey
    foreign key (payroll_v2_record_id, employee_user_id)
    references public.payroll_v2_records(id, employee_user_id) on delete restrict,
  constraint payroll_v2_attendance_snapshots_record_date_key
    unique (payroll_v2_record_id, work_date),
  constraint payroll_v2_attendance_snapshots_minutes_check
    check (regular_minutes >= 0 and additional_minutes >= 0 and payable_minutes >= 0),
  constraint payroll_v2_attendance_snapshots_json_arrays_check
    check (
      jsonb_typeof(billed_timestamps) = 'array'
      and jsonb_typeof(schedule_details) = 'array'
      and jsonb_typeof(source_rows) = 'array'
      and jsonb_typeof(metadata) = 'object'
    )
);

create index payroll_v2_attendance_snapshots_employee_date_idx
  on public.payroll_v2_attendance_snapshots (employee_user_id, work_date);

create table public.payroll_v2_manual_earnings (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_period_id uuid not null
    references public.payroll_v2_periods(id) on delete restrict,
  employee_user_id uuid not null
    references public.profiles(user_id) on delete restrict,
  description text not null,
  amount numeric(12, 2) not null,
  status text not null default 'pending',
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  approved_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_manual_earnings_status_check
    check (status in ('pending', 'approved', 'rejected', 'void')),
  constraint payroll_v2_manual_earnings_approval_actor_check
    check (status <> 'approved' or approved_by is not null)
);

create index payroll_v2_manual_earnings_period_employee_idx
  on public.payroll_v2_manual_earnings
    (payroll_v2_period_id, employee_user_id, status, created_at);

-- All Payroll V2 data tables are kept behind permission-checked RPCs. No
-- browser role receives direct table access; no records are seeded here.
alter table public.payroll_v2_records enable row level security;
alter table public.payroll_v2_items enable row level security;
alter table public.payroll_v2_attendance_snapshots enable row level security;
alter table public.payroll_v2_manual_earnings enable row level security;

revoke all on table public.payroll_v2_records,
  public.payroll_v2_items,
  public.payroll_v2_attendance_snapshots,
  public.payroll_v2_manual_earnings
  from public, anon, authenticated;
grant all on table public.payroll_v2_records,
  public.payroll_v2_items,
  public.payroll_v2_attendance_snapshots,
  public.payroll_v2_manual_earnings
  to service_role;

comment on table public.payroll_v2_records is
  'Independent Payroll V2 employee-level records. Rows are created only by a future V2 calculation flow, never by viewing an employee.';
comment on table public.payroll_v2_items is
  'Independent Payroll V2 earnings and deductions. This table is never shared with V1 payroll_items.';
comment on table public.payroll_v2_attendance_snapshots is
  'Daily V2 calculation inputs with source attendance and schedule traceability; populate only during V2 calculation.';
comment on table public.payroll_v2_manual_earnings is
  'V2-owned manual earnings input source. No V1 manual earnings are migrated.';

-- A V2 payslip count is the number of persisted V2 employee records. V1
-- payroll_records are intentionally excluded.
create or replace function public.payroll_v2_list_periods()
returns table (
  period_id uuid,
  period_start date,
  period_end date,
  payment_date date,
  status text,
  created_at timestamptz,
  payslip_count bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception
      using errcode = '42501',
        message = 'You do not have permission to view Payroll Dashboard V2.';
  end if;

  return query
  select
    period.id,
    period.period_start,
    period.period_end,
    period.payment_date,
    period.status,
    period.created_at,
    (select count(*)::bigint
     from public.payroll_v2_records record
     where record.payroll_v2_period_id = period.id
       and record.status <> 'void')
  from public.payroll_v2_periods period
  order by period.period_start desc, period.created_at desc;
end;
$function$;

revoke all on function public.payroll_v2_list_periods()
  from public, anon, authenticated;
grant execute on function public.payroll_v2_list_periods()
  to authenticated, service_role;

-- Replace the V2-only status placeholder in the existing read model. If no
-- V2 record exists, the employee remains Not Calculated regardless of V1.
do $patch$
declare
  v_definition text;
  v_old text := $old$'payslip_status', 'Not Calculated',$old$;
  v_new text := $new$
      'payslip_status', coalesce((
        select pg_catalog.initcap(pg_catalog.replace(record.status, '_', ' '))
        from public.payroll_v2_records record
        where record.payroll_v2_period_id = v_period.id
          and record.employee_user_id = v_profile.user_id
          and record.status <> 'void'
      ), 'Not Calculated'),
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_v2_get_individual_payslip_data(uuid,uuid)'::regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Payroll V2 status placeholder was not found.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;

;
