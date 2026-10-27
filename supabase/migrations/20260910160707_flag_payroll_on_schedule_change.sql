-- Mark recalculable payroll records when a referenced work schedule changes.
-- This migration does not recalculate payroll or alter finalized periods.

begin;

create or replace function public.payroll_flag_changed_schedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := coalesce(
    public.workforce_current_profile_id(),
    new.updated_by,
    old.updated_by
  );
  v_target record;
  v_before public.payroll_records%rowtype;
  v_after public.payroll_records%rowtype;
  v_reason text := format(
    'Source schedule changed after payroll calculation for %s (version %s to %s).',
    to_char(new.shift_date, 'YYYY-MM-DD'),
    old.schedule_version,
    new.schedule_version
  );
begin
  if new.schedule_version <= old.schedule_version then
    return new;
  end if;

  for v_target in
    select distinct
      record.id as payroll_record_id,
      record.payroll_period_id
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where item.source_schedule_id = new.id
      and item.source_schedule_version is not null
      and item.source_schedule_version < new.schedule_version
      and period.status in ('draft', 'review', 'reopened')
      and record.status in ('draft', 'exception', 'ready_for_review', 'approved')
  loop
    select record.*
    into v_before
    from public.payroll_records as record
    where record.id = v_target.payroll_record_id
    for update;

    if not found
       or v_before.status in ('finalized', 'void') then
      continue;
    end if;

    if v_before.requires_recalculation
       and v_before.recalculation_reason = v_reason then
      continue;
    end if;

    update public.payroll_records
    set
      requires_recalculation = true,
      recalculation_reason = v_reason,
      updated_at = now()
    where id = v_before.id
    returning * into v_after;

    insert into public.payroll_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      payroll_period_id,
      payroll_record_id,
      before_data,
      after_data,
      reason,
      metadata
    )
    values (
      v_actor_user_id,
      'payroll_schedule_changed_after_calculation',
      'payroll_record',
      v_after.id,
      v_after.payroll_period_id,
      v_after.id,
      jsonb_build_object(
        'requires_recalculation', v_before.requires_recalculation,
        'recalculation_reason', v_before.recalculation_reason
      ),
      jsonb_build_object(
        'requires_recalculation', v_after.requires_recalculation,
        'recalculation_reason', v_after.recalculation_reason
      ),
      v_reason,
      jsonb_build_object(
        'schedule_id', new.id,
        'work_date', new.shift_date,
        'previous_schedule_version', old.schedule_version,
        'new_schedule_version', new.schedule_version
      )
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists work_schedules_flag_payroll_recalculation
  on public.work_schedules;

create trigger work_schedules_flag_payroll_recalculation
after update on public.work_schedules
for each row
execute function public.payroll_flag_changed_schedule();

revoke all on function public.payroll_flag_changed_schedule()
  from public, anon, authenticated;

grant execute on function public.payroll_flag_changed_schedule()
  to service_role;

comment on function public.payroll_flag_changed_schedule() is
  'Flags only recalculable payroll records whose calculated items reference an older version of the changed schedule. Finalized and void periods are never mutated.';

commit;

;
