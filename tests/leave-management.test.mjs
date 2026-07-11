import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations-legacy/2026071101_complete_leave_management.sql', import.meta.url)
const verificationUrl = new URL('../supabase/verification/leave_management_check.sql', import.meta.url)
const pageUrl = new URL('../leave-requests.html', import.meta.url)
const scriptUrl = new URL('../scripts/leave-requests.js', import.meta.url)

test('Step 14 provides the complete agent and reviewer leave interface', async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ])

  assert.match(page, /New Leave Request/)
  assert.match(page, /Request History/)
  assert.match(page, /Approve/)
  assert.match(page, /Reject/)
  assert.match(script, /\.from\('leave_requests'\)[\s\S]*?\.insert/)
  assert.match(script, /workforce_cancel_leave_request/)
  assert.match(script, /workforce_review_leave_request/)
  assert.match(script, /hasWorkforcePermission\(access, 'approve_leave'\)/)
})

test('approved leave transactionally marks eligible attendance without replacing clocks', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(migration, /for update/)
  assert.match(migration, /schedule\.status in \('published', 'changed'\)/)
  assert.match(migration, /not schedule\.is_rest_day/)
  assert.match(migration, /not schedule\.is_holiday/)
  assert.match(migration, /'on_leave'/)
  assert.match(migration, /review_status[\s\S]*?'approved'/)
  assert.match(migration, /Leave overlaps recorded attendance/)
  assert.match(migration, /on conflict \(user_id, schedule_id\)/)
  assert.match(migration, /attendance\.clock_in is null/)
})

test('leave approval remains scoped and protected from anonymous execution', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(migration, /auth\.uid\(\)/)
  assert.match(migration, /workforce_can_manage_user\(v_request\.user_id, 'approve_leave'\)/)
  assert.match(migration, /revoke all on function public\.workforce_review_leave_request\(uuid, text, text\) from public/)
  assert.match(migration, /revoke all on function public\.workforce_review_leave_request\(uuid, text, text\) from anon/)
  assert.match(migration, /grant execute on function public\.workforce_review_leave_request\(uuid, text, text\) to authenticated/)
  assert.match(migration, /revoke update, delete on public\.leave_requests from authenticated/)
})

test('Step 14 includes deployment verification for leave-attendance consistency', async () => {
  const verification = await readFile(verificationUrl, 'utf8')

  assert.match(verification, /has_function_privilege\('anon'/)
  assert.match(verification, /has_table_privilege\('authenticated', 'public\.leave_requests', 'UPDATE'\)/)
  assert.match(verification, /attendance_status = 'on_leave'/)
  assert.match(verification, /request\.status = 'approved'/)
  assert.match(verification, /schedule\.status in \('published', 'changed'\)/)
})
