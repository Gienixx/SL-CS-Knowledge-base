-- Phase 3 Step 11: Google Sheet dashboard features and optional performance targets.
-- No Zendesk reporting tables are read or modified by this migration.

begin;

create table if not exists public.dashboard_targets (
  metric_key text primary key,
  label text not null,
  target_value numeric not null,
  comparison_operator text not null default 'at_least',
  unit text not null default 'count',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.dashboard_targets
  drop constraint if exists dashboard_targets_metric_key_check;

alter table public.dashboard_targets
  add constraint dashboard_targets_metric_key_check
  check (metric_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*$');

alter table public.dashboard_targets
  drop constraint if exists dashboard_targets_operator_check;

alter table public.dashboard_targets
  add constraint dashboard_targets_operator_check
  check (comparison_operator = any (array['at_least', 'at_most']));

alter table public.dashboard_targets
  drop constraint if exists dashboard_targets_unit_check;

alter table public.dashboard_targets
  add constraint dashboard_targets_unit_check
  check (unit = any (array['count', 'ratio', 'percent', 'minutes', 'index']));

create index if not exists dashboard_targets_active_idx
  on public.dashboard_targets (active, metric_key);

alter table public.dashboard_targets enable row level security;

revoke all privileges
on table public.dashboard_targets
from anon, authenticated;

grant select
on table public.dashboard_targets
to authenticated;

grant select, insert, update, delete
on table public.dashboard_targets
to service_role;

drop policy if exists
  "Authenticated users can read active dashboard targets"
on public.dashboard_targets;

create policy
  "Authenticated users can read active dashboard targets"
on public.dashboard_targets
for select
to authenticated
using (active = true);

create or replace view public.dashboard_filter_capabilities
with (security_invoker = true)
as
select
  dimension_type,
  count(distinct dimension_key)::integer as option_count,
  count(distinct agent_key)::integer as agent_count,
  min(report_date) as first_report_date,
  max(report_date) as latest_report_date,
  sum(ticket_count)::bigint as ticket_count
from public.agent_dimension_metrics
group by dimension_type;

revoke all privileges
on table public.dashboard_filter_capabilities
from anon, authenticated;

grant select
on table public.dashboard_filter_capabilities
to authenticated, service_role;

comment on table public.dashboard_targets is
  'Optional Step 11 performance targets used for synchronized Google Sheet dashboard comparisons.';

comment on view public.dashboard_filter_capabilities is
  'Availability summary for agent-level app, platform, country, concern, priority, and channel filters supplied by agent_dimension_metrics.';

notify pgrst, 'reload schema';

commit;
