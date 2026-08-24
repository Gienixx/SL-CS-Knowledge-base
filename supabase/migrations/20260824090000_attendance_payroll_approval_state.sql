-- Preserve payroll approval independently from the existing review/lock state.
-- review_status remains the workflow state and locked attendance remains immutable.

begin;

alter table public.attendance
  add column if not exists payroll_approved_at timestamptz;

comment on column public.attendance.payroll_approved_at is
  'Timestamp when this attendance entry was last approved for payroll. It survives locking and is cleared when an attendance correction reopens review. Historical locked rows may remain null when approval can only be proven from immutable audit history.';

create index if not exists attendance_payroll_approved_at_idx
  on public.attendance (payroll_approved_at, work_date desc)
  where payroll_approved_at is not null;

-- Backfill only rows that the locked-attendance protection legally permits us
-- to update. Historical locked rows are intentionally never updated: when
-- their approval is provable from immutable audit history, the authorized
-- Team Attendance listing derives the effective marker at read time.
with approval_events as (
  select
    log.entity_id as attendance_id,
    max(nullif(log.after_data ->> 'reviewed_at', '')::timestamptz) as approved_at
  from public.workforce_audit_logs log
  where log.entity_type = 'attendance'
    and log.action = 'attendance_approved'
    and log.after_data ->> 'review_status' = 'approved'
    and nullif(log.after_data ->> 'reviewed_at', '') is not null
  group by log.entity_id
)
update public.attendance attendance_row
set payroll_approved_at = coalesce(attendance_row.reviewed_at, approval_events.approved_at)
from approval_events
where attendance_row.id = approval_events.attendance_id
  and attendance_row.payroll_approved_at is null
  and attendance_row.review_status = 'approved';

-- Current approved rows are themselves canonical approval evidence, even when
-- the explicit approval audit event predates the retained audit window.
update public.attendance
set payroll_approved_at = reviewed_at
where payroll_approved_at is null
  and review_status = 'approved'
  and reviewed_at is not null;

-- Keep the canonical approval/locking RPC and permissions unchanged, adding only
-- persistence of the independent payroll approval marker.
create or replace function public.workforce_review_attendance(
  p_attendance_id uuid,
  p_review_status text,
  p_review_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid;
  v_attendance public.attendance%rowtype;
  v_result public.attendance%rowtype;
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
begin
  v_actor_user_id := public.workforce_current_profile_id();

  if v_actor_user_id is null then
    raise exception 'Authenticated workforce profile is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_review_status not in ('approved', 'locked') then
    raise exception 'Review status must be approved or locked.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if not public.workforce_can_approve_attendance(v_attendance.user_id) then
    raise exception 'You do not have permission to approve this attendance record.';
  end if;

  if v_attendance.review_status = 'locked' then
    if p_review_status = 'locked' then
      return v_attendance;
    end if;
    raise exception 'Locked attendance cannot be changed.';
  end if;

  if p_review_status = 'approved' then
    if v_attendance.review_status = 'approved' then
      if v_attendance.payroll_approved_at is null then
        update public.attendance
        set payroll_approved_at = coalesce(v_attendance.reviewed_at, now()),
            updated_by = v_actor_user_id,
            updated_at = now()
        where id = v_attendance.id
        returning * into v_attendance;
      end if;
      return v_attendance;
    end if;

    if v_attendance.review_status not in ('pending', 'corrected') then
      raise exception 'Only pending or corrected attendance can be approved.';
    end if;

    if v_attendance.attendance_status = 'present'
       and (v_attendance.clock_in is null or v_attendance.clock_out is null) then
      raise exception 'Completed clock-in and clock-out values are required before approval.';
    end if;

    if v_attendance.clock_out is not null
       and (
         v_attendance.pre_shift_overtime_minutes is null
         or v_attendance.regular_minutes is null
         or v_attendance.post_shift_overtime_minutes is null
       ) then
      raise exception 'Attendance calculations must be complete before approval.';
    end if;
  elsif v_attendance.review_status <> 'approved' then
    raise exception 'Attendance must be approved before it can be locked.';
  end if;

  update public.attendance
  set review_status = p_review_status,
      payroll_approved_at = case
        when p_review_status = 'approved'
          then coalesce(v_attendance.payroll_approved_at, now())
        else v_attendance.payroll_approved_at
      end,
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      updated_by = v_actor_user_id,
      updated_at = now()
  where id = v_attendance.id
  returning * into v_result;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    case p_review_status
      when 'approved' then 'attendance_approved'
      else 'attendance_locked'
    end,
    'attendance',
    v_result.id,
    jsonb_build_object(
      'attendance_id', v_attendance.id,
      'employee_user_id', v_attendance.user_id,
      'work_date', v_attendance.work_date,
      'review_status', v_attendance.review_status,
      'payroll_approved_at', v_attendance.payroll_approved_at,
      'reviewed_by', v_attendance.reviewed_by,
      'reviewed_at', v_attendance.reviewed_at
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'employee_user_id', v_result.user_id,
      'work_date', v_result.work_date,
      'review_status', v_result.review_status,
      'payroll_approved_at', v_result.payroll_approved_at,
      'reviewed_by', v_result.reviewed_by,
      'reviewed_at', v_result.reviewed_at
    ),
    coalesce(v_review_notes, concat('Attendance ', p_review_status, ' through Team Attendance'))
  );

  return v_result;
