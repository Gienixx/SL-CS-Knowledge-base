-- Revised Phase 2 Step 1: preserve approved pre-plotted schedules and provide
-- an employee-safe, append-only ledger for prepaid-hour reconciliation.

begin;

-- Schedule changes need a monotonic version so payroll can prove exactly which
-- approved schedule was prepaid and detect later edits without relying on
-- timestamp precision.
alter table public.work_schedules
  add column schedule_version bigint not null default 1;

alter table public.work_schedules
  add constraint work_schedules_version_positive_check
  check (schedule_version > 0);

comment on column public.work_schedules.schedule_version is
  'Monotonic source version incremented on every schedule update and captured by payroll schedule snapshots.';

create or replace function public.workforce_increment_schedule_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.schedule_version := old.schedule_version + 1;
  return new;
end;
$$;

drop trigger if exists work_schedules_increment_version
  on public.work_schedules;
create trigger work_schedules_increment_version
before update on public.work_schedules
for each row
execute function public.workforce_increment_schedule_version();

revoke all on function public.workforce_increment_schedule_version()
  from public, anon, authenticated;
grant execute on function public.workforce_increment_schedule_version()
  to service_role;

-- Payroll calculation must distinguish normal overtime that may settle a
-- prepaid balance from guaranteed special-day work that must remain payable.
alter table public.payroll_attendance_snapshots
  add column rest_day_overtime_minutes integer,
  add column holiday_overtime_minutes integer,
  add column is_rest_day boolean,
  add column is_holiday boolean,
  add column holiday_name text,
  add column special_day_type text not null default 'unknown';

alter table public.payroll_attendance_snapshots
  add constraint payroll_attendance_snapshots_special_minutes_check
  check (
    (rest_day_overtime_minutes is null or rest_day_overtime_minutes >= 0)
    and (holiday_overtime_minutes is null or holiday_overtime_minutes >= 0)
  ),
  add constraint payroll_attendance_snapshots_special_type_check
  check (special_day_type in ('ordinary', 'rest_day', 'holiday', 'unknown')),
  add constraint payroll_attendance_snapshots_special_capture_check
  check (
    (
      special_day_type = 'unknown'
      and rest_day_overtime_minutes is null
      and holiday_overtime_minutes is null
      and is_rest_day is null
      and is_holiday is null
    )
    or (
      special_day_type <> 'unknown'
      and rest_day_overtime_minutes is not null
      and holiday_overtime_minutes is not null
      and is_rest_day is not null
      and is_holiday is not null
      and (
        (special_day_type = 'ordinary' and not is_rest_day and not is_holiday)
        or (special_day_type = 'rest_day' and is_rest_day)
        or (special_day_type = 'holiday' and not is_rest_day and is_holiday)
      )
    )
  );

-- Existing snapshots can be enriched only when their source version is still
-- current. An old source version would remain explicitly "unknown" rather than
-- being silently combined with a newer attendance record.
alter table public.payroll_attendance_snapshots
  disable trigger payroll_attendance_snapshots_immutable;

update public.payroll_attendance_snapshots as snapshot
set
  rest_day_overtime_minutes = attendance_row.rest_day_overtime_minutes,
  holiday_overtime_minutes = attendance_row.holiday_overtime_minutes,
  is_rest_day = (
    schedule.is_rest_day
    or attendance_row.rest_day_overtime_minutes > 0
  ),
  is_holiday = schedule.is_holiday,
  holiday_name = case
    when schedule.is_holiday then schedule.holiday_name
    else null
  end,
  special_day_type = case
    when schedule.is_rest_day
      or attendance_row.rest_day_overtime_minutes > 0
      then 'rest_day'
    when schedule.is_holiday
      or attendance_row.holiday_overtime_minutes > 0
      then 'holiday'
    else 'ordinary'
  end
from public.attendance as attendance_row
join public.work_schedules as schedule
  on schedule.id = attendance_row.schedule_id
where attendance_row.id = snapshot.attendance_id
  and attendance_row.user_id = snapshot.employee_id
  and attendance_row.schedule_id = snapshot.schedule_id
  and attendance_row.work_date = snapshot.work_date
  and attendance_row.attendance_version = snapshot.attendance_version;

alter table public.payroll_attendance_snapshots
  enable trigger payroll_attendance_snapshots_immutable;

