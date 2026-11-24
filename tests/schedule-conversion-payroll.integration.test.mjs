import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const dockerAvailable = spawnSync('docker', ['image', 'inspect', 'postgres:17-alpine'], { stdio: 'ignore' }).status === 0

function psql(container, sql) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function startPsql(container, sql) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  let exitCode = null
  let exitSignal = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error += chunk })
  child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal })
  child.stdin.end(sql)
  return { child, get output() { return output }, get error() { return error }, get exitCode() { return exitCode }, get exitSignal() { return exitSignal } }
}

function waitForMarker(session, marker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PostgreSQL session did not reach marker ${marker}. Output: ${session.output} ${session.error}`)), 10000)
    const check = () => {
      if (session.output.includes(marker)) {
        clearTimeout(timer)
        resolve()
      }
    }
    session.child.stdout.on('data', check)
    session.child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`PostgreSQL session exited ${code}: ${session.output} ${session.error}`))
    })
    check()
  })
}

function waitForExit(session) {
  if (session.exitCode !== null) return session.exitCode === 0
    ? Promise.resolve(session.output)
    : Promise.reject(new Error(`PostgreSQL session exited ${session.exitCode}: ${session.output} ${session.error}`))
  return new Promise((resolve, reject) => {
    session.child.once('exit', code => code === 0
      ? resolve(session.output)
      : reject(new Error(`PostgreSQL session exited ${code}: ${session.output} ${session.error}`)))
  })
}

function waitForFailure(session) {
  if (session.exitCode !== null) return session.exitCode !== 0
    ? Promise.resolve(`${session.output}\n${session.error}`)
    : Promise.reject(new Error(`PostgreSQL session unexpectedly succeeded: ${session.output}`))
  return new Promise((resolve, reject) => {
    session.child.once('exit', code => code !== 0
      ? resolve(`${session.output}\n${session.error}`)
      : reject(new Error(`PostgreSQL session unexpectedly succeeded: ${session.output}`)))
  })
}

async function waitForActivity(container, query, description) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (Number(psql(container, query).trim()) > 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`PostgreSQL did not reach ${description}`)
}

test('conversion payroll guards and real concurrent PostgreSQL lock orders', { skip: !dockerAvailable, timeout: 120000 }, async t => {
  const container = `slcs-conversion-payroll-${process.pid}-${Date.now()}`
  const setup = await read('tests/fixtures/schedule-conversion-payroll-setup.sql')
  const scheduleSave = await read('supabase/migrations/20260810140000_enable_audited_historical_schedule_corrections.sql')
  const scheduleVersioningSource = await read('supabase/migrations/20260727110318_extend_payroll_reconciliation_tables.sql')
  const versionStart = scheduleVersioningSource.indexOf('create or replace function public.workforce_increment_schedule_version()')
  const versionEnd = scheduleVersioningSource.indexOf('-- Payroll calculation must distinguish', versionStart)
  assert.ok(versionStart >= 0 && versionEnd > versionStart, 'actual schedule version trigger source exists')
  const scheduleVersioning = scheduleVersioningSource.slice(versionStart, versionEnd)
  const migration = await read('supabase/migrations/20261010150523_add_rest_day_regular_shift_request_types.sql')
  const adminAuthorizationMigration = await read('supabase/migrations/20261014160000_pr68_admin_schedule_conversion_requests.sql')
  const behavior = await read('tests/fixtures/schedule-conversion-payroll-check.sql')
  const adminBehavior = await read('tests/fixtures/schedule-conversion-admin-check.sql')

  try {
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'], { stdio: 'ignore' })
    let ready = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-c', 'select 1'], { stdio: 'ignore' })
      if (result.status === 0) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(ready, 'disposable PostgreSQL container became ready')
    psql(container, `${setup}\n${scheduleVersioning}\n${scheduleSave}\n${migration}`)
    psql(container, `create schema pr68_test;
      create table pr68_test.conversion_function_security as
      select p.proacl,p.prosecdef,p.proconfig,pg_get_function_identity_arguments(p.oid) identity_args
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='workforce_submit_schedule_conversion_request';`)
    psql(container, adminAuthorizationMigration)
    // The guard is safe to re-encounter when Production already has the patch.
    psql(container, adminAuthorizationMigration)
    psql(container, `do $$ begin
      if exists (
        select 1 from pr68_test.conversion_function_security original
        join pg_proc p on pg_get_function_identity_arguments(p.oid)=original.identity_args
        join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
        where p.proname='workforce_submit_schedule_conversion_request'
          and (p.proacl is distinct from original.proacl
            or p.prosecdef is distinct from original.prosecdef
            or p.proconfig is distinct from original.proconfig)
      ) then raise exception 'Migration changed conversion RPC ACL or security settings'; end if;
    end $$;`)
    assert.match(psql(container, behavior), /schedule conversion behavior checks passed/)
    assert.match(psql(container, adminBehavior), /admin schedule conversion checks passed/)

    psql(container, `
      create schema test;
      create function test.seed_conversion(p_id uuid, p_date date, p_rest boolean)
      returns uuid language plpgsql as $$ declare result_id uuid; begin
        perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
        perform set_config('test.is_agent','true',false);
        perform set_config('test.is_admin','false',false);
        perform set_config('test.can_manage','true',false);
        insert into public.work_schedules(id,user_id,shift_date,shift_start,shift_end,timezone,status,is_rest_day)
        values(p_id,'11111111-1111-1111-1111-111111111111',p_date,
          case when p_rest then null else p_date::timestamptz + interval '09 hours' end,
          case when p_rest then null else p_date::timestamptz + interval '17 hours' end,
          'America/New_York','published',p_rest);
        select id into result_id from public.workforce_submit_schedule_conversion_request(
          case when p_rest then 'regular_shift' else 'rest_day' end,p_date,p_id,
          case when p_rest then p_date::timestamptz + interval '09 hours' else null end,
          case when p_rest then p_date::timestamptz + interval '17 hours' else null end,'payroll guard test');
        return result_id;
      end $$;
      create function test.assert_conversion_blocked(p_request_id uuid)
      returns void language plpgsql as $$ declare r public.leave_requests%rowtype; s public.work_schedules%rowtype; old_version bigint; begin
        select * into r from public.leave_requests where id=p_request_id;
        select * into s from public.work_schedules where id=r.target_schedule_id;
        old_version := s.schedule_version;
        begin
          perform public.workforce_apply_schedule_conversion_request(p_request_id,null);
          raise exception 'TEST_UNEXPECTED_SUCCESS';
        exception when others then
          if sqlerrm='TEST_UNEXPECTED_SUCCESS' then raise; end if;
        end;
        select * into r from public.leave_requests where id=p_request_id;
        select * into s from public.work_schedules where id=r.target_schedule_id;
        if r.status <> 'pending' or s.schedule_version <> old_version then
          raise exception 'Rejected payroll approval partially changed request or schedule';
        end if;
      end $$;
      select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
      select set_config('test.is_agent','true',false);
      select set_config('test.is_admin','true',false);
      select set_config('test.can_manage','true',false);
    `)

    const guardCases = [
      { name: 'Payroll V2 approved period', date: '2026-11-10', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb001', period: 'cccccccc-cccc-cccc-cccc-cccccccc0001', record: 'dddddddd-dddd-dddd-dddd-dddddddd0001', state: 'approved' },
      { name: 'Payroll V2 finalized period', date: '2026-11-11', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb002', period: 'cccccccc-cccc-cccc-cccc-cccccccc0002', record: 'dddddddd-dddd-dddd-dddd-dddddddd0002', state: 'finalized' },
      { name: 'Payroll V2 closed period', date: '2026-11-12', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb003', period: 'cccccccc-cccc-cccc-cccc-cccccccc0003', record: 'dddddddd-dddd-dddd-dddd-dddddddd0003', state: 'closed' }
    ]
    for (const item of guardCases) {
      psql(container, `insert into public.payroll_v2_periods values('${item.period}','${item.date}','${item.date}','${item.state}');
        insert into public.payroll_v2_records values('${item.record}','${item.period}','11111111-1111-1111-1111-111111111111','${item.state === 'closed' ? 'finalized' : item.state}');
        select test.assert_conversion_blocked(test.seed_conversion('${item.schedule}','${item.date}',false));`)
      t.diagnostic(`${item.name} was blocked transactionally`)
    }

    for (const [date, schedule, period, record, snapshotKind] of [
      ['2026-11-13','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb004','cccccccc-cccc-cccc-cccc-cccccccc0004','dddddddd-dddd-dddd-dddd-dddddddd0004','attendance'],
      ['2026-11-14','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb005','cccccccc-cccc-cccc-cccc-cccccccc0005','dddddddd-dddd-dddd-dddd-dddddddd0005','committed']
    ]) {
      psql(container, `insert into public.payroll_v2_periods values('${period}','${date}','${date}','draft') on conflict do nothing;
        insert into public.payroll_v2_records values('${record}','${period}','11111111-1111-1111-1111-111111111111','calculated') on conflict do nothing;
        do $$ declare request_id uuid; begin
          request_id := test.seed_conversion('${schedule}','${date}',false);
          ${snapshotKind === 'attendance'
            ? `insert into public.payroll_v2_attendance_snapshots(payroll_v2_record_id,work_date,source_schedule_ids) values('${record}','${date}',array['${schedule}'::uuid]);`
            : `insert into public.payroll_v2_committed_hours_snapshots(payroll_v2_record_id,work_date) values('${record}','${date}');`}
          perform test.assert_conversion_blocked(request_id);
        end $$;`)
      t.diagnostic(`non-void Payroll V2 ${snapshotKind} snapshot blocked conversion`)
    }

    psql(container, `insert into public.payroll_periods(id,period_start,period_end,status) values('eeeeeeee-eeee-eeee-eeee-eeeeeeee0001','2026-11-15','2026-11-15','review');
      insert into public.payroll_records(id,payroll_period_id,employee_id,status) values('ffffffff-ffff-ffff-ffff-ffffffff0001','eeeeeeee-eeee-eeee-eeee-eeeeeeee0001','11111111-1111-1111-1111-111111111111','approved');
      do $$ declare request_id uuid; begin
        request_id := test.seed_conversion('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb006','2026-11-15',false);
        update public.payroll_periods set status='finalized' where id='eeeeeeee-eeee-eeee-eeee-eeeeeeee0001';
        update public.payroll_records set status='finalized' where id='ffffffff-ffff-ffff-ffff-ffffffff0001';
        perform test.assert_conversion_blocked(request_id);
      end $$;`)

    psql(container, `insert into public.payroll_records(id,employee_id,status) values('ffffffff-ffff-ffff-ffff-ffffffff0002','11111111-1111-1111-1111-111111111111','approved');
      insert into public.payroll_prepaid_commitments(id,employee_id,work_date,superseded_at,payroll_record_id)
        values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0016','11111111-1111-1111-1111-111111111111','2026-11-16',null,'ffffffff-ffff-ffff-ffff-ffffffff0002');
      insert into public.payroll_items(payroll_record_id,metadata)
        values('ffffffff-ffff-ffff-ffff-ffffffff0002','{"commitment_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0016"}');
      select test.assert_conversion_blocked(test.seed_conversion('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb017','2026-11-16',false));`)

    // Recheck the active-schedule invariant at approval, using the real
    // schedule-save RPC to add a different sequence after request submission.
    psql(container, `do $$ declare request_id uuid; begin
        request_id := test.seed_conversion('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb018','2026-11-20',false);
        perform set_config('test.is_admin','true',false);
        perform public.workforce_admin_save_schedule(null,'11111111-1111-1111-1111-111111111111','2026-11-20',2,
          '2026-11-20 18:00+00','2026-11-20 22:00+00','America/New_York','published',false,false,null,'second active schedule');
        perform test.assert_conversion_blocked(request_id);
      end $$;
      do $$ begin
        if (select count(*) from public.work_schedules where user_id='11111111-1111-1111-1111-111111111111' and shift_date='2026-11-20' and status in ('published','changed','scheduled')) <> 2 then
          raise exception 'The actual schedule-save RPC did not create the second active schedule';
        end if;
      end $$;`)
    t.diagnostic('approval rejected a second active schedule created after submission through workforce_admin_save_schedule')

    psql(container, `do $$ declare request_id uuid; schedule_row public.work_schedules%rowtype; begin
        request_id := test.seed_conversion('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb024','2026-11-23',false);
        perform set_config('test.is_admin','true',false);
        schedule_row := public.workforce_admin_save_schedule(null,'11111111-1111-1111-1111-111111111111','2026-11-23',2,
          '2026-11-23 18:00+00','2026-11-23 22:00+00','America/New_York','cancelled',false,false,null,'synthetic inactive schedule');
        schedule_row := public.workforce_admin_save_schedule(schedule_row.id,'11111111-1111-1111-1111-111111111111','2026-11-23',2,
          '2026-11-23 18:00+00','2026-11-23 22:00+00','America/New_York','published',false,false,null,'synthetic schedule activation');
        perform test.assert_conversion_blocked(request_id);
      end $$;`)
    t.diagnostic('approval rejected an inactive schedule activated after submission through workforce_admin_save_schedule')

    // Test both serial orders between the real creation RPC and approval.
    // Sleep triggers are timing instrumentation; application paths and the
    // migration-installed employee/date lock remain real.
    psql(container, `create function test.pause_schedule_mutation() returns trigger language plpgsql as $$ begin
        perform pg_sleep(1.25); return new; end $$;
      create trigger zz_test_pause_schedule_insert before insert on public.work_schedules
        for each row execute function test.pause_schedule_mutation();
      create trigger zz_test_pause_schedule_update before update on public.work_schedules
        for each row execute function test.pause_schedule_mutation();`)

    const settings = `select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false); select set_config('test.is_admin','true',false); select set_config('test.can_manage','true',false);`
    const createRace = { date: '2026-11-21', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb019' }
    psql(container, `select test.seed_conversion('${createRace.schedule}','${createRace.date}',false);`)
    const creator = startPsql(container, `begin; ${settings}
      select public.workforce_admin_save_schedule(null,'11111111-1111-1111-1111-111111111111','${createRace.date}',2,
        '${createRace.date} 18:00+00','${createRace.date} 22:00+00','America/New_York','published',false,false,null,'concurrent schedule creation');
      commit;`)
    await waitForActivity(container,
      `select count(*) from pg_stat_activity where datname='postgres' and wait_event='PgSleep' and query like '%workforce_admin_save_schedule%' and pid<>pg_backend_pid();`,
      'schedule creation test trigger')
    const createRequest = `(select id from public.leave_requests where start_date='${createRace.date}')`
    const approver = startPsql(container, `begin; ${settings}
      do $$ begin
        begin perform public.workforce_apply_schedule_conversion_request(${createRequest},null); raise exception 'TEST_UNEXPECTED_SUCCESS';
        exception when others then if sqlerrm='TEST_UNEXPECTED_SUCCESS' then raise; end if; end;
      end $$; commit;`)
    await waitForActivity(container,
      `select count(*) from pg_stat_activity where datname='postgres' and wait_event_type='Lock' and query like '%workforce_apply_schedule_conversion_request%' and pid<>pg_backend_pid();`,
      'approval waiting for the schedule-creation date lock')
    await waitForExit(creator)
    await waitForExit(approver)
    psql(container, `select test.assert_conversion_blocked(${createRequest});`)
    assert.equal(Number(psql(container, `select count(*) from public.work_schedules where user_id='11111111-1111-1111-1111-111111111111' and shift_date='${createRace.date}' and status in ('published','changed','scheduled');`).trim()), 2)
    t.diagnostic('creation-first race serialized: approval observed the new schedule and remained pending')

    const approvalRace = { date: '2026-11-22', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb021' }
    psql(container, `select test.seed_conversion('${approvalRace.schedule}','${approvalRace.date}',false);`)
    const approvalRequest = `(select id from public.leave_requests where start_date='${approvalRace.date}')`
    const applying = startPsql(container, `begin; ${settings}
      select public.workforce_apply_schedule_conversion_request(${approvalRequest},null);
      commit;`)
    await waitForActivity(container,
      `select count(*) from pg_stat_activity where datname='postgres' and wait_event='PgSleep' and query like '%workforce_apply_schedule_conversion_request%' and pid<>pg_backend_pid();`,
      'approval test trigger')
    const creatingAfter = startPsql(container, `begin; ${settings}
      select public.workforce_admin_save_schedule(null,'11111111-1111-1111-1111-111111111111','${approvalRace.date}',2,
        '${approvalRace.date} 18:00+00','${approvalRace.date} 22:00+00','America/New_York','published',false,false,null,'concurrent schedule creation');
      commit;`)
    const rejectedInsert = await waitForFailure(creatingAfter)
    assert.match(rejectedInsert, /An active schedule request is being approved for this employee and date/)
    await waitForExit(applying)
    assert.match(psql(container, `select r.status || ':' || s.is_rest_day::text || ':' || (select count(*) from public.work_schedules extra where extra.user_id=r.user_id and extra.shift_date=r.start_date and extra.status in ('published','changed','scheduled'))::text from public.leave_requests r join public.work_schedules s on s.id=r.target_schedule_id where r.start_date='${approvalRace.date}';`), /approved:true:1/)
    t.diagnostic('approval-first race serialized: competing schedule creation failed fast without deadlock')
    psql(container, `drop trigger zz_test_pause_schedule_insert on public.work_schedules; drop trigger zz_test_pause_schedule_update on public.work_schedules; drop function test.pause_schedule_mutation();`)

    // Each race uses real PostgreSQL sessions. The first transaction holds
    // the same parent-period lock used by production payroll lifecycle RPCs.
    const races = [
      { date: '2026-12-01', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb011', period: 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0011', record: 'ffffffff-ffff-ffff-ffff-ffffffff0011', system: 'legacy', order: 'conversion-first', lock: `select id from public.payroll_periods where id='eeeeeeee-eeee-eeee-eeee-eeeeeeee0011' for update; update public.payroll_periods set status='finalized' where id='eeeeeeee-eeee-eeee-eeee-eeeeeeee0011'; update public.payroll_records set status='finalized' where id='ffffffff-ffff-ffff-ffff-ffffffff0011';`, expected: 'approved' },
      { date: '2026-12-02', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb012', period: 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0012', record: 'ffffffff-ffff-ffff-ffff-ffffffff0012', system: 'legacy', order: 'payroll-first', lock: `select id from public.payroll_periods where id='eeeeeeee-eeee-eeee-eeee-eeeeeeee0012' for update; update public.payroll_periods set status='finalized' where id='eeeeeeee-eeee-eeee-eeee-eeeeeeee0012'; update public.payroll_records set status='finalized' where id='ffffffff-ffff-ffff-ffff-ffffffff0012';`, expected: 'pending' },
      { date: '2026-12-05', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb015', period: 'cccccccc-cccc-cccc-cccc-cccccccc0015', record: 'dddddddd-dddd-dddd-dddd-dddddddd0015', system: 'v2-finalize', order: 'conversion-first', lock: `select id from public.payroll_v2_periods where id='cccccccc-cccc-cccc-cccc-cccccccc0015' for update; select id from public.payroll_v2_records where id='dddddddd-dddd-dddd-dddd-dddddddd0015' for update; update public.payroll_v2_records set status='finalized' where id='dddddddd-dddd-dddd-dddd-dddddddd0015';`, expected: 'approved' },
      { date: '2026-12-06', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb016', period: 'cccccccc-cccc-cccc-cccc-cccccccc0016', record: 'dddddddd-dddd-dddd-dddd-dddddddd0016', system: 'v2-finalize', order: 'payroll-first', lock: `select id from public.payroll_v2_periods where id='cccccccc-cccc-cccc-cccc-cccccccc0016' for update; select id from public.payroll_v2_records where id='dddddddd-dddd-dddd-dddd-dddddddd0016' for update; update public.payroll_v2_records set status='finalized' where id='dddddddd-dddd-dddd-dddd-dddddddd0016';`, expected: 'approved' },
      { date: '2026-12-03', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb013', period: 'cccccccc-cccc-cccc-cccc-cccccccc0013', record: 'dddddddd-dddd-dddd-dddd-dddddddd0013', system: 'v2', order: 'conversion-first', lock: `select id from public.payroll_v2_periods where id='cccccccc-cccc-cccc-cccc-cccccccc0013' for update; update public.payroll_v2_periods set status='closed' where id='cccccccc-cccc-cccc-cccc-cccccccc0013';`, expected: 'approved' },
      { date: '2026-12-04', schedule: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb014', period: 'cccccccc-cccc-cccc-cccc-cccccccc0014', record: 'dddddddd-dddd-dddd-dddd-dddddddd0014', system: 'v2', order: 'payroll-first', lock: `select id from public.payroll_v2_periods where id='cccccccc-cccc-cccc-cccc-cccccccc0014' for update; update public.payroll_v2_periods set status='closed' where id='cccccccc-cccc-cccc-cccc-cccccccc0014';`, expected: 'pending' }
    ]

    for (const race of races) {
      const setupSql = `select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false); select set_config('test.is_agent','true',false); select set_config('test.is_admin','false',false); select set_config('test.can_manage','true',false);
        insert into public.work_schedules(id,user_id,shift_date,shift_start,shift_end,timezone,status,is_rest_day) values('${race.schedule}','11111111-1111-1111-1111-111111111111','${race.date}','${race.date} 09:00+00','${race.date} 17:00+00','America/New_York','published',false);
        ${race.system === 'legacy'
          ? `insert into public.payroll_periods(id,period_start,period_end,status) values('${race.period}','${race.date}','${race.date}','review'); insert into public.payroll_records(id,payroll_period_id,employee_id,status) values('${race.record}','${race.period}','22222222-2222-2222-2222-222222222222','approved');`
          : `insert into public.payroll_v2_periods values('${race.period}','${race.date}','${race.date}','${race.system === 'v2-finalize' ? 'draft' : 'review'}'); insert into public.payroll_v2_records values('${race.record}','${race.period}','22222222-2222-2222-2222-222222222222','approved');`}
        select public.workforce_submit_schedule_conversion_request('rest_day','${race.date}','${race.schedule}',null,null,'race test');`
      psql(container, setupSql)
      const request = `(select id from public.leave_requests where start_date='${race.date}')`
      const settings = `select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false); select set_config('test.is_admin','true',false); select set_config('test.can_manage','true',false);`
      let first
      let second
      if (race.order === 'conversion-first') {
        first = startPsql(container, `begin; ${settings} select public.workforce_apply_schedule_conversion_request(${request},null);
