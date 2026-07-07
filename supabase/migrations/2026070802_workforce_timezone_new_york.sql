-- Workforce timezone default: America/New_York
--
-- Changes the workforce default from Asia/Manila to America/New_York while
-- preserving the wall-clock start and end times of existing Manila schedules.
-- Existing attendance timestamps remain unchanged because they represent actual
-- recorded instants. New attendance work dates use each profile's updated zone.

begin;

alter table public.profiles
  alter column timezone set default 'America/New_York';

alter table public.work_schedules
  alter column timezone set default 'America/New_York';

-- Preserve the displayed local shift time when moving an existing schedule from
-- Manila to New York. For example, a stored 9:00 AM Manila shift remains a
-- 9:00 AM shift after its timezone is changed to America/New_York.
update public.work_schedules
set shift_start = case
      when shift_start is null then null
      else (shift_start at time zone 'Asia/Manila') at time zone 'America/New_York'
    end,
    shift_end = case
      when shift_end is null then null
      else (shift_end at time zone 'Asia/Manila') at time zone 'America/New_York'
    end,
    timezone = 'America/New_York',
    updated_by = coalesce(updated_by, auth.uid())
where timezone = 'Asia/Manila';

update public.profiles
set timezone = 'America/New_York'
where timezone = 'Asia/Manila';

-- Older RPC definitions still use Asia/Manila as an omitted-argument fallback.
-- Normalize only that legacy fallback (plus null/blank values), while continuing
-- to permit an explicitly configured IANA timezone other than Manila.
create or replace function public.workforce_normalize_timezone_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.timezone is null
     or nullif(trim(new.timezone), '') is null
     or new.timezone = 'Asia/Manila' then
    new.timezone := 'America/New_York';
  end if;

  -- Reject invalid IANA timezone names before the row is stored.
  perform now() at time zone new.timezone;
  return new;
end;
$$;

drop trigger if exists profiles_normalize_timezone_default on public.profiles;
create trigger profiles_normalize_timezone_default
before insert or update of timezone on public.profiles
for each row execute function public.workforce_normalize_timezone_default();

drop trigger if exists work_schedules_normalize_timezone_default on public.work_schedules;
create trigger work_schedules_normalize_timezone_default
before insert or update of timezone on public.work_schedules
for each row execute function public.workforce_normalize_timezone_default();

revoke all on function public.workforce_normalize_timezone_default() from public;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'workforce_timezone_changed',
  'workforce_configuration',
  jsonb_build_object(
    'previous_timezone', 'Asia/Manila',
    'default_timezone', 'America/New_York',
    'profile_count', (
      select count(*) from public.profiles where timezone = 'America/New_York'
    ),
    'schedule_count', (
      select count(*) from public.work_schedules where timezone = 'America/New_York'
    ),
    'schedule_wall_times_preserved', true
  ),
  'Changed the workforce default timezone to America/New_York'
);

comment on function public.workforce_normalize_timezone_default() is
  'Maps legacy Manila or blank workforce timezone values to America/New_York and validates other IANA zones.';

commit;
