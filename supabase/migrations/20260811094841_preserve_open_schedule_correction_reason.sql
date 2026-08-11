begin;

alter function public.workforce_admin_save_open_schedule(
  uuid, uuid, date, integer, text, text, text, integer
) rename to workforce_admin_save_open_schedule_without_audit_reason;

create function public.workforce_admin_save_open_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_timezone text,
  p_status text,
  p_notes text,
  p_planned_paid_minutes integer
)
returns public.work_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.work_schedules%rowtype;
  v_result public.work_schedules%rowtype;
  v_started_at timestamptz := clock_timestamp();
  v_reason text := nullif(trim(coalesce(p_notes, '')), '');
  v_meaningful_change boolean := false;
  v_audit_id uuid;
begin
  if p_schedule_id is not null then
    select * into v_existing from public.work_schedules where id = p_schedule_id;
    if not found then raise exception 'Schedule entry not found.'; end if;
    v_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from p_shift_sequence::smallint
      or v_existing.shift_start is not null
      or v_existing.shift_end is not null
      or v_existing.timezone is distinct from coalesce(nullif(trim(p_timezone), ''), 'America/New_York')
      or v_existing.is_rest_day
      or v_existing.is_holiday
      or v_existing.planned_paid_minutes is distinct from p_planned_paid_minutes;
    if v_meaningful_change and v_reason is null then
      raise exception 'A reason is required for open schedule corrections.';
    end if;
  end if;

  v_result := public.workforce_admin_save_open_schedule_without_audit_reason(
    p_schedule_id, p_user_id, p_shift_date, p_shift_sequence, p_timezone,
    p_status, p_notes, p_planned_paid_minutes
  );

  if v_meaningful_change then
    select l.id into v_audit_id
    from public.workforce_audit_logs l
    where l.entity_id = v_result.id
      and l.entity_type = 'work_schedules'
      and l.action = 'update'
      and l.created_at >= v_started_at
      and l.reason is null
    order by l.created_at desc
    limit 1;

    if v_audit_id is not null then
      update public.workforce_audit_logs set reason = v_reason where id = v_audit_id;
    else
      insert into public.workforce_audit_logs (
        actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
      ) values (
        v_actor, 'historical_schedule_correction', 'work_schedules', v_result.id,
        to_jsonb(v_existing), to_jsonb(v_result), v_reason
      );
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_admin_save_open_schedule(uuid,uuid,date,integer,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.workforce_admin_save_open_schedule(uuid,uuid,date,integer,text,text,text,integer)
  to authenticated;

-- Targeted repair only for the two known Jean Open Schedule conversion audits.
update public.workforce_audit_logs
set reason = 'Historical Open Schedule correction: preserve linked attendance while converting the scheduled shift to a flexible paid schedule.'
where id in (
  '4521b6a5-304a-4f7a-b266-6d02d326a8e3'::uuid,
  'a09b34b4-d8f3-48a5-a033-89c98b9d683a'::uuid
)
and reason is null
and action = 'update'
and entity_type = 'work_schedules';

commit;
