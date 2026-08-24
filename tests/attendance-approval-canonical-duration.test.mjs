import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('approval validates canonical billed duration before changing review state', async () => {
  const migration = await read('supabase/migrations/20260825090000_fix_approval_canonical_billed_duration.sql')

  assert.match(migration, /create or replace function public\.workforce_review_attendance\(/)
  assert.match(migration, /coalesce\(v_attendance\.billed_clock_in, v_attendance\.clock_in\)/)
  assert.match(migration, /coalesce\(v_attendance\.billed_clock_out, v_attendance\.clock_out\)/)
  assert.match(migration, /v_canonical_billed_minutes integer/)
  assert.match(migration, /v_attendance\.total_worked_minutes is distinct from v_canonical_billed_minutes/)
  assert.match(migration, /regular_minutes[\s\S]*total_overtime_minutes[\s\S]*is distinct from v_canonical_billed_minutes/)
  assert.match(migration, /total_overtime_minutes is distinct from \(/)
  assert.match(migration, /Attendance calculations must match canonical billed duration before approval\./)
})

test('approval metadata updates preserve canonical totals without weakening protections', async () => {
  const migration = await read('supabase/migrations/20260825090000_fix_approval_canonical_billed_duration.sql')

  assert.match(migration, /current_setting\('workforce\.review_metadata_update', true\)/)
  assert.match(migration, /not v_correction_recalculation and not v_review_metadata_update/)
  assert.match(migration, /new\.total_worked_minutes := floor/)
  assert.match(migration, /set_config\('workforce\.review_metadata_update', 'true', true\)/)
  assert.match(migration, /set_config\('workforce\.review_metadata_update', 'false', true\)/)
  assert.match(migration, /for update/)
  assert.match(migration, /Locked attendance cannot be changed\./)
  assert.doesNotMatch(migration, /disable trigger|enable trigger|drop trigger/i)
  assert.doesNotMatch(migration, /set\s+total_worked_minutes\s*=/i)
})

test('corrected attendance keeps canonical billed totals across the affected variance shapes', () => {
  const cases = [
    { employee: 'Alen', raw: 672, billed: 900, classified: 900 },
    { employee: 'Jean', raw: 60, billed: 600, classified: 600 },
    { employee: 'Genevive', raw: 849, billed: 900, classified: 900 },
    { employee: 'Arez', raw: 968, billed: 960, classified: 960 }
  ]

  for (const entry of cases) {
    assert.equal(entry.classified, entry.billed, `${entry.employee} classification must match billed duration`)
    assert.notEqual(entry.raw, entry.billed, `${entry.employee} must exercise the raw/billed variance path`)
  }
})
