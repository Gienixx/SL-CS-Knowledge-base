import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home and agent UI expose the unified Schedule Request workflow', async () => {
  const [home, page, script] = await Promise.all([
    read('home.html'),
    read('leave-requests.html'),
    read('scripts/leave-requests.js')
  ])

  assert.match(home, />Schedule Request</)
  assert.match(page, /Schedule Requests/)
  assert.match(page, /value="leave"/)
  assert.match(page, /value="schedule_change"/)
  assert.match(page, /Incentive Leave.*Incentive VL/)
  assert.match(page, /Birthday Leave.*Birthday VL/)
  assert.match(page, /Leave Without Pay/)
  assert.match(page, /Explain why you are requesting this change/)
  assert.doesNotMatch(page, /Explain why you are requesting leave/)
  assert.doesNotMatch(page, /Loading leave requests\.\.\./)
  assert.match(script, /open_schedule/)
  assert.match(script, /slide_shift/)
  assert.match(page, /type="datetime-local"/)
  assert.match(script, /workforce_submit_leave_request/)
  assert.match(script, /workforce_submit_schedule_request/)
  assert.match(script, /workforce_review_leave_request/)
  assert.match(script, /workforce_review_schedule_request/)
  assert.match(script, /target_schedule:work_schedules!leave_requests_target_schedule_id_fkey/)
  assert.match(script, /The agent will see this exact reason/)
  assert.doesNotMatch(script, /\.from\('leave_requests'\)[\s\S]*?\.insert/)
})

test('production-forward request migration reuses the leave ledger and canonical schedules', async () => {
  const migration = await read('supabase/migrations/20260817125628_unified_schedule_requests.sql')

  assert.match(migration, /add column if not exists request_category/)
  assert.match(migration, /add column if not exists request_type/)
  assert.match(migration, /add column if not exists target_schedule_id/)
  assert.match(migration, /requested_shift_start timestamptz/)
  assert.match(migration, /requested_planned_paid_minutes integer/)
  assert.match(migration, /references public\.work_schedules\(id\)/)
  assert.match(migration, /request_category = 'schedule_change'/)
  assert.match(migration, /request_type in \('open_schedule', 'slide_shift'\)/)
  assert.match(migration, /workforce_submit_schedule_request/)
  assert.match(migration, /workforce_review_schedule_request/)
  assert.match(migration, /workforce_admin_save_open_schedule/)
  assert.match(migration, /workforce_admin_save_schedule\(/)
  assert.match(migration, /workforce_sync_approved_leave_schedules/)
  assert.match(migration, /coalesce\(new\.request_category, 'leave'\) <> 'leave'/)
  assert.match(migration, /v_schedule_count integer/)
  assert.match(migration, /leave_schedules_linked/)
})

test('schedule request approval is atomic, scoped, auditable, and payroll-safe', async () => {
  const migration = await read('supabase/migrations/20260817125628_unified_schedule_requests.sql')

  assert.match(migration, /security definer/)
  assert.match(migration, /workforce_current_profile_id\(\)/)
  assert.match(migration, /workforce_can_manage_user\(v_request\.user_id, 'approve_leave'\)/)
  assert.match(migration, /workforce_can_manage_user\(v_request\.user_id, 'manage_schedules'\)/)
  assert.match(migration, /for update/)
  assert.match(migration, /Attendance already exists for this work date/)
  assert.match(migration, /period\.status = 'finalized'/)
  assert.match(migration, /record\.status = 'finalized'/)
  assert.match(migration, /schedule_request_denied/)
  assert.match(migration, /schedule_request_approved/)
  assert.match(migration, /set status = 'approved'/)
  assert.match(migration, /set status = 'rejected'/)
  assert.match(migration, /A denial reason is required/)
  assert.match(migration, /revoke all on function public\.workforce_submit_schedule_request/)
  assert.match(migration, /grant execute on function public\.workforce_review_schedule_request/)
})

test('request feature leaves Attendance and payroll data paths untouched', async () => {
  const migration = await read('supabase/migrations/20260817125628_unified_schedule_requests.sql')

  assert.doesNotMatch(migration, /insert into public\.attendance/)
  assert.doesNotMatch(migration, /update public\.attendance/)
  assert.doesNotMatch(migration, /delete from public\.attendance/)
  assert.doesNotMatch(migration, /update public\.payroll_records/)
  assert.match(migration, /voided_at is null/)
  assert.match(migration, /attendance_row\.voided_at is null/)
})
