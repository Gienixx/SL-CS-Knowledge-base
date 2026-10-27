-- Close only the six known inactive historical user assignments at the
-- boundary immediately before the active August 2026 assignments.
--
-- This is a data-boundary correction, not a scheduling-policy change.  It
-- deliberately does not touch templates, template days, generated schedules,
-- attendance, leave, payroll, snapshots, or prepaid ledgers.

begin;

create temporary table _expected_stale_assignment_boundary (
  assignment_id uuid primary key,
  user_id uuid not null,
  historical_template_id uuid not null,
  historical_effective_from date not null,
  active_assignment_id uuid not null,
  active_template_id uuid not null,
  active_effective_from date not null
) on commit drop;

insert into _expected_stale_assignment_boundary (
  assignment_id,
  user_id,
  historical_template_id,
  historical_effective_from,
  active_assignment_id,
  active_template_id,
  active_effective_from
)
values
  (
    '81cd4878-b32f-4d91-a0bb-67e77a334728',
    '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e',
    '6925a71f-4300-4b30-b401-7f9c91288458',
    date '2026-07-13',
    '0043ffa4-acab-44cb-bce2-4a53c9d8f7a2',
    'eda62a02-1d3f-466d-81f7-234ac0ca3432',
    date '2026-08-01'
  ),
  (
    'de9c079f-23d1-4748-878a-396c9e13eb65',
    'f69a9e68-5507-4132-af60-e7cc1255d8c2',
    '267ae977-560d-4d5a-abed-5b0787de6eb1',
    date '2026-07-13',
    '96419998-17a8-4ab9-b86a-62f60ebbfec6',
    '742d3c50-880b-4d0e-833e-58321e57f9cf',
    date '2026-08-01'
  ),
  (
    '70de34a7-9143-4713-b817-ddd9e3fe3fbf',
    'd0118de4-b191-43f3-9162-c16f85927154',
    '217da74a-9fbf-450b-88aa-deb359789864',
    date '2026-07-13',
    '76e6378c-4039-42cf-a9a9-28f80d145c2e',
    'c07fe8f1-b90c-48bb-b967-6a765bee6dea',
    date '2026-08-01'
  ),
  (
    '19346bae-cb7c-40ee-bd10-7db7dd35b896',
    '81158e64-0ba1-4d0e-9ed9-a59632f39b57',
    '75bda2d5-d609-4f00-bd4f-dbe787d2a96b',
    date '2026-07-13',
    'e2915d3c-f14b-4b9e-b6a1-1081023316ec',
    '82c336a7-6be0-4ad3-9aac-a141687f4123',
    date '2026-08-01'
  ),
  (
    '2009777d-f2fc-4b53-a171-c8b7ba2f7a47',
    '3cb387fc-7c41-4bc7-82f9-9ddbf6abc0b4',
    'd182c163-4a0f-44ab-9544-30233c299710',
    date '2026-07-13',
    'c92d7df4-e418-408f-bd0c-b590c66a8f75',
    '81eff5d3-d181-49c5-973d-47ff644ce939',
    date '2026-08-01'
  ),
  (
    '3fb200d5-1f48-4176-88e7-a1f17c14262a',
    '83fbb782-4e6b-438a-be7b-a05f89f948d6',
    'cefda79b-441d-4e4f-90f8-6ffafd78d65a',
    date '2026-07-13',
    'bd7eb249-cdf1-4a8c-9afe-d72bd05793eb',
    '95df7562-ab73-4772-8aad-ab527c0aa3cd',
    date '2026-08-01'
  );

-- Fail closed if the migration text is ever changed without all six exact
-- production targets remaining represented.
do $$
declare
  v_target_count bigint;
  v_active_count bigint;
  v_active_overlap_count bigint;
  v_historical_schedule_count bigint;
  v_historical_attendance_count bigint;
  v_historical_payroll_snapshot_count bigint;
  v_historical_schedule_snapshot_count bigint;
  v_invalid_template_count bigint;
  v_invalid_active_assignment_count bigint;