\\echo CONVERSION_LOCKED
select pg_sleep(1.2); commit;`)
        await waitForMarker(first, 'CONVERSION_LOCKED')
        second = startPsql(container, `begin; ${race.lock}
\\echo PAYROLL_LOCKED
commit;`)
        await new Promise(resolve => setTimeout(resolve, 150))
        assert.ok(Number(psql(container, `select count(*) from pg_stat_activity where datname='postgres' and wait_event_type='Lock' and pid<>pg_backend_pid();`).trim()) > 0, `${race.system} payroll transaction should wait on conversion's parent-period lock`)
        await waitForExit(first)
        await waitForExit(second)
      } else {
        first = startPsql(container, `begin; ${race.lock}
\\echo PAYROLL_LOCKED
select pg_sleep(1.2); commit;`)
        await waitForMarker(first, 'PAYROLL_LOCKED')
        second = startPsql(container, race.expected === 'pending'
          ? `begin; ${settings} do $$ begin perform public.workforce_apply_schedule_conversion_request(${request},null); raise exception 'TEST_UNEXPECTED_SUCCESS'; exception when others then if sqlerrm='TEST_UNEXPECTED_SUCCESS' then raise; end if; end $$; commit;`
          : `begin; ${settings} select public.workforce_apply_schedule_conversion_request(${request},null); commit;`)
        await new Promise(resolve => setTimeout(resolve, 150))
        assert.ok(Number(psql(container, `select count(*) from pg_stat_activity where datname='postgres' and wait_event_type='Lock' and pid<>pg_backend_pid();`).trim()) > 0, `${race.system} conversion should wait on payroll's parent-period lock`)
        await waitForExit(first)
        await waitForExit(second)
      }
      const state = psql(container, `select r.status || ':' || s.is_rest_day::text from public.leave_requests r join public.work_schedules s on s.id=r.target_schedule_id where r.start_date='${race.date}';`)
      assert.ok(state.includes(`${race.expected}:${race.expected === 'approved' ? 'true' : 'false'}`), `${race.system} ${race.order}: ${state}`)
      t.diagnostic(`${race.system} ${race.order} serialized without partial approval`)
    }
  } finally {
    spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' })
  }
})

