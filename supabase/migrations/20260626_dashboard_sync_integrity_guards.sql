-- Phase 2 Step 10: enforce idempotent dashboard synchronization.
-- Existing duplicate keys are collapsed before the unique indexes are created.
-- The most recently updated row is retained for each logical key.

begin;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by report_date
      order by updated_at desc nulls last, ctid desc
    ) as duplicate_rank
  from public.daily_ticket_metrics
)
delete from public.daily_ticket_metrics as target
using ranked
where target.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by report_date, dimension_type, dimension_key
      order by updated_at desc nulls last, ctid desc
    ) as duplicate_rank
  from public.daily_distribution_metrics
)
delete from public.daily_distribution_metrics as target
using ranked
where target.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by report_date, agent_key
      order by updated_at desc nulls last, ctid desc
    ) as duplicate_rank
  from public.agent_productivity
)
delete from public.agent_productivity as target
using ranked
where target.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by report_date, driver_key
      order by updated_at desc nulls last, ctid desc
    ) as duplicate_rank
  from public.ticket_driver_metrics
)
delete from public.ticket_driver_metrics as target
using ranked
where target.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

create unique index if not exists daily_ticket_metrics_report_date_uidx
  on public.daily_ticket_metrics (report_date);

create unique index if not exists daily_distribution_metrics_key_uidx
  on public.daily_distribution_metrics (
    report_date,
    dimension_type,
    dimension_key
  );

create unique index if not exists agent_productivity_key_uidx
  on public.agent_productivity (report_date, agent_key);

create unique index if not exists ticket_driver_metrics_key_uidx
  on public.ticket_driver_metrics (report_date, driver_key);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_ticket_metrics_values_check'
      and conrelid = 'public.daily_ticket_metrics'::regclass
  ) then
    alter table public.daily_ticket_metrics
      add constraint daily_ticket_metrics_values_check
      check (
        new_tickets >= 0
        and unsolved_tickets >= 0
        and solved_tickets >= 0
        and one_touch_resolution between 0 and 1
        and reopened_rate between 0 and 1
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_distribution_metrics_values_check'
      and conrelid = 'public.daily_distribution_metrics'::regclass
  ) then
    alter table public.daily_distribution_metrics
      add constraint daily_distribution_metrics_values_check
      check (ticket_count >= 0) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_productivity_values_check'
      and conrelid = 'public.agent_productivity'::regclass
  ) then
    alter table public.agent_productivity
      add constraint agent_productivity_values_check
      check (
        solved_tickets >= 0
        and (open_tickets is null or open_tickets >= 0)
        and (aht_value is null or aht_value >= 0)
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ticket_driver_metrics_values_check'
      and conrelid = 'public.ticket_driver_metrics'::regclass
  ) then
    alter table public.ticket_driver_metrics
      add constraint ticket_driver_metrics_values_check
      check (ticket_count >= 0) not valid;
  end if;
end
$$;

alter table public.daily_ticket_metrics
  validate constraint daily_ticket_metrics_values_check;

alter table public.daily_distribution_metrics
  validate constraint daily_distribution_metrics_values_check;

alter table public.agent_productivity
  validate constraint agent_productivity_values_check;

alter table public.ticket_driver_metrics
  validate constraint ticket_driver_metrics_values_check;

commit;
