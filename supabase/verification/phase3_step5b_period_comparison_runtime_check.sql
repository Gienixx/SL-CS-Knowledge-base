begin;

set local role authenticated;

select set_config('phase3.step5.status', 'PENDING', true);
select set_config('phase3.step5.details', 'runtime probe not executed', true);

do $probe$
declare
  payload jsonb;
  dependency regprocedure;
begin
  dependency := to_regprocedure(
    'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'
  );

  if dependency is null then
    perform set_config('phase3.step5.status', 'FAIL', true);
    perform set_config(
      'phase3.step5.details',
      'Missing Step 4 dependency. Apply supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql before running Step 5.',
      true
    );
    return;
  end if;

  begin
    execute $sql$
      select public.get_dashboard_period_comparison(
        $1::date,
        $2::date,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::text,
        $10::text,
        $11::text
      )
    $sql$
    into payload
    using
      current_date - 6,
      current_date,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'America/New_York',
      '7d';

    if jsonb_typeof(payload) = 'object'
      and payload ? 'currentRange'
      and payload ? 'previousRange'
      and payload ? 'metrics' then
      perform set_config('phase3.step5.status', 'PASS', true);
      perform set_config(
        'phase3.step5.details',
        concat(
          'period=', coalesce(payload ->> 'periodKind', 'missing'),
          '; current=', coalesce(payload #>> '{currentRange,startDate}', 'missing'),
          '..', coalesce(payload #>> '{currentRange,endDate}', 'missing'),
          '; previous=', coalesce(payload #>> '{previousRange,startDate}', 'missing'),
          '..', coalesce(payload #>> '{previousRange,endDate}', 'missing')
        ),
        true
      );
    else
      perform set_config('phase3.step5.status', 'FAIL', true);
      perform set_config(
        'phase3.step5.details',
        'Comparison RPC returned an incomplete JSON payload.',
        true
      );
    end if;
  exception
    when others then
      perform set_config('phase3.step5.status', 'FAIL', true);
      perform set_config(
        'phase3.step5.details',
        concat(SQLSTATE, ': ', SQLERRM),
        true
      );
  end;
end;
$probe$;

select
  'runtime_comparison_rpc'::text as check_name,
  current_setting('phase3.step5.status', true) as status,
  current_setting('phase3.step5.details', true) as details;

rollback;