begin
  select count(*) into v_target_count
  from public.work_schedule_template_assignments assignment
  join _expected_stale_assignment_boundary expected
    on expected.assignment_id = assignment.id
  where assignment.user_id = expected.user_id
    and assignment.template_id = expected.historical_template_id
    and assignment.is_active is false
    and assignment.effective_from = expected.historical_effective_from
    and assignment.effective_until is null
    and assignment.team_id is null;

  if v_target_count <> 6 then
    raise exception
      using errcode = '55000',
        message = format(
          'Expected exactly 6 stale historical assignments in the guarded state, found %s.',
          v_target_count
        );
  end if;

  select count(*) into v_active_count
  from public.work_schedule_template_assignments assignment
  join _expected_stale_assignment_boundary expected
    on expected.active_assignment_id = assignment.id
   and expected.user_id = assignment.user_id
   and expected.active_template_id = assignment.template_id
  where assignment.is_active
    and assignment.effective_from = expected.active_effective_from
    and assignment.effective_until is null
    and assignment.team_id is null;

  if v_active_count <> 6 then
    raise exception
      using errcode = '55000',
        message = 'Each stale assignment must have its expected active Aug 1 successor.';
  end if;

  select count(*) into v_invalid_active_assignment_count
  from _expected_stale_assignment_boundary expected
  where (
    select count(*)
    from public.work_schedule_template_assignments assignment
    where assignment.user_id = expected.user_id
      and assignment.is_active
  ) <> 1;

  if v_invalid_active_assignment_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'A target employee has more or fewer than one active recurring assignment.';
  end if;

  select count(*) into v_invalid_template_count
  from _expected_stale_assignment_boundary expected
  where not exists (
    select 1
    from public.work_schedule_templates template
    where template.id = expected.historical_template_id
      and template.is_active
  )
  or not exists (
    select 1
    from public.work_schedule_templates template
    where template.id = expected.active_template_id
      and template.is_active
  );

  if v_invalid_template_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'A target historical or active template is missing or inactive.';
  end if;

  select count(*) into v_active_overlap_count
  from public.work_schedule_template_assignments left_assignment
  join public.work_schedule_template_assignments right_assignment
    on right_assignment.user_id = left_assignment.user_id
   and right_assignment.id > left_assignment.id
   and daterange(
         left_assignment.effective_from,
         coalesce(left_assignment.effective_until, date '9999-12-31'),
         '[]'
       ) && daterange(
         right_assignment.effective_from,
         coalesce(right_assignment.effective_until, date '9999-12-31'),
         '[]'
       )
  where left_assignment.user_id is not null
    and left_assignment.is_active
    and right_assignment.is_active;

  if v_active_overlap_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'Active-active recurring assignment overlap exists.';
  end if;

  select count(*) into v_historical_schedule_count
  from public.work_schedules schedule
  join _expected_stale_assignment_boundary expected
    on expected.historical_template_id = schedule.schedule_template_id
  where schedule.shift_date >= date '2026-08-01';

  if v_historical_schedule_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'A historical template has a generated schedule on or after Aug 1, 2026.';
  end if;

  select count(*) into v_historical_attendance_count
  from public.attendance attendance_row
  join public.work_schedules schedule
    on schedule.id = attendance_row.schedule_id
  join _expected_stale_assignment_boundary expected
    on expected.historical_template_id = schedule.schedule_template_id
  where attendance_row.work_date >= date '2026-08-01'
    and attendance_row.voided_at is null;

  if v_historical_attendance_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'Attendance is linked to a historical template on or after Aug 1, 2026.';
  end if;

  select count(*) into v_historical_payroll_snapshot_count
  from public.payroll_attendance_snapshots snapshot
  join public.work_schedules schedule
    on schedule.id = snapshot.schedule_id
  join _expected_stale_assignment_boundary expected
    on expected.historical_template_id = schedule.schedule_template_id
  where snapshot.work_date >= date '2026-08-01';

  if v_historical_payroll_snapshot_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'Payroll snapshots are linked to a historical template on or after Aug 1, 2026.';
  end if;

  select count(*) into v_historical_schedule_snapshot_count
  from public.payroll_schedule_snapshots snapshot
  join public.work_schedules schedule
    on schedule.id = snapshot.schedule_id
  join _expected_stale_assignment_boundary expected
    on expected.historical_template_id = schedule.schedule_template_id
  where snapshot.work_date >= date '2026-08-01';

  if v_historical_schedule_snapshot_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'Schedule snapshots are linked to a historical template on or after Aug 1, 2026.';
  end if;