end;
$$;

comment on function public.workforce_review_attendance(uuid, text, text) is
  'Approves complete attendance and irreversibly locks approved attendance after explicit permission and scope checks; payroll approval state survives locking.';

revoke all on function public.workforce_review_attendance(uuid, text, text) from public, anon;
grant execute on function public.workforce_review_attendance(uuid, text, text) to authenticated;

-- Every correction/reopen path must clear the current approval marker. The
-- existing review_status transitions, calculations, history, and permissions
-- remain exactly as defined by the live function bodies.
do $$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.workforce_assign_attendance_schedule(uuid,uuid,text,text)',
    'public.workforce_correct_attendance(uuid,timestamptz,timestamptz,text,uuid,text,text,text)'
  ] loop
    v_definition := replace(pg_get_functiondef(v_signature::regprocedure), chr(13), '');

    if position('workforce_assign_attendance_schedule' in v_signature) > 0 then
      v_updated := replace(
        v_definition,
        'review_status = case when review_status = ''approved'' then ''corrected'' else review_status end,',
        'review_status = case when review_status = ''approved'' then ''corrected'' else review_status end,
      payroll_approved_at = null,'
      );
    else
      v_updated := replace(
        v_definition,
        'review_status = ''corrected'',',
        'review_status = ''corrected'',
      payroll_approved_at = null,'
      );
    end if;

    if v_updated = v_definition then
      raise exception '% live definition did not expose its expected approval-reopen transition', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$$;

-- Extend the permission-scoped Team Attendance listing with the independent
-- marker. Agents continue to receive redacted approval data, as before.
do $$
declare
  v_definition text;
  v_updated text;
  v_effective_marker_expression text := $effective_marker$
    case when v_is_admin then
      coalesce(
        attendance_row.payroll_approved_at,
        case
          when attendance_row.review_status = 'locked' then (
            select max(nullif(log.after_data ->> 'reviewed_at', '')::timestamptz)
            from public.workforce_audit_logs log
            where log.entity_type = 'attendance'
              and log.action = 'attendance_approved'
              and log.entity_id = attendance_row.id
              and log.after_data ->> 'review_status' = 'approved'
              and nullif(log.after_data ->> 'reviewed_at', '') is not null
          )
        end
      )
    else null end,
  $effective_marker$;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_list_team_attendance(date,date)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    'is_corrected boolean, review_status text, corrected_by uuid,',
    'is_corrected boolean, review_status text, payroll_approved_at timestamptz, corrected_by uuid,'
  );
  v_updated := replace(
    v_updated,
    'case when v_is_admin then attendance_row.review_status else ''pending'' end,',
    'case when v_is_admin then attendance_row.review_status else ''pending'' end,'
      || v_effective_marker_expression
  );
  if v_updated = v_definition
     or position('payroll_approved_at timestamptz' in v_updated) = 0
     or position('attendance_row.payroll_approved_at' in v_updated) = 0
     or position('workforce_audit_logs' in v_updated) = 0
     or position('log.entity_id = attendance_row.id' in v_updated) = 0 then
    raise exception 'workforce_list_team_attendance live definition did not expose the protected effective approval marker';
  end if;
  drop function public.workforce_list_team_attendance(date,date);
  execute v_updated;
end;
$$;

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
) values (
  'attendance_payroll_approval_state_deployed',
  'attendance',
  jsonb_build_object(
    'column', 'payroll_approved_at',
    'locked_review_status_unchanged', true,
    'historical_backfill_requires_proof', true,
    'historical_locked_approval_derived_in_admin_rpc', true,
    'locked_attendance_immutable', true
  ),
  'Added independent payroll approval state without changing attendance review or lock semantics.'
);

commit;
