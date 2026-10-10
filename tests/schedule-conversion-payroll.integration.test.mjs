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

test('conversion payroll guards and real concurrent PostgreSQL lock orders', { skip: !dockerAvailable, timeout: 120000 }, async t => {
  const container = `slcs-conversion-payroll-${process.pid}-${Date.now()}`
  const setup = await read('tests/fixtures/schedule-conversion-payroll-setup.sql')
  const scheduleSave = await read('supabase/migrations/20260810140000_enable_audited_historical_schedule_corrections.sql')
  const scheduleVersioningSource = await read('supabase/migrations/20260727110318_extend_payroll_reconciliation_tables.sql')
  const versionStart = scheduleVersioningSource.indexOf('create or replace function public.workforce_increment_schedule_version()')
  const versionEnd = scheduleVersioningSource.indexOf('-- Payroll calculation must distinguish', versionStart)
  assert.ok(versionStart >= 0 && versionEnd > versionStart, 'actual schedule version trigger source exists')
  const scheduleVersioning = scheduleVersioningSource.slice(versionStart, versionEnd)
  const migration = await read('supabase/migrations/20261009173417_add_rest_day_regular_shift_request_types.sql')
  const behavior = await read('tests/fixtures/schedule-conversion-payroll-check.sql')

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
    assert.match(psql(container, behavior), /schedule conversion behavior checks passed/)

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
