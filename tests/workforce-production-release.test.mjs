import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Phase 1 production gate covers every Step 18 database release condition', async () => {
  const verification = await read('supabase/verification/workforce_production_release_check.sql')

  for (const condition of [
    'active_without_auth_identity',
    'required_access_categories_covered',
    'attendance_rls_enabled',
    'leave_requests_rls_enabled',
    'correction_rpc_exists',
    'approval_rpc_exists',
    'leave_review_rpc_exists',
    'team_attendance_rpc_exists',
    'orphaned_corrections',
    'invalid_attendance_totals',
    'payroll_readiness_mismatches',
    'july_1_15_payroll_blockers',
    'approved_leave_inconsistencies',
    'active_recurring_assignments'
  ]) {
    assert.match(verification, new RegExp(`'${condition}'`))
  }
})

test('Phase 1 production gate is read-only and preserves recurring automation', async () => {
  const verification = await read('supabase/verification/workforce_production_release_check.sql')

  assert.match(verification, /work_schedule_template_assignments/)
  assert.doesNotMatch(verification, /\b(insert|update|delete|truncate|drop|alter|create)\b/i)
  assert.doesNotMatch(verification, /workforce_generate_weekly_schedules\s*\(/)
})

test('Step 18 records the accepted production release and full test gate', async () => {
  const documentation = await read('docs/workforce-step-18-production-release.md')

  assert.match(documentation, /5e6dcec4-bd32-449a-9d11-9501f8e87d5a/)
  assert.match(documentation, /277 passed, 0 failed/i)
  assert.match(documentation, /284 passed, 0 failed/i)
  assert.match(documentation, /July 1–15 payroll-readiness blockers: 0/i)
  assert.match(documentation, /recurring schedule/i)
  assert.match(documentation, /Phase 1[\s\S]*complete/i)
})
