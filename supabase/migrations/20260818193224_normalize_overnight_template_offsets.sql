-- Keep weekly template end dates aligned with their local start/end times.

begin;

update public.work_schedule_template_days
set end_day_offset = 1,
    updated_at = now()
where not is_rest_day
  and end_time < start_time
  and end_day_offset <> 1;

create or replace function public.workforce_normalize_weekly_template_day_offset()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not new.is_rest_day and new.end_time < new.start_time then
    new.end_day_offset := 1;
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedule_template_days_normalize_offset
  on public.work_schedule_template_days;
create trigger work_schedule_template_days_normalize_offset
before insert or update of start_time, end_time, is_rest_day, end_day_offset
on public.work_schedule_template_days
for each row
execute function public.workforce_normalize_weekly_template_day_offset();

commit;