test('Open Schedule early clock-in migration executes against PostgreSQL and preserves RPC security', { skip: !dockerAvailable, timeout: 120000 }, async t => {
  const container = `slcs-open-clock-in-${process.pid}-${Date.now()}`
  const migration = await read('supabase/migrations/20261124041634_allow_open_schedule_clock_in_two_hours_early.sql')

  try {
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', 'postgres', '-c', 'wal_level=logical'], { stdio: 'ignore' })
    let ready = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-c', 'select 1'], { stdio: 'ignore' }).status === 0) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(ready, 'disposable PostgreSQL 17 became ready')

    psql(container, `
      create role authenticated;
      create role service_role;
      create publication supabase_realtime;
      create table public.work_schedules (
        id uuid primary key, user_id uuid not null, shift_date date not null,
        shift_start timestamptz, shift_end timestamptz, timezone text not null,
        status text not null, is_rest_day boolean not null default false,
        is_holiday boolean not null default false
      );
      create table public.attendance (
        id uuid primary key default gen_random_uuid(), user_id uuid not null,
        schedule_id uuid, work_date date not null, clock_in timestamptz,
        clock_out timestamptz, voided_at timestamptz
      );
      create table public.test_clock (instant timestamptz not null);
      insert into public.test_clock values ('2026-11-24 02:59:59.999+00');
      create function public.test_clock_now() returns timestamptz language sql stable as
        $$ select instant from public.test_clock limit 1 $$;
      create function public.workforce_clock_in(p_schedule_id uuid default null::uuid)
      returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
      declare
        v_clock_time timestamptz := test_clock_now();
        v_timezone text;
        v_local_date date;
        v_schedule public.work_schedules%rowtype;
        schedule public.work_schedules%rowtype;
        v_profile_user_id uuid := '11111111-1111-1111-1111-111111111111';
        v_existing public.attendance%rowtype;
        v_attendance_id uuid;
      begin
        select ws.* into schedule from public.work_schedules ws where ws.id = p_schedule_id;
        if not found then raise exception 'Schedule not found'; end if;
        v_schedule := schedule;
        v_timezone := v_schedule.timezone;
        v_local_date := (v_clock_time at time zone v_timezone)::date;

        if not (
          schedule.status in ('published', 'changed')
          and (
            not (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_start is not null
            and schedule.shift_date = v_local_date
          )
          or (
            not (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_start is null
            and schedule.shift_end is null
            and schedule.shift_date = v_local_date
          )
        ) then
          raise exception 'Schedule is not eligible';
        end if;

      if v_schedule.shift_date not in (v_local_date - 1, v_local_date) then
        raise exception 'Open Schedule clock-in is available only on yesterday or the scheduled work date.';
      end if;
    if exists (select 1 from public.attendance a where a.user_id = v_profile_user_id and a.clock_out is null and a.voided_at is null) then
          raise exception 'You are already clocked in to another shift.';
        end if;

  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    where a.user_id = v_profile_user_id
      and a.work_date = v_local_date
    order by a.clock_in desc limit 1;
  end if;

        insert into public.attendance(user_id, schedule_id, work_date, clock_in)
        values (v_profile_user_id, p_schedule_id, v_schedule.shift_date, v_clock_time)
        returning id into v_attendance_id;
        return v_attendance_id;
      end;
      $$;
      grant execute on function public.workforce_clock_in(uuid) to authenticated, service_role;
    `)

    const securityBefore = psql(container, `select p.proacl::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
      from pg_proc p where p.oid='public.workforce_clock_in(uuid)'::regprocedure;`).trim()
    const originalGuards = [...migration.matchAll(/\$old\$([\s\S]*?)\$old\$/g)].map(match => match[1].replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, ''))
    const functionDefinition = psql(container, `select pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure);`).replace(/\r/g, '')
    assert.equal(originalGuards.length, 3, 'migration has three expected live RPC anchors')
    for (let index = 0; index < originalGuards.length; index += 1) {
      const anchorBody = originalGuards[index].trim()
      const anchorStart = functionDefinition.indexOf(anchorBody.split('\n')[0].trim())
      const actualAnchor = anchorStart < 0 ? '' : functionDefinition.slice(Math.max(0, anchorStart - 12), anchorStart + anchorBody.length + 20)
      assert.ok(functionDefinition.includes(originalGuards[index]), `PostgreSQL fixture RPC contains migration anchor ${index + 1}; expected=${JSON.stringify(anchorBody)} actual=${JSON.stringify(actualAnchor)}`)
    }
    psql(container, migration)
    const securityAfter = psql(container, `select p.proacl::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
      from pg_proc p where p.oid='public.workforce_clock_in(uuid)'::regprocedure;`).trim()
    assert.equal(securityAfter, securityBefore, 'migration preserves RPC grants, SECURITY DEFINER, and search_path')
    assert.match(psql(container, `select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename='work_schedules';`), /work_schedules/)

    psql(container, `insert into public.work_schedules(id,user_id,shift_date,timezone,status)
      values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','2026-11-24','America/New_York','changed');`)

    const early = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', "select public.workforce_clock_in('22222222-2222-2222-2222-222222222222');"], { encoding: 'utf8' })
    assert.notEqual(early.status, 0, '9:59:59.999 PM workforce time is rejected')
    assert.match(early.stderr, /opens at 10:00 PM|eligible/)

    for (const instant of ['2026-11-24 03:00:00+00', '2026-11-24 04:00:00+00']) {
      psql(container, `delete from public.attendance; update public.test_clock set instant='${instant}';`)
      psql(container, `select public.workforce_clock_in('22222222-2222-2222-2222-222222222222');`)
      const saved = psql(container, `select work_date::text || '|' || clock_in::text from public.attendance;`).trim()
      assert.match(saved, /^2026-11-24\|2026-11-24 0[34]:00:00\+00$/)
    }

    psql(container, `delete from public.attendance; update public.test_clock set instant='2026-11-24 05:00:00+00';`)
    psql(container, `select public.workforce_clock_in('22222222-2222-2222-2222-222222222222');`)
    assert.match(psql(container, `select work_date::text || '|' || clock_in::text from public.attendance;`), /^2026-11-24\|2026-11-24 05:00:00\+00$/m)

    const active = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', "select public.workforce_clock_in('22222222-2222-2222-2222-222222222222');"], { encoding: 'utf8' })
    assert.notEqual(active.status, 0, 'active session prevents a second clock-in')
    assert.match(active.stderr, /already clocked in/)
    psql(container, `update public.attendance set clock_out=clock_in + interval '1 hour';`)
    const duplicate = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', "select public.workforce_clock_in('22222222-2222-2222-2222-222222222222');"], { encoding: 'utf8' })
    assert.notEqual(duplicate.status, 0, 'a second session for the selected Open Schedule is rejected')
    assert.match(duplicate.stderr, /already been recorded/)

    // The fall-back Sunday has two distinct local 1:30 AM instants; both remain on the same selected work date.
    psql(container, `insert into public.work_schedules(id,user_id,shift_date,timezone,status)
      values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','2026-11-01','America/New_York','published');
      delete from public.attendance;
      update public.test_clock set instant='2026-11-01 05:30:00+00';`)
    psql(container, `select public.workforce_clock_in('33333333-3333-3333-3333-333333333333');`)
    assert.match(psql(container, `select work_date::text || '|' || clock_in::text from public.attendance;`), /^2026-11-01\|2026-11-01 05:30:00\+00$/m)
    psql(container, `delete from public.attendance; update public.test_clock set instant='2026-11-01 06:30:00+00';`)
    psql(container, `select public.workforce_clock_in('33333333-3333-3333-3333-333333333333');`)
    assert.match(psql(container, `select work_date::text || '|' || clock_in::text from public.attendance;`), /^2026-11-01\|2026-11-01 06:30:00\+00$/m)
  } finally {
    execFileSync('docker', ['rm', '--force', container], { stdio: 'ignore' })
  }
})
