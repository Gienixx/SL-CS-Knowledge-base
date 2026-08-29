begin;

-- The PayPal USD-to-PHP value is a display preference for the payroll rate
-- page. It is intentionally separate from USD payroll data and is exposed
-- only through the guarded RPCs below.
create table public.payroll_display_conversion_settings (
  setting_key text primary key,
  usd_to_php_rate numeric(18,8) not null,
  updated_by uuid not null references public.profiles(user_id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint payroll_display_conversion_settings_key_check
    check (setting_key = 'paypal_usd_php'),
  constraint payroll_display_conversion_settings_rate_check
    check (usd_to_php_rate > 0)
);

alter table public.payroll_display_conversion_settings enable row level security;
revoke all on table public.payroll_display_conversion_settings from public, anon, authenticated;
grant all on table public.payroll_display_conversion_settings to service_role;

comment on table public.payroll_display_conversion_settings is
  'Admin-maintained display-only currency conversions; never used by USD payroll calculations.';

create or replace function public.payroll_get_paypal_conversion_rate()
returns table (
  usd_to_php_rate numeric,
  updated_at timestamptz,
  updated_by uuid,
  updated_by_name text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('manage_agent_rates') then
    raise exception
      using
        errcode = '42501',
        message = 'Payroll rate access is required to view the PayPal conversion rate.';
  end if;

  return query
  select
    setting.usd_to_php_rate,
    setting.updated_at,
    setting.updated_by,
    coalesce(nullif(trim(profile.full_name), ''), profile.email)
  from public.payroll_display_conversion_settings as setting
  join public.profiles as profile
    on profile.user_id = setting.updated_by
  where setting.setting_key = 'paypal_usd_php';
end;
$$;

revoke all on function public.payroll_get_paypal_conversion_rate() from public;
revoke execute on function public.payroll_get_paypal_conversion_rate() from anon;
grant execute on function public.payroll_get_paypal_conversion_rate()
  to authenticated, service_role;

comment on function public.payroll_get_paypal_conversion_rate() is
  'Returns the admin-maintained PayPal USD-to-PHP display rate and update attribution.';

create or replace function public.payroll_set_paypal_conversion_rate(
  p_usd_to_php_rate numeric
)
returns table (
  usd_to_php_rate numeric,
  updated_at timestamptz,
  updated_by uuid,
  updated_by_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_before public.payroll_display_conversion_settings%rowtype;
  v_after public.payroll_display_conversion_settings%rowtype;
  v_before_data jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_agent_rates') then
    raise exception
      using
        errcode = '42501',
        message = 'Payroll administrator access is required to change the PayPal conversion rate.';
  end if;

  if p_usd_to_php_rate is null
     or p_usd_to_php_rate <= 0
     or p_usd_to_php_rate::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception
      using
        errcode = '22023',
        message = 'PayPal conversion rate must be a valid positive decimal.';
  end if;

  select *
  into v_before
  from public.payroll_display_conversion_settings
  where setting_key = 'paypal_usd_php'
  for update;

  v_before_data := case
    when v_before.setting_key is null then null
    else jsonb_build_object(
      'setting_key', v_before.setting_key,
      'usd_to_php_rate', v_before.usd_to_php_rate,
      'updated_by', v_before.updated_by,
      'updated_at', v_before.updated_at
    )
  end;

  insert into public.payroll_display_conversion_settings (
    setting_key,
    usd_to_php_rate,
    updated_by,
    updated_at
  )
  values (
    'paypal_usd_php',
    p_usd_to_php_rate,
    v_actor_user_id,
    now()
  )
  on conflict (setting_key) do update
  set usd_to_php_rate = excluded.usd_to_php_rate,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  returning * into v_after;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_display_conversion_setting_updated',
    'payroll_display_conversion_setting',
    v_before_data,
    jsonb_build_object(
      'setting_key', v_after.setting_key,
      'usd_to_php_rate', v_after.usd_to_php_rate,
      'updated_by', v_after.updated_by,
      'updated_at', v_after.updated_at
    ),
    'Updated the admin-maintained PayPal USD-to-PHP display conversion rate.',
    jsonb_build_object(
      'source', 'agent_rates_page',
      'display_only', true,
      'canonical_payroll_currency', 'USD'
    )
  );

  return query
  select
    v_after.usd_to_php_rate,
    v_after.updated_at,
    v_after.updated_by,
    coalesce(nullif(trim(profile.full_name), ''), profile.email)
  from public.profiles as profile
  where profile.user_id = v_after.updated_by;
end;
$$;

revoke all on function public.payroll_set_paypal_conversion_rate(numeric) from public;
revoke execute on function public.payroll_set_paypal_conversion_rate(numeric) from anon;
grant execute on function public.payroll_set_paypal_conversion_rate(numeric)
  to authenticated, service_role;

comment on function public.payroll_set_paypal_conversion_rate(numeric) is
  'Stores one audited, positive PayPal USD-to-PHP display rate without changing USD payroll data.';

commit;
