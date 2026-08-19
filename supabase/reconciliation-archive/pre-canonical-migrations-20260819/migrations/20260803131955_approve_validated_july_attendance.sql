-- Approve only the seven July attendance records validated after the final
-- timesheet and prepaid-schedule corrections. Use the same guarded review RPC
-- as Team Attendance so every transition is permission-checked and audited.

begin;

set local statement_timeout = '30s';

do $$
declare
  v_actor_auth_user_id constant uuid :=
    '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid;
  v_actor_profile_user_id constant uuid :=
    '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid;
  v_target record;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_blockers text[];
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'approve_validated_july_attendance:20260803',
      0
    )
  );

  if not exists (
    select 1
    from public.profiles as profile
    where profile.user_id = v_actor_profile_user_id
      and profile.full_name = 'admin'
      and profile.is_system_admin
      and profile.employment_status = 'active'
  ) then
    raise exception 'The expected active system administrator was not found.';
  end if;

  if not exists (
    select 1
    from public.workforce_identity_links as identity_link
    where identity_link.auth_user_id = v_actor_auth_user_id
      and identity_link.profile_user_id = v_actor_profile_user_id
      and identity_link.is_active
  ) then
    raise exception 'The system administrator identity link is not active.';
  end if;

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_actor_auth_user_id::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  if public.workforce_current_profile_id() <> v_actor_profile_user_id
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('approve_attendance') then
    raise exception 'The system administrator cannot approve attendance.';
  end if;

  for v_target in
    select *
    from (
      values
        (
          '3ba5a8bf-3137-46c2-986f-99f09232977a'::uuid,
          'b303c569-c808-409f-958e-7bc89868b07f'::uuid,
          date '2026-07-31',
          'pending'::text,
          'Jerson Gavileño'::text
        ),
        (
          '4eb2b52b-0370-4099-b7b8-283a44cfb998'::uuid,
          'ddeb2e37-2ae6-4caa-9117-9fdb4db54f2a'::uuid,
          date '2026-07-30',
          'pending'::text,
          'Alen Tristan Adeva'::text
        ),
        (
          '56c5aef9-81a1-45ad-a69f-015f09b6c9a8'::uuid,
          '3cb387fc-7c41-4bc7-82f9-9ddbf6abc0b4'::uuid,
          date '2026-07-30',
          'pending'::text,
          'Jean Vestil'::text
        ),
        (
          '88e48557-f36e-45c3-b033-475400247983'::uuid,
          'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid,
          date '2026-07-27',
          'corrected'::text,
          'Arby Jann Benito'::text
        ),
        (
          'b4be6e77-c665-49c5-a61c-5e9bd225aa80'::uuid,
          '3cb387fc-7c41-4bc7-82f9-9ddbf6abc0b4'::uuid,
          date '2026-07-31',
          'pending'::text,
          'Jean Vestil'::text
        ),
        (
          'e409e6a7-6ee6-4537-a086-a9596e70f4f9'::uuid,
          'd0118de4-b191-43f3-9162-c16f85927154'::uuid,
          date '2026-07-31',
          'corrected'::text,
          'Arez Santos'::text
        ),
        (
          'ed29eccd-f852-49e6-a99d-550363c7abf7'::uuid,
          '29289052-122a-4a3d-a6e5-c45f461d7c2e'::uuid,
          date '2026-07-31',
          'pending'::text,
          'Amora Angeles'::text
        )
    ) as target(
      attendance_id,
      employee_user_id,
      work_date,
      expected_review_status,
      employee_name
    )
    order by attendance_id
  loop
    select attendance_row.*
    into v_before
    from public.attendance as attendance_row
    where attendance_row.id = v_target.attendance_id
      and attendance_row.user_id = v_target.employee_user_id
      and attendance_row.work_date = v_target.work_date
    for update;

    if not found then
      raise exception 'Expected attendance was not found for % on %.',
        v_target.employee_name,
        v_target.work_date;
    end if;

    if v_before.review_status <> v_target.expected_review_status
       or v_before.attendance_status <> 'present'
       or v_before.schedule_id is null
       or v_before.clock_in is null
       or v_before.clock_out is null
       or v_before.clock_out < v_before.clock_in
       or v_before.pre_shift_overtime_minutes is null
       or v_before.regular_minutes is null
       or v_before.post_shift_overtime_minutes is null
       or v_before.rest_day_overtime_minutes is null
       or v_before.holiday_overtime_minutes is null
       or v_before.total_worked_minutes is null
       or v_before.total_overtime_minutes is null then
      raise exception 'Attendance changed after validation for % on %.',
        v_target.employee_name,
        v_target.work_date;
    end if;

    select readiness.payroll_readiness_blockers
    into v_blockers
    from public.workforce_attendance_payroll_readiness as readiness
    where readiness.id = v_before.id;

    if v_blockers is distinct from array['review_required']::text[] then
      raise exception 'Unexpected payroll blockers for % on %: %.',
        v_target.employee_name,
        v_target.work_date,
        coalesce(array_to_string(v_blockers, ', '), 'none');
    end if;

    select *
    into v_after
    from public.workforce_review_attendance(
      v_before.id,
      'approved',
      'Approved after final July timesheet, attendance, and prepaid-schedule validation.'
    );

    if v_after.review_status <> 'approved'
       or v_after.reviewed_by <> v_actor_profile_user_id
       or v_after.reviewed_at is null then
      raise exception 'Attendance approval failed for % on %.',
        v_target.employee_name,
        v_target.work_date;
    end if;

    select readiness.payroll_readiness_blockers
    into v_blockers
    from public.workforce_attendance_payroll_readiness as readiness
    where readiness.id = v_after.id;

    if coalesce(cardinality(v_blockers), 0) <> 0 then
      raise exception 'Payroll blockers remain after approving % on %: %.',
        v_target.employee_name,
        v_target.work_date,
        array_to_string(v_blockers, ', ');
    end if;
  end loop;
end;
$$;

commit;
