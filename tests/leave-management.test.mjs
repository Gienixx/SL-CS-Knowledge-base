import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations/20260804161321_integrate_leave_request_approvals_with_schedules.sql', import.meta.url)
const verificationUrl = new URL('../supabase/verification/leave_management_check.sql', import.meta.url)
const transactionVerificationUrl = new URL('../supabase/verification/leave_management_transaction_check.sql', import.meta.url)
const pageUrl = new URL('../leave-requests.html', import.meta.url)
const scriptUrl = new URL('../scripts/leave-requests.js', import.meta.url)

test('leave requests provide separate agent submission and administrator approval views', async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ])

  assert.match(page, /id="leaveRequestSubmissionSection"[^>]*hidden/)
  assert.match(page, /id="leaveApprovalQueueSection"[^>]*hidden/)
  assert.match(page, /class="leave-role-pending"/)
  assert.match(page, /id="leaveRequestsPage"[^>]*hidden/)
  assert.match(page, /Incentive VL/)
  assert.match(page, /Birthday VL/)
  assert.match(page, /Leave Without Pay/)
  assert.match(page, /Decision reason/)
  assert.match(script, /workforce_submit_leave_request/)
  assert.match(script, /workforce_cancel_leave_request/)
  assert.match(script, /workforce_review_leave_request/)
  assert.match(script, /hasWorkforcePermission\(access, 'approve_leave'\)/)
  assert.match(script, /elements\.submissionSection\.hidden = isApproverView/)
  assert.match(script, /elements\.approvalSection\.hidden = !isApproverView/)
  assert.match(script, /elements\.page\.hidden = false/)
  assert.match(script, /classList\.remove\('leave-role-pending'\)/)
  assert.match(script, /status === 'rejected' && !notes/)
  assert.doesNotMatch(script, /\.from\('leave_requests'\)[\s\S]*?\.insert/)
})

test('approved leave transactionally creates or converts linked leave schedules', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(migration, /add column if not exists leave_request_id uuid/)
  assert.match(migration, /references public\.leave_requests\(id\)/)
  assert.match(migration, /for update/)
  assert.match(migration, /workforce_sync_approved_leave_schedules/)
  assert.match(migration, /schedule\.shift_date between new\.start_date and new\.end_date/)
  assert.match(migration, /is_leave = true/)
  assert.match(migration, /leave_request_id = new\.id/)
  assert.match(migration, /insert into public\.work_schedules/)
  assert.match(migration, /Leave overlaps recorded attendance/)
  assert.doesNotMatch(migration, /insert into public\.attendance/)
})

test('leave submission and approval remain identity-safe and protected', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(migration, /workforce_current_profile_id\(\)/)
  assert.match(migration, /workforce_can_manage_user\([\s\S]*?'approve_leave'/)
  assert.match(migration, /A denial reason is required/)
  assert.match(migration, /revoke all on function public\.workforce_submit_leave_request/)
  assert.match(migration, /revoke all on function public\.workforce_review_leave_request/)
  assert.match(migration, /grant execute on function public\.workforce_review_leave_request/)
  assert.match(migration, /revoke insert, update, delete on table public\.leave_requests/)
  assert.match(migration, /Users can view their own leave requests/)
  assert.match(migration, /Approvers can view scoped leave requests/)
})

test('leave verification checks RPC security and schedule linkage', async () => {
  const verification = await readFile(verificationUrl, 'utf8')

  assert.match(verification, /has_function_privilege\('anon'/)
  assert.match(verification, /workforce_submit_leave_request/)
  assert.match(verification, /has_table_privilege\('authenticated', 'public\.leave_requests', 'INSERT'\)/)
  assert.match(verification, /schedule\.leave_request_id = request\.id/)
  assert.match(verification, /schedule\.is_leave/)
  assert.match(verification, /not exists/)
})

test('rollback-only leave verification covers approval, denial, and attendance preservation', async () => {
  const verification = await readFile(transactionVerificationUrl, 'utf8')

  assert.match(verification, /workforce_submit_leave_request/)
  assert.match(verification, /workforce_review_leave_request/)
  assert.match(verification, /Expected two linked Incentive VL schedule rows/)
  assert.match(verification, /Leave approval created an attendance record/)
  assert.match(verification, /Denial without a reason unexpectedly succeeded/)
  assert.match(verification, /Denied request did not retain the administrator reason/)
  assert.match(verification, /rollback;/)
})
