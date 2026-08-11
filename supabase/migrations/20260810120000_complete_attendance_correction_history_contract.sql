-- Complete the explicit schedule transition contract while retaining the
-- existing attendance_corrections history table and RPC architecture.

begin;

alter table public.attendance_corrections
  add column if not exists new_schedule_id uuid references public.work_schedules(id) on delete set null;

update public.attendance_corrections
set new_schedule_id = schedule_id
where new_schedule_id is null;

create or replace function public.workforce_sync_correction_schedule_history()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.new_schedule_id is null and new.schedule_id is not null then
    new.new_schedule_id := new.schedule_id;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_corrections_sync_schedule_history
  on public.attendance_corrections;
create trigger attendance_corrections_sync_schedule_history
before insert or update on public.attendance_corrections
for each row execute function public.workforce_sync_correction_schedule_history();

create index if not exists attendance_corrections_schedule_transition_idx
  on public.attendance_corrections (attendance_id, corrected_at desc, previous_schedule_id, new_schedule_id);

comment on column public.attendance_corrections.schedule_id is
  'New/current schedule link retained for compatibility with existing correction RPCs.';
comment on column public.attendance_corrections.previous_schedule_id is
  'Schedule linked before this correction.';
comment on column public.attendance_corrections.new_schedule_id is
  'Schedule linked after this correction; synchronized from schedule_id for existing RPCs.';

commit;
