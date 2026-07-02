begin;

create table if not exists public.zendesk_sla_readiness (
  singleton boolean primary key default true check (singleton = true),
  policy_evidence boolean not null default false,
  breach_evidence boolean not null default false,
  last_observed_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.zendesk_sla_readiness (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.zendesk_sla_readiness enable row level security;

revoke all privileges
on table public.zendesk_sla_readiness
from public, anon, authenticated;

grant select, insert, update
on table public.zendesk_sla_readiness
to service_role;

create or replace function public.advance_zendesk_sla_sync_state(
  p_stream_key text,
  p_lock_token uuid,
  p_start_time bigint,
  p_last_event_timestamp timestamptz,
  p_policy_evidence boolean,
  p_breach_evidence boolean,
  p_observed_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy_ready boolean;
begin
  if p_stream_key <> 'ticket_metric_events' then
    raise exception 'invalid_sla_stream_key';
  end if;

  if p_lock_token is null then
    raise exception 'lock_token_required';
  end if;

  insert into public.zendesk_sla_readiness (
    singleton,
    policy_evidence,
    breach_evidence,
    last_observed_at,
    updated_at
  ) values (
    true,
    coalesce(p_policy_evidence, false),
    coalesce(p_breach_evidence, false),
    coalesce(p_observed_at, now()),
    now()
  )
  on conflict (singleton) do update
  set policy_evidence =
        public.zendesk_sla_readiness.policy_evidence or excluded.policy_evidence,
      breach_evidence =
        public.zendesk_sla_readiness.breach_evidence or excluded.breach_evidence,
      last_observed_at = greatest(
        public.zendesk_sla_readiness.last_observed_at,
        excluded.last_observed_at
      ),
      updated_at = now()
  returning policy_evidence into v_policy_ready;

  update public.zendesk_sync_state
  set
    cursor = null,
    start_time = coalesce(p_start_time, start_time),
    last_event_timestamp = coalesce(
      p_last_event_timestamp,
      last_event_timestamp
    ),
    last_success_at = case
      when v_policy_ready then now()
      else last_success_at
    end,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where stream_key = p_stream_key
    and lease_token = p_lock_token;

  if not found then
    raise exception 'zendesk_sync_lock_lost'
      using errcode = '55P03';
  end if;

  return v_policy_ready;
end;
$$;

revoke all
on function public.advance_zendesk_sla_sync_state(
  text,
  uuid,
  bigint,
  timestamptz,
  boolean,
  boolean,
  timestamptz
)
from public, anon, authenticated;

grant execute
on function public.advance_zendesk_sla_sync_state(
  text,
  uuid,
  bigint,
  timestamptz,
  boolean,
  boolean,
  timestamptz
)
to service_role;

comment on table public.zendesk_sla_readiness is
  'Server-only evidence gate that prevents unvalidated SLA exports from appearing as zero breaches.';

comment on function public.advance_zendesk_sla_sync_state(
  text,
  uuid,
  bigint,
  timestamptz,
  boolean,
  boolean,
  timestamptz
) is
  'Advances the SLA stream while marking it report-ready only after policy evidence is observed.';

notify pgrst, 'reload schema';

commit;
