-- Restrict browser access to read-only dashboard metric queries.
-- The Cloudflare synchronization endpoint continues to write with service_role.

begin;

-- Remove any older policies so these reporting tables have one explicit,
-- auditable access model after this migration.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'daily_ticket_metrics',
        'daily_distribution_metrics',
        'agent_productivity',
        'ticket_driver_metrics'
      ])
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end
$$;

alter table public.daily_ticket_metrics enable row level security;
alter table public.daily_distribution_metrics enable row level security;
alter table public.agent_productivity enable row level security;
alter table public.ticket_driver_metrics enable row level security;

-- Anonymous browser requests receive no access. Authenticated browser users
-- receive SELECT only; INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and
-- TRIGGER privileges are removed.
revoke all privileges
on table
  public.daily_ticket_metrics,
  public.daily_distribution_metrics,
  public.agent_productivity,
  public.ticket_driver_metrics
from anon, authenticated;

grant select
on table
  public.daily_ticket_metrics,
  public.daily_distribution_metrics,
  public.agent_productivity,
  public.ticket_driver_metrics
to authenticated;

-- Preserve the server-side synchronization writer. The service_role key also
-- bypasses RLS, but explicit table privileges are retained for PostgREST DML.
grant select, insert, update, delete
on table
  public.daily_ticket_metrics,
  public.daily_distribution_metrics,
  public.agent_productivity,
  public.ticket_driver_metrics
to service_role;

create policy "Authenticated users can read daily ticket metrics"
on public.daily_ticket_metrics
for select
to authenticated
using (true);

create policy "Authenticated users can read distribution metrics"
on public.daily_distribution_metrics
for select
to authenticated
using (true);

create policy "Authenticated users can read agent productivity"
on public.agent_productivity
for select
to authenticated
using (true);

create policy "Authenticated users can read ticket driver metrics"
on public.ticket_driver_metrics
for select
to authenticated
using (true);

commit;