create or replace function public.payroll_capture_snapshot_special_details()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
begin
  select attendance_row.*
  into v_attendance
  from public.attendance as attendance_row
  where attendance_row.id = new.attendance_id
    and attendance_row.user_id = new.employee_id
    and attendance_row.schedule_id = new.schedule_id
    and attendance_row.work_date = new.work_date
    and attendance_row.attendance_version = new.attendance_version;

  if not found then
    raise exception
      using
        errcode = '23503',
        message = 'Payroll attendance snapshot source version was not found.';
  end if;

  select schedule.*
  into v_schedule
  from public.work_schedules as schedule
  where schedule.id = new.schedule_id
    and schedule.user_id = new.employee_id;

  if not found then
    raise exception
      using
        errcode = '23503',
        message = 'Payroll attendance snapshot schedule was not found.';
  end if;

  new.rest_day_overtime_minutes := v_attendance.rest_day_overtime_minutes;
  new.holiday_overtime_minutes := v_attendance.holiday_overtime_minutes;
  new.is_rest_day := (
    v_schedule.is_rest_day
    or v_attendance.rest_day_overtime_minutes > 0
  );
  new.is_holiday := v_schedule.is_holiday;
  new.holiday_name := case
    when v_schedule.is_holiday then v_schedule.holiday_name
    else null
  end;
  new.special_day_type := case
    when new.is_rest_day then 'rest_day'
    when new.is_holiday
      or v_attendance.holiday_overtime_minutes > 0
      then 'holiday'
    else 'ordinary'
  end;

  return new;
end;
$$;

drop trigger if exists payroll_attendance_snapshot_capture_special_details
  on public.payroll_attendance_snapshots;
create trigger payroll_attendance_snapshot_capture_special_details
before insert on public.payroll_attendance_snapshots
for each row
execute function public.payroll_capture_snapshot_special_details();

revoke all on function public.payroll_capture_snapshot_special_details()
  from public, anon, authenticated;
grant execute on function public.payroll_capture_snapshot_special_details()
  to service_role;

comment on column public.payroll_attendance_snapshots.special_day_type is
  'ordinary, rest_day, or holiday when captured from the exact source attendance version; unknown only for unrecoverable historical source versions.';

-- Composite keys allow child ledgers to prove that every referenced payroll,
-- attendance, and prepaid row belongs to the same employee.
alter table public.payroll_records
  add constraint payroll_records_id_employee_key
  unique (id, employee_id);

alter table public.payroll_attendance_snapshots
  add constraint payroll_attendance_snapshots_id_record_employee_key
  unique (id, payroll_record_id, employee_id);

create table public.payroll_schedule_snapshots (
  id uuid primary key default gen_random_uuid(),
  payroll_record_id uuid not null,
  schedule_id uuid not null
    references public.work_schedules(id) on delete restrict,
  employee_id uuid not null
    references public.profiles(user_id) on delete restrict,
  work_date date not null,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text not null,
  scheduled_minutes integer generated always as (
    case
      when shift_start is null or shift_end is null then 0
      else floor(extract(epoch from (shift_end - shift_start)) / 60)::integer
    end
  ) stored,
  schedule_status text not null,
  is_rest_day boolean not null,
  is_holiday boolean not null,
  holiday_name text,
  schedule_version bigint not null,
  schedule_updated_at timestamptz not null,
  approved_by uuid not null
    references public.profiles(user_id) on delete restrict,
  approved_at timestamptz not null,
  approval_reason text not null,
  snapshotted_at timestamptz not null default now(),
  constraint payroll_schedule_snapshots_record_employee_fkey
    foreign key (payroll_record_id, employee_id)
    references public.payroll_records(id, employee_id)
    on delete restrict,
  constraint payroll_schedule_snapshots_record_schedule_version_key
    unique (payroll_record_id, schedule_id, schedule_version),
  constraint payroll_schedule_snapshots_identity_key
    unique (id, payroll_record_id, employee_id),
  constraint payroll_schedule_snapshots_time_check
    check (
      (
        is_rest_day
        and shift_start is null
        and shift_end is null
        and scheduled_minutes = 0
      )
      or (
        not is_rest_day
        and shift_start is not null
        and shift_end is not null
        and shift_end > shift_start
        and scheduled_minutes > 0
      )
    ),
  constraint payroll_schedule_snapshots_status_check
    check (schedule_status in ('published', 'changed', 'completed')),
  constraint payroll_schedule_snapshots_version_check
    check (schedule_version > 0),
  constraint payroll_schedule_snapshots_timezone_not_blank
    check (length(trim(timezone)) > 0),
  constraint payroll_schedule_snapshots_reason_not_blank
    check (length(trim(approval_reason)) > 0),
  constraint payroll_schedule_snapshots_holiday_name_check
    check (
      not is_holiday
      or (
        holiday_name is not null
        and length(trim(holiday_name)) > 0
      )
    )
);

