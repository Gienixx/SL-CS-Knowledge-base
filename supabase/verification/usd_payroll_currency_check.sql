-- USD payroll currency acceptance checks. Every boolean should be true.

select
  (
    select column_default = '''USD''::text'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agent_rates'
      and column_name = 'currency_code'
  ) as agent_rate_default_is_usd,
  (
    select column_default = '''USD''::text'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payroll_periods'
      and column_name = 'currency_code'
  ) as payroll_period_default_is_usd,
  (
    select column_default = '''USD''::text'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payroll_records'
      and column_name = 'currency_code'
  ) as payroll_record_default_is_usd,
  position(
    '''USD''::text'
    in pg_get_functiondef(
      'public.payroll_create_agent_rate(uuid,date,text,numeric,numeric,numeric,numeric,numeric)'::regprocedure
    )
  ) > 0 as create_rate_rpc_uses_usd,
  (
    select count(*) = 3
    from pg_constraint
    where conname in (
      'agent_rates_currency_code_check',
      'payroll_periods_currency_code_check',
      'payroll_records_currency_code_check'
    )
      and pg_get_constraintdef(oid) like '%USD%'
  ) as canonical_currency_constraints_are_usd,
  not exists (
    select 1 from public.agent_rates where currency_code <> 'USD'
  ) as no_non_usd_rate_rows,
  not exists (
    select 1 from public.payroll_periods where currency_code <> 'USD'
  ) as no_non_usd_period_rows,
  not exists (
    select 1 from public.payroll_records where currency_code <> 'USD'
  ) as no_non_usd_payroll_rows;
