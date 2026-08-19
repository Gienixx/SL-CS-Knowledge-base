-- Phase 2 Step 1: private payroll data model.
-- Access is intentionally closed to browser roles until the dedicated payroll
-- permissions and policies are introduced in Phase 2 Steps 2 and 3.

create table public.agent_rates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(user_id) on delete restrict,
  currency_code text not null default 'PHP',
  hourly_rate numeric(14,4),
  daily_rate numeric(14,4),
  monthly_rate numeric(14,4),
  overtime_rate numeric(14,4),
  holiday_rate numeric(14,4),
  effective_date date not null,
  rate_change_reason text not null,
  created_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint agent_rates_currency_code_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint agent_rates_nonnegative_check
    check (
      coalesce(hourly_rate, 0) >= 0
      and coalesce(daily_rate, 0) >= 0
      and coalesce(monthly_rate, 0) >= 0
      and coalesce(overtime_rate, 0) >= 0
      and coalesce(holiday_rate, 0) >= 0
    ),
  constraint agent_rates_has_base_rate_check
    check (num_nonnulls(hourly_rate, daily_rate, monthly_rate) >= 1),
  constraint agent_rates_reason_not_blank
    check (length(trim(rate_change_reason)) > 0),
  constraint agent_rates_employee_effective_date_key
    unique (employee_id, effective_date)
);

create table public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  payment_date date not null,
  status text not null default 'draft',
  currency_code text not null default 'PHP',
  rounding_rules jsonb not null default
    '{"money_scale":2,"minute_conversion":"exact","rounding_mode":"half_up"}'::jsonb,
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  approved_by uuid references public.profiles(user_id) on delete restrict,
  approved_at timestamptz,
  finalized_by uuid references public.profiles(user_id) on delete restrict,
  finalized_at timestamptz,
  reopened_by uuid references public.profiles(user_id) on delete restrict,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_periods_dates_check
    check (period_end >= period_start),
  constraint payroll_periods_payment_date_check
    check (payment_date >= period_end),
  constraint payroll_periods_status_check
    check (status in ('draft', 'review', 'approved', 'finalized', 'reopened', 'void')),
  constraint payroll_periods_currency_code_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint payroll_periods_rounding_rules_object_check
    check (jsonb_typeof(rounding_rules) = 'object'),
  constraint payroll_periods_approval_pair_check
    check ((approved_by is null) = (approved_at is null)),
  constraint payroll_periods_finalization_pair_check
    check ((finalized_by is null) = (finalized_at is null)),
  constraint payroll_periods_reopening_check
    check (
      (reopened_by is null and reopened_at is null and reopen_reason is null)
      or (
        reopened_by is not null
        and reopened_at is not null
        and length(trim(reopen_reason)) > 0
      )
    ),
  constraint payroll_periods_date_key
    unique (period_start, period_end)
);

create table public.payroll_records (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null
    references public.payroll_periods(id) on delete restrict,
  employee_id uuid not null references public.profiles(user_id) on delete restrict,
  status text not null default 'draft',
  currency_code text not null default 'PHP',
  regular_minutes integer not null default 0,
  regular_days numeric(10,4) not null default 0,
  overtime_minutes integer not null default 0,
  basic_pay numeric(14,2) not null default 0,
  overtime_pay numeric(14,2) not null default 0,
  holiday_pay numeric(14,2) not null default 0,
  other_earnings numeric(14,2) not null default 0,
  gross_pay numeric(14,2) not null default 0,
  late_deduction numeric(14,2) not null default 0,
  undertime_deduction numeric(14,2) not null default 0,
  unpaid_absence_deduction numeric(14,2) not null default 0,
  government_deductions numeric(14,2) not null default 0,
  other_deductions numeric(14,2) not null default 0,
  total_deductions numeric(14,2) not null default 0,
  net_pay numeric(14,2) not null default 0,
  requires_recalculation boolean not null default false,
  recalculation_reason text,
  calculation_version integer not null default 1,
  calculated_by uuid references public.profiles(user_id) on delete restrict,
  calculated_at timestamptz,
  reviewed_by uuid references public.profiles(user_id) on delete restrict,
  reviewed_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_records_period_employee_key
    unique (payroll_period_id, employee_id),
  constraint payroll_records_status_check
    check (status in ('draft', 'exception', 'ready_for_review', 'approved', 'finalized', 'void')),
  constraint payroll_records_currency_code_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint payroll_records_units_nonnegative_check
    check (
      regular_minutes >= 0
      and regular_days >= 0
      and overtime_minutes >= 0
      and calculation_version > 0
    ),
  constraint payroll_records_amounts_nonnegative_check
    check (
      basic_pay >= 0
      and overtime_pay >= 0
      and holiday_pay >= 0
      and other_earnings >= 0
      and gross_pay >= 0
      and late_deduction >= 0
      and undertime_deduction >= 0
      and unpaid_absence_deduction >= 0
      and government_deductions >= 0
      and other_deductions >= 0
      and total_deductions >= 0
      and net_pay >= 0
    ),
  constraint payroll_records_recalculation_reason_check
    check (
      not requires_recalculation
      or length(trim(recalculation_reason)) > 0
    )
);

