-- Phase 3 Step 9: expand the Google Sheet reporting contract.
-- Existing dashboard columns remain available for backward compatibility.

begin;

alter table public.daily_ticket_metrics
  add column if not exists responded_tickets bigint not null default 0,
  add column if not exists first_response_minutes_total numeric(14, 2) not null default 0,
  add column if not exists first_response_median_minutes numeric(12, 2) not null default 0,
  add column if not exists resolved_tickets bigint not null default 0,
  add column if not exists resolution_minutes_total numeric(14, 2) not null default 0,
  add column if not exists resolution_median_minutes numeric(12, 2) not null default 0,
  add column if not exists reopened_tickets bigint not null default 0,
  add column if not exists one_touch_tickets bigint not null default 0;

alter table public.agent_productivity
  add column if not exists handled_tickets bigint not null default 0,
  add column if not exists handle_minutes_total numeric(14, 2) not null default 0,
  add column if not exists responded_tickets bigint not null default 0,
  add column if not exists first_response_minutes_total numeric(14, 2) not null default 0,
  add column if not exists first_response_median_minutes numeric(12, 2) not null default 0,
  add column if not exists resolved_tickets bigint not null default 0,
  add column if not exists resolution_minutes_total numeric(14, 2) not null default 0,
  add column if not exists resolution_median_minutes numeric(12, 2) not null default 0,
  add column if not exists reopened_tickets bigint not null default 0,
  add column if not exists one_touch_tickets bigint not null default 0,
  add column if not exists worked_hours numeric(12, 2) not null default 0;

create table if not exists public.agent_dimension_metrics (
  report_date date not null,
  agent_key text not null,
  agent_name text not null,
  dimension_type text not null,
  dimension_key text not null,
  dimension_label text not null,
  ticket_count bigint not null,
  updated_at timestamptz not null default now(),
  primary key (
    report_date,
    agent_key,
    dimension_type,
    dimension_key
  )
);

create table if not exists public.reporting_data_dictionary (
  contract_version integer not null,
  tab_name text not null,
  column_name text not null,
  data_type text not null,
  required boolean not null,
  definition text not null,
  validation_rule text not null,
  updated_at timestamptz not null default now(),
  primary key (
    contract_version,
    tab_name,
    column_name
  )
);

