import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260817063458_attendance_open_session_over_duration_review_production_forward.sql', import.meta.url),
  'utf8'
)

const liveTeamAttendanceColumns = [
  'attendance_id uuid', 'employee_user_id uuid', 'employee_name text',
  'employee_email text', 'employee_id text', 'employee_timezone text',
  'team_id uuid', 'team_name text', 'work_date date', 'schedule_id uuid',
  'shift_sequence smallint', 'scheduled_start timestamptz', 'scheduled_end timestamptz',
  'schedule_timezone text', 'schedule_status text', 'clock_in timestamptz',
  'clock_out timestamptz', 'original_clock_in timestamptz',
  'original_clock_out timestamptz', 'billed_clock_in timestamptz',
  'billed_clock_out timestamptz', 'regular_minutes integer',
  'pre_shift_overtime_minutes integer', 'post_shift_overtime_minutes integer',
  'total_overtime_minutes integer', 'total_worked_minutes integer',
  'minutes_late integer', 'undertime_minutes integer', 'attendance_status text',
  'is_corrected boolean', 'review_status text', 'corrected_by uuid',
  'corrected_by_name text', 'corrected_at timestamptz', 'correction_reason text',
  'admin_notes text', 'is_open boolean', 'is_missing_clock_out boolean'
]

test('production-forward migration targets the live Team Attendance RPC shape', () => {
  assert.match(migration, /drop function if exists public\.workforce_list_team_attendance\(date, date\)/)
  for (const column of liveTeamAttendanceColumns) {
    assert.match(migration, new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(migration, /manager_review_reason text/)
  assert.match(migration, /v_now timestamptz := statement_timestamp\(\)/)
  assert.match(migration, /manager_review_reason = 'open_session_over_20_hours'/)
  assert.match(migration, /language plpgsql\s+stable\s+security definer/)
  assert.match(migration, /Returns the same date-range attendance rows to administrators and active agents/)
  assert.match(migration, /alter function public\.workforce_list_team_attendance\(date, date\) owner to postgres/)
})

test('production-forward migration preserves existing Attendance RPCs and adds only the new flag RPC', () => {
  assert.doesNotMatch(migration, /create or replace function public\.workforce_clock_in\(/)
  assert.doesNotMatch(migration, /create or replace function public\.workforce_clock_out\(/)
  assert.doesNotMatch(migration, /create or replace function public\.workforce_recalculate_attendance\(/)
  assert.doesNotMatch(migration, /create or replace function public\.workforce_review_attendance\(/)
  assert.match(migration, /create or replace function public\.workforce_flag_current_open_attendance_over_duration\(\)/)
  assert.match(migration, /create or replace function public\.workforce_flag_open_attendance_over_duration\(\)/)
  assert.match(migration, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(migration, /returns integer[\s\S]*?get diagnostics v_flagged_count = row_count/)
  assert.match(migration, /create or replace function public\.payroll_flag_changed_attendance\(\)/)
})

test('manager sweep is permission-gated and cannot target arbitrary attendance ids', () => {
  const managerFunction = migration.match(/create or replace function public\.workforce_flag_open_attendance_over_duration\(\)[\s\S]*?end;\r?\n\$\$/)?.[0]

  assert.ok(managerFunction)
  assert.match(managerFunction, /auth\.uid\(\) is null/)
  assert.match(managerFunction, /workforce_current_user_is_active\(\)/)
  assert.match(managerFunction, /workforce_is_admin\(\)/)
  assert.match(managerFunction, /workforce_has_permission\('view_team_attendance'\)/)
  assert.doesNotMatch(managerFunction, /p_attendance_id|uuid\)/)
  assert.match(managerFunction, /clock_out is null/)
  assert.match(managerFunction, /manager_review_reason is null/)
  assert.match(managerFunction, /clock_in < v_now - interval '20 hours'/)
})

test('production-forward migration keeps strict boundary, idempotency, and payroll neutrality', () => {
  assert.match(migration, /clock_in < v_now - interval '20 hours'/)
  assert.match(migration, /manager_review_reason is null/)
  assert.match(migration, /to_jsonb\(new\) - array\['manager_review_reason', 'attendance_version', 'updated_at'\]/)
  assert.doesNotMatch(migration, /manager_review_reason[\s\S]{0,300}clock_out\s*=/)
  const teamFunction = migration.slice(migration.indexOf('create function public.workforce_list_team_attendance'))
  assert.doesNotMatch(teamFunction, /update public\.attendance/)
})
