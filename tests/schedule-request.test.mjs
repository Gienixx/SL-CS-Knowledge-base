import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  canSubmitOwnScheduleRequest,
  filterSchedulesToLinkedProfiles,
  linkedScheduleProfileIds
} from '../shared/schedule-request-capabilities.mjs'

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
  assert.match(page, /id="leaveRequestFormDescription"/)
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

test('Schedule Request uses three role-aware accessible tabs', async () => {
  const [page, script] = await Promise.all([
    read('leave-requests.html'),
    read('scripts/leave-requests.js')
  ])

  assert.match(page, /role="tablist" aria-label="Schedule request sections"/)
  assert.match(page, /id="newScheduleRequestTab"[^>]*>New Schedule Request/)
  assert.match(page, /id="scheduleRequestApprovalTab"[^>]*>Schedule Request Approval Queue/)
  assert.doesNotMatch(page, /id="scheduleRequestApprovalTab"[^>]*hidden/)
  assert.match(page, /id="scheduleRequestHistoryTab"[^>]*>Request History/)
  assert.match(page, /id="newScheduleRequestPanel"[^>]*role="tabpanel"/)
  assert.match(page, /id="scheduleRequestApprovalPanel"[^>]*role="tabpanel"/)
  assert.match(page, /id="scheduleRequestHistoryPanel"[^>]*role="tabpanel"/)
  assert.match(script, /elements\.newRequestTab\.disabled = !canSubmitRequests/)
  assert.match(script, /leaveOption\.hidden = !canSubmitLeaveRequests; leaveOption\.disabled = !canSubmitLeaveRequests/)
  assert.match(script, /if \(!canSubmitLeaveRequests\) elements\.category\.value = 'schedule_change'/)
  assert.match(script, /category === 'leave' && !canSubmitLeaveRequests/)
  assert.match(script, /elements\.approvalTab\.disabled = !isApproverView/)
  assert.match(script, /activateRequestTab\(canSubmitRequests \? 'new' : 'approval'\)/)
  assert.match(script, /canSubmitRequests = canSubmitOwnScheduleRequest\(access\)/)
  assert.match(script, /New requests are available to active agent and admin profiles/)
  assert.match(script, /event\.key === 'ArrowRight'/)
  assert.match(script, /event\.key === 'Home'/)
})

test('active admin-only and dual-role admin-agent accounts can submit their own requests', async () => {
  const script = await read('scripts/leave-requests.js')

  assert.equal(canSubmitOwnScheduleRequest({ allowed: true, is_admin: true, is_agent: false }), true)
  assert.equal(canSubmitOwnScheduleRequest({ allowed: true, is_admin: true, is_agent: true }), true)
  assert.equal(canSubmitOwnScheduleRequest({ allowed: true, is_admin: false, is_agent: true }), true)
  assert.equal(canSubmitOwnScheduleRequest({ allowed: false, is_admin: true, is_agent: true }), false)

  assert.match(script, /isApproverView = access\.is_admin === true && \(hasWorkforcePermission\(access, 'approve_leave'\) \|\| access\.can_manage_schedules\)/)
  assert.match(script, /elements\.submissionSection\.hidden = !canSubmitRequests; elements\.approvalSection\.hidden = !isApproverView/)
  assert.match(script, /canSubmitRequests = canSubmitOwnScheduleRequest\(access\)/)
  assert.match(script, /canSubmitLeaveRequests = access\.is_agent === true/)
  assert.match(script, /if \(!canSubmitLeaveRequests\) elements\.category\.value = 'schedule_change'/)
  assert.match(script, /workforce_submit_schedule_request/)
  assert.match(script, /open_schedule/)
  assert.match(script, /slide_shift/)
})

test('self-service selector and date-conversion candidates are limited to linked profiles', async () => {
  const script = await read('scripts/leave-requests.js')
  const access = {
    allowed: true,
    is_admin: true,
    is_agent: false,
    linked_profile_ids: ['employee-a', 'employee-b', 'employee-a', '', null]
  }
  const profileIds = linkedScheduleProfileIds(access)
  const schedules = [
    { id: 'own-rest', user_id: 'employee-a', shift_date: '2026-10-30', is_rest_day: true, status: 'published' },
    { id: 'linked-shift', user_id: 'employee-b', shift_date: '2026-10-30', is_rest_day: false, status: 'published' },
    { id: 'coworker-shift', user_id: 'coworker', shift_date: '2026-10-30', is_rest_day: false, status: 'published' }
  ]
  const ownSchedules = filterSchedulesToLinkedProfiles(schedules, profileIds)

  assert.deepEqual(profileIds, ['employee-a', 'employee-b'])
  assert.deepEqual(ownSchedules.map(schedule => schedule.id), ['own-rest', 'linked-shift'])
  assert.deepEqual(filterSchedulesToLinkedProfiles(schedules, []), [])
  assert.deepEqual(linkedScheduleProfileIds({ ...access, allowed: false }), [])
  assert.match(script, /linkedScheduleProfileIds\(access\)/)
  assert.match(script, /\.in\('user_id', profileIds\)/)
  assert.match(script, /schedules = filterSchedulesToLinkedProfiles\(data \|\| \[\], profileIds\)/)
  assert.match(script, /const activeForDate = schedules\.filter/)
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

test('admin self-submission preserves the active-user and own-profile backend checks', async () => {
  const [migration, baseline] = await Promise.all([
    read('supabase/migrations/20261014120000_payroll_v2_leave_and_shortfall_void.sql'),
    read('supabase/migrations/20260817125628_unified_schedule_requests.sql')
  ])
  assert.match(migration, /v_old_guard constant text[\s\S]*?workforce_current_user_is_agent\(\) then/)
  assert.match(migration, /v_new_guard constant text[\s\S]*?workforce_current_user_is_agent\(\) or public\.workforce_is_admin\(\)/)
  assert.match(migration, /If Production already has the approved admin gate, leave it untouched/i)
  assert.match(migration, /pg_get_functiondef\(v_function_oid\)/)
  assert.doesNotMatch(migration, /workforce_submit_leave_request/)
  assert.match(baseline, /v_user_id uuid := public\.workforce_current_profile_id\(\)/)
  assert.match(baseline, /auth\.uid\(\) is null[\s\S]*?v_user_id is null[\s\S]*?not public\.workforce_current_user_is_active\(\)/)
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