create table public.payroll_prepaid_hours (
  id uuid primary key default gen_random_uuid(),
  source_payroll_record_id uuid not null,
  source_schedule_snapshot_id uuid not null,
  employee_id uuid not null
    references public.profiles(user_id) on delete restrict,
  prepaid_minutes integer not null,
  settled_minutes integer not null default 0,
  remaining_minutes integer generated always as (
    prepaid_minutes - settled_minutes
  ) stored,
  voided_at timestamptz,
  voided_by uuid references public.profiles(user_id) on delete restrict,
  void_reason text,
  superseded_by_id uuid
    references public.payroll_prepaid_hours(id) on delete restrict,
  status text generated always as (
    case
      when voided_at is not null then 'void'
      when settled_minutes = 0 then 'open'
      when settled_minutes < prepaid_minutes then 'partially_settled'
      else 'settled'
    end
  ) stored,
  last_settled_at timestamptz,
  created_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_prepaid_hours_source_snapshot_key
    unique (source_schedule_snapshot_id),
  constraint payroll_prepaid_hours_identity_key
    unique (id, employee_id),
  constraint payroll_prepaid_hours_source_fkey
    foreign key (
      source_schedule_snapshot_id,
      source_payroll_record_id,
      employee_id
    )
    references public.payroll_schedule_snapshots(
      id,
      payroll_record_id,
      employee_id
    )
    on delete restrict,
  constraint payroll_prepaid_hours_minutes_check
    check (
      prepaid_minutes > 0
      and settled_minutes >= 0
      and settled_minutes <= prepaid_minutes
    ),
  constraint payroll_prepaid_hours_void_check
    check (
      (
        voided_at is null
        and voided_by is null
        and void_reason is null
        and superseded_by_id is null
      )
      or (
        voided_at is not null
        and voided_by is not null
        and void_reason is not null
        and length(trim(void_reason)) > 0
      )
    ),
  constraint payroll_prepaid_hours_not_self_superseded_check
    check (superseded_by_id is null or superseded_by_id <> id)
);

create table public.payroll_hour_allocations (
  id uuid primary key default gen_random_uuid(),
  prepaid_hour_id uuid not null,
  employee_id uuid not null,
  destination_payroll_record_id uuid not null,
  attendance_snapshot_id uuid not null,
  allocation_type text not null default 'settlement',
  minute_category text not null,
  allocated_minutes integer not null,
  calculation_version integer not null,
  reverses_allocation_id uuid
    references public.payroll_hour_allocations(id) on delete restrict,
  reason text not null,
  created_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payroll_hour_allocations_prepaid_employee_fkey
    foreign key (prepaid_hour_id, employee_id)
    references public.payroll_prepaid_hours(id, employee_id)
    on delete restrict,
  constraint payroll_hour_allocations_attendance_record_employee_fkey
    foreign key (
      attendance_snapshot_id,
      destination_payroll_record_id,
      employee_id
    )
    references public.payroll_attendance_snapshots(
      id,
      payroll_record_id,
      employee_id
    )
    on delete restrict,
  constraint payroll_hour_allocations_reversal_key
    unique (reverses_allocation_id),
  constraint payroll_hour_allocations_type_check
    check (allocation_type in ('settlement', 'reversal')),
  constraint payroll_hour_allocations_category_check
    check (
      minute_category in (
        'regular',
        'pre_shift_overtime',
        'post_shift_overtime'
      )
    ),
  constraint payroll_hour_allocations_minutes_check
    check (allocated_minutes > 0),
  constraint payroll_hour_allocations_calculation_version_check
    check (calculation_version > 0),
  constraint payroll_hour_allocations_reversal_check
    check (
      (
        allocation_type = 'settlement'
        and reverses_allocation_id is null
      )
      or (
        allocation_type = 'reversal'
        and reverses_allocation_id is not null
        and reverses_allocation_id <> id
      )
    ),
  constraint payroll_hour_allocations_reason_not_blank
    check (length(trim(reason)) > 0)
);

create unique index payroll_hour_allocations_calculation_line_key
  on public.payroll_hour_allocations (
    prepaid_hour_id,
    attendance_snapshot_id,
    minute_category,
    allocation_type,
    calculation_version
  );

create index payroll_schedule_snapshots_record_date_idx
  on public.payroll_schedule_snapshots (payroll_record_id, work_date);
create index payroll_schedule_snapshots_employee_date_idx
  on public.payroll_schedule_snapshots (
    employee_id,
    work_date,
    schedule_version desc
  );
create index payroll_schedule_snapshots_schedule_idx
  on public.payroll_schedule_snapshots (schedule_id, schedule_version desc);
create index payroll_schedule_snapshots_approver_idx
  on public.payroll_schedule_snapshots (approved_by, approved_at desc);