create table if not exists public.sheet_sync_metadata (
  sync_run_id text primary key,
  contract_version integer not null,
  generated_at timestamptz not null,
  source_time_zone text not null,
  test_window_start date not null,
  test_window_end date not null,
  test_days_count integer not null,
  producer text not null,
  ready_for_production boolean not null default false,
  latest_report_date date,
  rows_imported integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists agent_dimension_metrics_date_idx
  on public.agent_dimension_metrics (report_date desc);

create index if not exists agent_dimension_metrics_agent_idx
  on public.agent_dimension_metrics (agent_key, report_date desc);

create index if not exists agent_dimension_metrics_type_idx
  on public.agent_dimension_metrics (
    dimension_type,
    dimension_key,
    report_date desc
  );

create index if not exists sheet_sync_metadata_generated_idx
  on public.sheet_sync_metadata (generated_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_ticket_metrics_step9_values_check'
      and conrelid = 'public.daily_ticket_metrics'::regclass
  ) then
    alter table public.daily_ticket_metrics
      add constraint daily_ticket_metrics_step9_values_check
      check (
        responded_tickets >= 0
        and first_response_minutes_total >= 0
        and first_response_median_minutes >= 0
        and resolved_tickets >= 0
        and resolution_minutes_total >= 0
        and resolution_median_minutes >= 0
        and reopened_tickets >= 0
        and one_touch_tickets >= 0
        and one_touch_tickets <= resolved_tickets
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_productivity_step9_values_check'
      and conrelid = 'public.agent_productivity'::regclass
  ) then
    alter table public.agent_productivity
      add constraint agent_productivity_step9_values_check
      check (
        handled_tickets >= 0
        and handle_minutes_total >= 0
        and responded_tickets >= 0
        and responded_tickets <= handled_tickets
        and first_response_minutes_total >= 0
        and first_response_median_minutes >= 0
        and resolved_tickets >= 0
        and resolved_tickets <= handled_tickets
        and resolution_minutes_total >= 0
        and resolution_median_minutes >= 0
        and reopened_tickets >= 0
        and one_touch_tickets >= 0
        and one_touch_tickets <= resolved_tickets
        and worked_hours >= 0
      ) not valid;
  end if;
end
$$;

alter table public.daily_ticket_metrics
  validate constraint daily_ticket_metrics_step9_values_check;

alter table public.agent_productivity
  validate constraint agent_productivity_step9_values_check;

alter table public.agent_dimension_metrics
  drop constraint if exists agent_dimension_metrics_values_check;

alter table public.agent_dimension_metrics
  add constraint agent_dimension_metrics_values_check
  check (
    agent_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'
    and dimension_type = any (
      array['app', 'platform', 'country', 'concern', 'priority', 'channel']
    )
    and dimension_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'
    and ticket_count >= 0
  );

alter table public.reporting_data_dictionary
  drop constraint if exists reporting_data_dictionary_values_check;

alter table public.reporting_data_dictionary
  add constraint reporting_data_dictionary_values_check
  check (
    contract_version > 0
    and length(trim(tab_name)) > 0
    and length(trim(column_name)) > 0
    and length(trim(data_type)) > 0
    and length(trim(definition)) > 0
    and length(trim(validation_rule)) > 0
  );

alter table public.sheet_sync_metadata
  drop constraint if exists sheet_sync_metadata_values_check;

alter table public.sheet_sync_metadata
  add constraint sheet_sync_metadata_values_check
  check (
    contract_version = 3
    and source_time_zone = 'America/New_York'
    and test_window_end >= test_window_start
    and test_days_count >= 1
    and rows_imported >= 0
  );

alter table public.agent_dimension_metrics enable row level security;
alter table public.reporting_data_dictionary enable row level security;
alter table public.sheet_sync_metadata enable row level security;

revoke all privileges
on table
  public.agent_dimension_metrics,
  public.reporting_data_dictionary,
  public.sheet_sync_metadata
from anon, authenticated;

grant select
on table
  public.agent_dimension_metrics,
  public.reporting_data_dictionary,
  public.sheet_sync_metadata
to authenticated;

grant select, insert, update, delete
on table
  public.agent_dimension_metrics,
  public.reporting_data_dictionary,
  public.sheet_sync_metadata
to service_role;

drop policy if exists
  "Authenticated users can read agent dimension metrics"
on public.agent_dimension_metrics;

create policy
  "Authenticated users can read agent dimension metrics"
on public.agent_dimension_metrics
for select
to authenticated
using (true);

drop policy if exists
  "Authenticated users can read reporting data dictionary"
on public.reporting_data_dictionary;

create policy
  "Authenticated users can read reporting data dictionary"
on public.reporting_data_dictionary
for select
to authenticated
using (true);

drop policy if exists
  "Authenticated users can read sheet sync metadata"
on public.sheet_sync_metadata;

create policy
  "Authenticated users can read sheet sync metadata"
on public.sheet_sync_metadata
for select
to authenticated
using (true);

comment on table public.agent_dimension_metrics is
  'Phase 3 Step 9 agent-level app, platform, country, concern, priority, and channel counts from Google Sheet.';

comment on table public.reporting_data_dictionary is
  'Versioned business definitions and validation rules for the Google Sheet reporting contract.';

comment on table public.sheet_sync_metadata is
  'One record per Step 9 sync run, including the seven-day rollout readiness state.';

comment on column public.agent_productivity.handle_minutes_total is
  'Total handle minutes from the normalized Ticket Productivity tab.';

comment on column public.agent_productivity.worked_hours is
  'Hours worked by the agent for the reporting date.';

commit;