end;
$$;

-- Lock and update only the six exact historical rows.  The WHERE clause is a
-- second guard against a partially changed target between validation and DML.
do $$
declare
  v_updated_count bigint;
begin
  perform 1
  from public.work_schedule_template_assignments assignment
  join _expected_stale_assignment_boundary expected
    on expected.assignment_id = assignment.id
  for update of assignment;

  update public.work_schedule_template_assignments assignment
  set effective_until = date '2026-07-31',
      updated_at = pg_catalog.statement_timestamp()
  from _expected_stale_assignment_boundary expected
  where assignment.id = expected.assignment_id
    and assignment.user_id = expected.user_id
    and assignment.template_id = expected.historical_template_id
    and assignment.is_active is false
    and assignment.effective_from = expected.historical_effective_from
    and assignment.effective_until is null
    and assignment.team_id is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 6 then
    raise exception
      using errcode = '40001',
        message = format('Expected to update exactly 6 assignments, updated %s.', v_updated_count);
  end if;
end;
$$;

-- Confirm the intended boundary and resolver behavior before recording the
-- append-only audit trail.  No schedules are regenerated.
do $$
declare
  v_historical_resolution_count bigint;
  v_current_resolution_count bigint;
  v_active_overlap_count bigint;
begin
  select count(*) into v_historical_resolution_count
  from _expected_stale_assignment_boundary expected
  join lateral public.workforce_effective_weekly_assignment(
    expected.user_id,
    date '2026-07-31'
  ) resolved on resolved.assignment_id = expected.assignment_id;

  select count(*) into v_current_resolution_count
  from _expected_stale_assignment_boundary expected
  join lateral public.workforce_effective_weekly_assignment(
    expected.user_id,
    date '2026-08-01'
  ) resolved on resolved.assignment_id = expected.active_assignment_id;

  if v_historical_resolution_count <> 6 or v_current_resolution_count <> 6 then
    raise exception
      using errcode = '55000',
        message = 'Assignment resolver did not return the expected historical/current boundary rows.';
  end if;

  select count(*) into v_active_overlap_count
  from public.work_schedule_template_assignments left_assignment
  join public.work_schedule_template_assignments right_assignment
    on right_assignment.user_id = left_assignment.user_id
   and right_assignment.id > left_assignment.id
   and daterange(
         left_assignment.effective_from,
         coalesce(left_assignment.effective_until, date '9999-12-31'),
         '[]'
       ) && daterange(
         right_assignment.effective_from,
         coalesce(right_assignment.effective_until, date '9999-12-31'),
         '[]'
       )
  where left_assignment.user_id is not null
    and left_assignment.is_active
    and right_assignment.is_active;

  if v_active_overlap_count <> 0 then
    raise exception
      using errcode = '55000',
        message = 'Active-active recurring assignment overlap appeared after correction.';
  end if;
end;
$$;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data,
  reason
)
select
  null,
  'recurring_assignment_boundary_corrected',
  'work_schedule_template_assignment',
  expected.assignment_id,
  jsonb_build_object(
    'assignment_id', expected.assignment_id,
    'user_id', expected.user_id,
    'template_id', expected.historical_template_id,
    'is_active', false,
    'effective_from', expected.historical_effective_from,
    'effective_until', null
  ),
  jsonb_build_object(
    'assignment_id', expected.assignment_id,
    'user_id', expected.user_id,
    'template_id', expected.historical_template_id,
    'is_active', false,
    'effective_from', expected.historical_effective_from,
    'effective_until', date '2026-07-31'
  ),
  'Close the known inactive historical recurring assignment immediately before the active Aug 1, 2026 assignment; no schedules or payroll data changed.'
from _expected_stale_assignment_boundary expected;

commit;

;
