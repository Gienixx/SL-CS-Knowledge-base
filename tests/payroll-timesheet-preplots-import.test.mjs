import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath =
  'supabase/migrations/20260728092027_import_july_prepaid_schedules.sql'
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('controlled timesheet import contains exactly the 59 validated July rows', async () => {
  const migration = await read(migrationPath)
  const sourceRows = migration.match(
    /\('[A-Z]+', \d+, '[^']+@eurekasurveys\.com', '2026-07-\d{2}', '[^']+', '\d{2}:\d{2}', '\d{2}:\d{2}', 'pre plotted'\)/g
  )

  assert.equal(sourceRows?.length, 59)
  assert.match(migration, /if v_input_count <> 59/)
  assert.doesNotMatch(sourceRows.join('\n'), /'OFF'/)
  assert.doesNotMatch(sourceRows.join('\n'), /RDOT/i)
})

test('import resolves live identities and records without generated IDs', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /lower\(profile\.email\) = lower\(source\.employee_email\)/
  )
  assert.match(
    migration,
    /schedule\.shift_date = source\.work_date/
  )
  assert.match(
    migration,
    /source\.work_date between period\.period_start and period\.period_end/
  )
  assert.match(
    migration,
    /record\.payroll_period_id = period\.id[\s\S]*?record\.employee_id = profile\.user_id/
  )
  assert.match(
    migration,
    /where profile\.is_system_admin[\s\S]*?profile\.employment_status = 'active'/
  )
  assert.doesNotMatch(
    migration,
    /'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'/i
  )
})

test('Excel provenance is immutable, deduplicated, and auditable', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /add column source_type text not null default 'website_schedule'/)
  assert.match(migration, /source_type in \('website_schedule', 'excel_import'\)/)
  assert.match(
    migration,
    /create unique index payroll_schedule_snapshots_source_reference_key/
  )
  assert.match(migration, /'2026 Support Timesheet\.xlsx\|' \|\|/)
  assert.match(migration, /'payroll_excel_preplots_imported'/)
  assert.match(migration, /'excluded_historical_rows_without_payroll_periods', 283/)
  assert.match(migration, /'excluded_july_off_rows', 16/)
  assert.match(migration, /'excluded_july_mixed_rdot_rows', 1/)
})

test('existing ordinary attendance is backfilled using FIFO eligible minutes', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /snapshot\.special_day_type = 'ordinary'[\s\S]*?not snapshot\.is_rest_day[\s\S]*?not snapshot\.is_holiday/
  )
  assert.match(
    migration,
    /'regular'::text, v_attendance_snapshot\.regular_minutes[\s\S]*?'pre_shift_overtime'::text[\s\S]*?'post_shift_overtime'::text/
  )
  assert.match(
    migration,
    /source_snapshot\.source_type = 'excel_import'[\s\S]*?source_snapshot\.work_date <= v_attendance_snapshot\.work_date/
  )
  assert.match(
    migration,
    /order by\s*source_snapshot\.work_date,\s*prepaid\.created_at,\s*prepaid\.id/
  )
  assert.match(
    migration,
    /settled_minutes = settled_minutes \+ v_allocated_minutes/
  )
})

test('the import creates schedule snapshots, not fake attendance', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /insert into public\.payroll_schedule_snapshots/)
  assert.doesNotMatch(migration, /insert into public\.attendance\s*\(/)
})