create table public.payroll_items (
  id uuid primary key default gen_random_uuid(),
  payroll_record_id uuid not null
    references public.payroll_records(id) on delete restrict,
  item_type text not null,
  item_code text not null,
  description text not null,
  quantity numeric(14,4),
  unit_rate numeric(14,4),
  amount numeric(14,2) not null,
  rate_id uuid references public.agent_rates(id) on delete restrict,
  source_attendance_snapshot_id uuid,
  is_manual boolean not null default false,
  adjustment_reason text,
  correction_notes text,
  created_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payroll_items_type_check
    check (item_type in ('earning', 'deduction')),
  constraint payroll_items_code_not_blank
    check (length(trim(item_code)) > 0),
  constraint payroll_items_description_not_blank
    check (length(trim(description)) > 0),
  constraint payroll_items_quantity_nonnegative_check
    check (quantity is null or quantity >= 0),
  constraint payroll_items_unit_rate_nonnegative_check
    check (unit_rate is null or unit_rate >= 0),
  constraint payroll_items_amount_positive_check
    check (amount >= 0),
  constraint payroll_items_manual_reason_check
    check (
      not is_manual
      or length(trim(adjustment_reason)) > 0
    )
);

create table public.payroll_attendance_snapshots (
  id uuid primary key default gen_random_uuid(),
  payroll_record_id uuid not null
    references public.payroll_records(id) on delete restrict,
  attendance_id uuid not null references public.attendance(id) on delete restrict,
  employee_id uuid not null references public.profiles(user_id) on delete restrict,
  schedule_id uuid not null references public.work_schedules(id) on delete restrict,
  work_date date not null,
  clock_in timestamptz not null,
  clock_out timestamptz not null,
  regular_minutes integer not null,
  pre_shift_overtime_minutes integer not null,
  post_shift_overtime_minutes integer not null,
  total_overtime_minutes integer not null,
  late_minutes integer not null,
  undertime_minutes integer not null,
  attendance_version bigint not null,
  attendance_updated_at timestamptz not null,
  imported_at timestamptz not null default now(),
  constraint payroll_attendance_snapshots_record_attendance_key
    unique (payroll_record_id, attendance_id),
  constraint payroll_attendance_snapshots_minutes_check
    check (
      regular_minutes >= 0
      and pre_shift_overtime_minutes >= 0
      and post_shift_overtime_minutes >= 0
      and total_overtime_minutes >= 0
      and late_minutes >= 0
      and undertime_minutes >= 0
    ),
  constraint payroll_attendance_snapshots_clock_order_check
    check (clock_out >= clock_in),
  constraint payroll_attendance_snapshots_version_check
    check (attendance_version > 0)
);

alter table public.payroll_items
  add constraint payroll_items_snapshot_fkey
  foreign key (source_attendance_snapshot_id)
  references public.payroll_attendance_snapshots(id)
  on delete restrict;

create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_record_id uuid not null
    references public.payroll_records(id) on delete restrict,
  employee_id uuid not null references public.profiles(user_id) on delete restrict,
  payslip_number text not null,
  storage_bucket text not null,
  storage_path text not null,
  file_sha256 text not null,
  file_size_bytes bigint not null,
  generated_by uuid not null references public.profiles(user_id) on delete restrict,
  generated_at timestamptz not null default now(),
  finalized_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint payslips_payroll_record_key unique (payroll_record_id),
  constraint payslips_number_key unique (payslip_number),
  constraint payslips_storage_object_key unique (storage_bucket, storage_path),
  constraint payslips_number_not_blank check (length(trim(payslip_number)) > 0),
  constraint payslips_storage_bucket_not_blank check (length(trim(storage_bucket)) > 0),
  constraint payslips_storage_path_not_blank check (length(trim(storage_path)) > 0),
  constraint payslips_sha256_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint payslips_file_size_check check (file_size_bytes > 0)
);

