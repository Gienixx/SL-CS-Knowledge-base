import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
        select * into schedule from public.work_schedules schedule where schedule.id = p_schedule_id;
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

        if v_schedule.shift_start is null and v_schedule.shift_end is null
           and v_schedule.shift_date not in (v_local_date - 1, v_local_date) then
          raise exception 'Open Schedule clock-in is available only on yesterday or the scheduled work date.';
        end if;

        if exists (select 1 from public.attendance a where a.user_id = v_profile_user_id and a.clock_out is null and a.voided_at is null) then
          raise exception 'You are already clocked in to another shift.';
        end if;

        if p_schedule_id is null then
          select * into v_existing from public.attendance a
          where a.user_id = v_profile_user_id and a.work_date = v_local_date
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
