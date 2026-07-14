begin;

-- Replace legacy fallbacks in active functions without rewriting migration history.
do $$
declare
  function_row record;
begin
  for function_row in
    select pg_get_functiondef(procedure.oid) as definition
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.prokind = 'f'
      and pg_get_functiondef(procedure.oid) like '%Asia/Manila%'
  loop
    execute replace(function_row.definition, 'Asia/Manila', 'America/New_York');
  end loop;
end;
$$;

-- The website has one workforce timezone. Normalize every write instead of
-- allowing a browser, RPC caller, or old client bundle to restore another zone.
create or replace function public.workforce_normalize_timezone_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.timezone := 'America/New_York';
  return new;
end;
$$;

alter table public.profiles
  alter column timezone set default 'America/New_York';
alter table public.work_schedules
  alter column timezone set default 'America/New_York';
alter table public.work_schedule_templates
  alter column timezone set default 'America/New_York';
alter table public.daily_operations_metrics
  alter column report_timezone set default 'America/New_York';
alter table public.google_calendar_connections
  alter column calendar_timezone set default 'America/New_York';
alter table public.sheet_sync_metadata
  alter column source_time_zone set default 'America/New_York';

update public.profiles set timezone = 'America/New_York'
where timezone is distinct from 'America/New_York';
update public.work_schedules set timezone = 'America/New_York'
where timezone is distinct from 'America/New_York';
update public.work_schedule_templates set timezone = 'America/New_York'
where timezone is distinct from 'America/New_York';
update public.daily_operations_metrics set report_timezone = 'America/New_York'
where report_timezone is distinct from 'America/New_York';
update public.google_calendar_connections set calendar_timezone = 'America/New_York'
where calendar_timezone is distinct from 'America/New_York';
update public.sheet_sync_metadata set source_time_zone = 'America/New_York'
where source_time_zone is distinct from 'America/New_York';

drop trigger if exists work_schedule_templates_normalize_timezone_default
  on public.work_schedule_templates;
create trigger work_schedule_templates_normalize_timezone_default
before insert or update of timezone on public.work_schedule_templates
for each row execute function public.workforce_normalize_timezone_default();

alter table public.profiles drop constraint if exists profiles_timezone_new_york_check;
alter table public.profiles add constraint profiles_timezone_new_york_check
  check (timezone = 'America/New_York');
alter table public.work_schedules drop constraint if exists work_schedules_timezone_new_york_check;
alter table public.work_schedules add constraint work_schedules_timezone_new_york_check
  check (timezone = 'America/New_York');
alter table public.work_schedule_templates drop constraint if exists work_schedule_templates_timezone_new_york_check;
alter table public.work_schedule_templates add constraint work_schedule_templates_timezone_new_york_check
  check (timezone = 'America/New_York');
alter table public.daily_operations_metrics drop constraint if exists daily_operations_metrics_timezone_new_york_check;
alter table public.daily_operations_metrics add constraint daily_operations_metrics_timezone_new_york_check
  check (report_timezone = 'America/New_York');
alter table public.google_calendar_connections drop constraint if exists google_calendar_connections_timezone_new_york_check;
alter table public.google_calendar_connections add constraint google_calendar_connections_timezone_new_york_check
  check (calendar_timezone is null or calendar_timezone = 'America/New_York');
alter table public.sheet_sync_metadata drop constraint if exists sheet_sync_metadata_timezone_new_york_check;
alter table public.sheet_sync_metadata add constraint sheet_sync_metadata_timezone_new_york_check
  check (source_time_zone = 'America/New_York');

comment on function public.workforce_normalize_timezone_default() is
  'Forces workforce profile, schedule, and template records to America/New_York.';

commit;
