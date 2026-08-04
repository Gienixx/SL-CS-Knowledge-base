-- Rollback-only functional check for agent submission and administrator review.
begin;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
    'leave-agent@example.test', '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
    'leave-admin@example.test', '{"provider":"email","providers":["email"]}', '{}', now(), now()
  )
on conflict (id) do nothing;

insert into public.profiles (
  user_id, full_name, email, employee_id, base_role, is_agent, employment_status
) values
  (
    '10000000-0000-0000-0000-000000000001', 'Leave Test Agent',
    'leave-agent@example.test', 'LEAVE-TEST-AGENT', 'agent', true, 'active'
  ),
  (
    '10000000-0000-0000-0000-000000000002', 'Leave Test Admin',
    'leave-admin@example.test', 'LEAVE-TEST-ADMIN', 'admin', true, 'active'
  )
on conflict (user_id) do nothing;

insert into public.user_permissions (
  user_id, permission_key, is_granted, granted_by, reason
) values (
  '10000000-0000-0000-0000-000000000002',
  'approve_leave',
  true,
  '10000000-0000-0000-0000-000000000002',
  'Rollback-only leave workflow verification'
)
on conflict (user_id, permission_key) do update
set is_granted = true,
    reason = excluded.reason,
    updated_at = now();

insert into public.work_schedules (
  user_id, shift_date, shift_sequence, shift_start, shift_end, status,
  is_rest_day, is_holiday, is_leave, is_absent, created_by, updated_by
) values (
  '10000000-0000-0000-0000-000000000001',
  date '2099-08-10',
  1,
  timestamptz '2099-08-10 09:00:00-04',
  timestamptz '2099-08-10 17:00:00-04',
  'published',
  false,
  false,
  false,
  false,
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"leave-agent@example.test"}',
  true
);

select (public.workforce_submit_leave_request(
  'incentive_vl',
  date '2099-08-10',
  date '2099-08-11',
  'Rollback-only approval test'
)).id;

do $$
begin
  begin
    insert into public.leave_requests (
      user_id, leave_type, start_date, end_date, reason, status
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'birthday_vl',
      date '2099-09-01',
      date '2099-09-01',
      'This direct write must fail',
      'pending'
    );
    raise exception 'Authenticated direct leave insert unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","email":"leave-admin@example.test"}',
  true
);

select (public.workforce_review_leave_request(
  (
    select id
    from public.leave_requests
    where user_id = '10000000-0000-0000-0000-000000000001'
      and start_date = date '2099-08-10'
  ),
  'approved',
  null
)).status;

reset role;

do $$
declare
  v_request_id uuid;
  v_linked_count integer;
begin
  select id
  into strict v_request_id
  from public.leave_requests
  where user_id = '10000000-0000-0000-0000-000000000001'
    and start_date = date '2099-08-10';

  select count(*)
  into v_linked_count
  from public.work_schedules
  where leave_request_id = v_request_id
    and shift_date between date '2099-08-10' and date '2099-08-11'
    and is_leave
    and leave_type = 'incentive_vl'
    and shift_start is null
    and shift_end is null;

  if v_linked_count <> 2 then
    raise exception 'Expected two linked Incentive VL schedule rows; found %.', v_linked_count;
  end if;

  if exists (
    select 1
    from public.attendance
    where user_id = '10000000-0000-0000-0000-000000000001'
      and work_date between date '2099-08-10' and date '2099-08-11'
  ) then
    raise exception 'Leave approval created an attendance record.';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"leave-agent@example.test"}',
  true
);

select (public.workforce_submit_leave_request(
  'leave_without_pay',
  date '2099-08-12',
  date '2099-08-12',
  'Rollback-only denial test'
)).id;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","email":"leave-admin@example.test"}',
  true
);

do $$
declare
  v_request_id uuid;
begin
  select id
  into strict v_request_id
  from public.leave_requests
  where user_id = '10000000-0000-0000-0000-000000000001'
    and start_date = date '2099-08-12';

  begin
    perform public.workforce_review_leave_request(v_request_id, 'rejected', null);
    raise exception 'Denial without a reason unexpectedly succeeded.';
  exception
    when raise_exception then
      if sqlerrm <> 'A denial reason is required.' then
        raise;
      end if;
  end;

  perform public.workforce_review_leave_request(
    v_request_id,
    'rejected',
    'Rollback-only manager reason'
  );
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.leave_requests
    where user_id = '10000000-0000-0000-0000-000000000001'
      and start_date = date '2099-08-12'
      and status = 'rejected'
      and review_notes = 'Rollback-only manager reason'
  ) then
    raise exception 'Denied request did not retain the administrator reason.';
  end if;
end;
$$;

rollback;
