begin;

create or replace function public.normalize_agent_productivity_aht_unit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.aht_unit := 'minutes.seconds';
  return new;
end;
$$;

drop trigger if exists normalize_agent_productivity_aht_unit
  on public.agent_productivity;

create trigger normalize_agent_productivity_aht_unit
before insert or update on public.agent_productivity
for each row
execute function public.normalize_agent_productivity_aht_unit();

update public.agent_productivity
set aht_unit = 'minutes.seconds'
where aht_unit is distinct from 'minutes.seconds';

alter table public.agent_productivity
  alter column aht_unit set default 'minutes.seconds',
  alter column aht_unit set not null;

comment on column public.agent_productivity.aht_value is
  'Average handle time stored as decimal minutes and displayed as minutes:seconds.';

comment on column public.agent_productivity.aht_unit is
  'Confirmed AHT unit. The canonical value is minutes.seconds.';

commit;