create table public.payroll_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(user_id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payroll_period_id uuid references public.payroll_periods(id) on delete restrict,
  payroll_record_id uuid references public.payroll_records(id) on delete restrict,
  before_data jsonb,
  after_data jsonb,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint payroll_audit_logs_action_not_blank
    check (length(trim(action)) > 0),
  constraint payroll_audit_logs_entity_not_blank
    check (length(trim(entity_type)) > 0),
  constraint payroll_audit_logs_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index agent_rates_employee_effective_idx
  on public.agent_rates (employee_id, effective_date desc);
create index payroll_periods_status_dates_idx
  on public.payroll_periods (status, period_start desc, period_end desc);
create index payroll_records_employee_period_idx
  on public.payroll_records (employee_id, payroll_period_id);
create index payroll_records_recalculation_idx
  on public.payroll_records (payroll_period_id, requires_recalculation)
  where requires_recalculation;
create index payroll_items_record_type_idx
  on public.payroll_items (payroll_record_id, item_type, item_code);
create index payroll_items_rate_idx
  on public.payroll_items (rate_id)
  where rate_id is not null;
create index payroll_snapshots_attendance_idx
  on public.payroll_attendance_snapshots (attendance_id, attendance_version);
create index payroll_snapshots_employee_date_idx
  on public.payroll_attendance_snapshots (employee_id, work_date);
create index payslips_employee_generated_idx
  on public.payslips (employee_id, generated_at desc);
create index payroll_audit_logs_entity_idx
  on public.payroll_audit_logs (entity_type, entity_id, created_at desc);
create index payroll_audit_logs_period_idx
  on public.payroll_audit_logs (payroll_period_id, created_at desc);
create index payroll_audit_logs_record_idx
  on public.payroll_audit_logs (payroll_record_id, created_at desc);
create index payroll_audit_logs_actor_idx
  on public.payroll_audit_logs (actor_user_id, created_at desc);

alter table public.agent_rates enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.payroll_records enable row level security;
alter table public.payroll_items enable row level security;
alter table public.payroll_attendance_snapshots enable row level security;
alter table public.payslips enable row level security;
alter table public.payroll_audit_logs enable row level security;

revoke all on table public.agent_rates from public, anon, authenticated;
revoke all on table public.payroll_periods from public, anon, authenticated;
revoke all on table public.payroll_records from public, anon, authenticated;
revoke all on table public.payroll_items from public, anon, authenticated;
revoke all on table public.payroll_attendance_snapshots from public, anon, authenticated;
revoke all on table public.payslips from public, anon, authenticated;
revoke all on table public.payroll_audit_logs from public, anon, authenticated;

grant all on table public.agent_rates to service_role;
grant all on table public.payroll_periods to service_role;
grant all on table public.payroll_records to service_role;
grant all on table public.payroll_items to service_role;
grant all on table public.payroll_attendance_snapshots to service_role;
grant all on table public.payslips to service_role;
grant all on table public.payroll_audit_logs to service_role;

comment on table public.agent_rates is
  'Append-only effective-dated employee payroll rates. Historical rows must not be overwritten.';
comment on table public.payroll_periods is
  'Payroll processing windows and approval/finalization lifecycle.';
comment on table public.payroll_records is
  'One employee payroll result per payroll period.';
comment on table public.payroll_items is
  'Detailed calculated or manual earning and deduction lines.';
comment on table public.payroll_attendance_snapshots is
  'Immutable copy of the approved Phase 1 attendance values imported into a payroll record.';
comment on column public.payroll_attendance_snapshots.attendance_version is
  'Monotonic source version captured during import; initially derived from attendance.updated_at.';
comment on table public.payslips is
  'Finalized private payslip PDF metadata. Signed URLs are generated temporarily and never stored here.';
comment on table public.payroll_audit_logs is
  'Append-only audit trail for payroll lifecycle and adjustment activity.';