create index payroll_prepaid_hours_source_record_idx
  on public.payroll_prepaid_hours (source_payroll_record_id);
create index payroll_prepaid_hours_employee_fifo_idx
  on public.payroll_prepaid_hours (employee_id, created_at, id)
  where voided_at is null and settled_minutes < prepaid_minutes;
create index payroll_prepaid_hours_superseded_idx
  on public.payroll_prepaid_hours (superseded_by_id)
  where superseded_by_id is not null;
create index payroll_prepaid_hours_voided_by_idx
  on public.payroll_prepaid_hours (voided_by)
  where voided_by is not null;
create index payroll_prepaid_hours_created_by_idx
  on public.payroll_prepaid_hours (created_by)
  where created_by is not null;

create index payroll_hour_allocations_prepaid_created_idx
  on public.payroll_hour_allocations (prepaid_hour_id, created_at, id);
create index payroll_hour_allocations_destination_idx
  on public.payroll_hour_allocations (
    destination_payroll_record_id,
    calculation_version
  );
create index payroll_hour_allocations_attendance_idx
  on public.payroll_hour_allocations (attendance_snapshot_id);
create index payroll_hour_allocations_employee_created_idx
  on public.payroll_hour_allocations (employee_id, created_at desc);
create index payroll_hour_allocations_created_by_idx
  on public.payroll_hour_allocations (created_by)
  where created_by is not null;

create or replace function public.payroll_prevent_reconciliation_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    using
      errcode = '55000',
      message = 'Payroll reconciliation history is immutable.';
end;
$$;

create trigger payroll_schedule_snapshots_immutable
before update or delete on public.payroll_schedule_snapshots
for each row
execute function public.payroll_prevent_reconciliation_history_mutation();

create trigger payroll_hour_allocations_immutable
before update or delete on public.payroll_hour_allocations
for each row
execute function public.payroll_prevent_reconciliation_history_mutation();

revoke all on function public.payroll_prevent_reconciliation_history_mutation()
  from public, anon, authenticated;
grant execute on function public.payroll_prevent_reconciliation_history_mutation()
  to service_role;

create or replace function public.payroll_guard_prepaid_hour_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll prepaid-hour balances cannot be deleted.';
  end if;

  if new.source_payroll_record_id is distinct from old.source_payroll_record_id
     or new.source_schedule_snapshot_id is distinct from old.source_schedule_snapshot_id
     or new.employee_id is distinct from old.employee_id
     or new.prepaid_minutes is distinct from old.prepaid_minutes
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll prepaid-hour source details are immutable.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger payroll_prepaid_hours_guard
before update or delete on public.payroll_prepaid_hours
for each row
execute function public.payroll_guard_prepaid_hour_mutation();

revoke all on function public.payroll_guard_prepaid_hour_mutation()
  from public, anon, authenticated;
grant execute on function public.payroll_guard_prepaid_hour_mutation()
  to service_role;

alter table public.payroll_schedule_snapshots enable row level security;
alter table public.payroll_prepaid_hours enable row level security;
alter table public.payroll_hour_allocations enable row level security;

revoke all on table public.payroll_schedule_snapshots
  from public, anon, authenticated;
revoke all on table public.payroll_prepaid_hours
  from public, anon, authenticated;
revoke all on table public.payroll_hour_allocations
  from public, anon, authenticated;

grant select on table public.payroll_schedule_snapshots to authenticated;
grant select on table public.payroll_prepaid_hours to authenticated;
grant select on table public.payroll_hour_allocations to authenticated;

grant all on table public.payroll_schedule_snapshots to service_role;
grant all on table public.payroll_prepaid_hours to service_role;
grant all on table public.payroll_hour_allocations to service_role;

create policy "Payroll processors can view schedule snapshots"
on public.payroll_schedule_snapshots
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

create policy "Payroll processors can view prepaid hours"
on public.payroll_prepaid_hours
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

create policy "Payroll processors can view hour allocations"
on public.payroll_hour_allocations
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

comment on table public.payroll_schedule_snapshots is
  'Immutable approved schedule versions used to prepay future ordinary workdays without creating fake attendance.';
comment on table public.payroll_prepaid_hours is
  'Employee prepaid-minute balances sourced from approved payroll schedule snapshots. Remaining minutes are derived from the stored settlement total.';
comment on table public.payroll_hour_allocations is
  'Append-only settlements and reversals showing which later approved attendance minutes reconciled each prepaid balance.';
comment on column public.payroll_hour_allocations.minute_category is
  'Only regular and normal pre/post-shift overtime may settle prepaid hours; rest-day and holiday work are intentionally excluded.';

commit;
