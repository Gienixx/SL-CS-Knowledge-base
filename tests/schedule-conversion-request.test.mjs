import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

async function readConversionMigration() {
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url))
  const matches = files.filter(file => /^\d+_add_rest_day_regular_shift_request_types\.sql$/.test(file))
  assert.equal(matches.length, 1, 'expected exactly one schedule-conversion migration')
  return read(`supabase/migrations/${matches[0]}`)
}

test('Schedule Request exposes date conversion types and conditional time fields', async () => {
  const [page, script] = await Promise.all([
    read('leave-requests.html'),
    read('scripts/leave-requests.js')
  ])

  assert.match(script, /\['rest_day', 'Rest Day'\]/)
  assert.match(script, /\['regular_shift', 'Regular Shift'\]/)
  assert.match(script, /const needsShiftTimes = isSlide \|\| isRegularShift/)
  assert.match(script, /elements\.shiftStart\.required = needsShiftTimes/)
  assert.match(script, /dateConversionCandidates\(type, startDate\)/)
  assert.match(script, /workforce_submit_schedule_conversion_request/)
  assert.match(script, /workforce_apply_schedule_conversion_request/)
  assert.match(page, /id="leaveRequestCurrentSchedule"/)
  assert.match(page, /id="leaveRequestSchedulePreview"/)
  assert.match(page, /overnight shift/i)
  assert.match(script, /Regular Shift \(\$\{original\}\) → Rest Day/)
  assert.match(script, /Rest Day → Regular Shift/)
})

test('conversion submission reuses the request ledger and captures a locked source snapshot', async () => {
  const migration = await readConversionMigration()

  assert.match(migration, /insert into public\.leave_requests/)
  assert.match(migration, /request_category, request_type, target_schedule_id/)
  assert.match(migration, /target_schedule_version, target_schedule_updated_at/)
  assert.match(migration, /original_shift_start, original_shift_end/)
  assert.match(migration, /original_planned_paid_minutes, original_schedule_status/)
  assert.match(migration, /where id = p_target_schedule_id[\s\S]*?for update/)
  assert.match(migration, /status not in \('published', 'changed'\)/)
  assert.match(migration, /v_type = 'rest_day'[\s\S]*?v_target\.is_rest_day[\s\S]*?shift_start is null/)
  assert.match(migration, /not v_target\.is_rest_day[\s\S]*?shift_start is not null/)
  assert.match(migration, /pending schedule-change request already exists|A pending schedule change conflicts/i)
  assert.doesNotMatch(migration, /update public\.work_schedules[\s\S]*?create or replace function public\.workforce_apply_schedule_conversion_request/)
})

test('conversion approval revalidates, blocks protected dates, and uses Schedule Management audit', async () => {
  const migration = await readConversionMigration()

  assert.match(migration, /v_target\.schedule_version is distinct from v_request\.target_schedule_version/)
  assert.match(migration, /v_target\.updated_at is distinct from v_request\.target_schedule_updated_at/)
  assert.match(migration, /v_target\.shift_start is distinct from v_request\.original_shift_start/)
  assert.match(migration, /attendance_row\.voided_at is null/)
  assert.match(migration, /attendance_row\.payroll_approved_at is not null/)
  assert.match(migration, /period_row\.status = 'finalized' or record_row\.status = 'finalized'/)
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*?v_request\.user_id::text \|\| ':' \|\| v_request\.start_date::text/)
  assert.match(migration, /public\.payroll_periods period_row[\s\S]*?order by period_row\.id[\s\S]*?for share/)
  assert.match(migration, /public\.payroll_v2_periods period_row[\s\S]*?for share/)
  assert.match(migration, /work_schedule_template_assignments[\s\S]*?work_schedule_templates[\s\S]*?public\.payroll_periods period_row/)
  assert.doesNotMatch(migration, /for share of record_row/)
  assert.match(migration, /period_row\.status in \('approved', 'finalized', 'closed'\)/)
  assert.match(migration, /record_row\.status in \('approved', 'finalized'\)/)
  assert.match(migration, /public\.payroll_v2_attendance_snapshots/)
  assert.match(migration, /public\.payroll_v2_committed_hours_snapshots/)
  assert.match(migration, /public\.payroll_prepaid_commitments commitment/)
  assert.match(migration, /request_row\.status in \('pending', 'approved'\)/)
  assert.match(migration, /public\.workforce_admin_save_schedule\(/)
  assert.match(migration, /'schedule_request_approved'/)
  assert.match(migration, /'original_schedule', to_jsonb\(v_target\)/)
  assert.match(migration, /'resulting_schedule', to_jsonb\(v_saved\)/)
  assert.match(migration, /revoke all on function public\.workforce_apply_schedule_conversion_request/)
  assert.match(migration, /grant execute on function public\.workforce_apply_schedule_conversion_request[\s\S]*?to authenticated/)
})

test('PostgreSQL integration covers payroll lifecycle guards and real row-lock races', async () => {
  const integration = await read('tests/schedule-conversion-payroll.integration.test.mjs')
  const fixture = await read('tests/fixtures/schedule-conversion-payroll-setup.sql')

  assert.match(integration, /pg_stat_activity[\s\S]*wait_event_type='Lock'/)
  assert.match(integration, /payroll-first/)
  assert.match(integration, /conversion-first/)
  assert.match(integration, /Payroll V2 approved period/)
  assert.match(integration, /snapshotKind === 'attendance'/)
  assert.match(integration, /'2026-11-14'[\s\S]*?'committed'/)
  assert.match(fixture, /payroll_v2_attendance_snapshots/)
  assert.match(fixture, /payroll_v2_committed_hours_snapshots/)
})

test('existing denial, cancellation, and recurring Rest Day Change paths remain in use', async () => {
  const [migration, script] = await Promise.all([
    readConversionMigration(),
    read('scripts/leave-requests.js')
  ])

  assert.doesNotMatch(migration, /create or replace function public\.workforce_review_schedule_request\(/)
  assert.doesNotMatch(migration, /create or replace function public\.workforce_cancel_leave_request\(/)
  assert.doesNotMatch(migration, /create or replace function public\.workforce_submit_rest_day_change_request\(/)
  assert.match(script, /workforce_cancel_leave_request/)
  assert.match(script, /status === 'approved'[\s\S]*workforce_apply_schedule_conversion_request/)
  assert.match(script, /workforce_review_schedule_request/)
  assert.match(migration, /request_type = 'rest_day_change'[\s\S]*current_rest_weekdays/)
})
