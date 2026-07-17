-- Attendance approval and locking deployment verification.
-- Every blocker query must return zero rows; boolean checks must return true.

select to_regprocedure('public.workforce_review_attendance(uuid,text,text)') is not null
  as review_rpc_exists;

select exists (
  select 1
  from pg_trigger
  where tgrelid = 'public.attendance'::regclass
    and tgname = 'zz_attendance_locked_immutable'
    and not tgisinternal
) as locked_attendance_trigger_exists;

select
  not has_function_privilege('anon', 'public.workforce_review_attendance(uuid,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.workforce_review_attendance(uuid,text,text)', 'execute')
  as review_rpc_acl_is_safe;

-- Approved/locked present attendance must be complete and calculated.
select id, user_id, work_date, review_status
from public.attendance
where review_status in ('approved', 'locked')
  and attendance_status = 'present'
  and (
    clock_in is null
    or clock_out is null
    or pre_shift_overtime_minutes is null
    or regular_minutes is null
    or post_shift_overtime_minutes is null
  );

-- Every finalized row must carry reviewer metadata.
select id, user_id, work_date, review_status
from public.attendance
where review_status in ('approved', 'locked')
  and (reviewed_by is null or reviewed_at is null);

select action, entity_type, after_data, created_at
from public.workforce_audit_logs
where action = 'attendance_approval_locking_deployed'
order by created_at desc
limit 1;
