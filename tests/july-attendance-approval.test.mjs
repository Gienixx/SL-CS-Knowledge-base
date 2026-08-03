import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../supabase/migrations/20260803131955_approve_validated_july_attendance.sql',
  import.meta.url
), 'utf8')

test('the final seven July attendance records are approved as an exact guarded batch', () => {
  const attendanceIds = [
    '3ba5a8bf-3137-46c2-986f-99f09232977a',
    '4eb2b52b-0370-4099-b7b8-283a44cfb998',
    '56c5aef9-81a1-45ad-a69f-015f09b6c9a8',
    '88e48557-f36e-45c3-b033-475400247983',
    'b4be6e77-c665-49c5-a61c-5e9bd225aa80',
    'e409e6a7-6ee6-4537-a086-a9596e70f4f9',
    'ed29eccd-f852-49e6-a99d-550363c7abf7'
  ]

  for (const id of attendanceIds) assert.match(migration, new RegExp(id))
  assert.equal((migration.match(/'pending'::text/g) || []).length, 5)
  assert.equal((migration.match(/'corrected'::text/g) || []).length, 2)
})

test('approval uses the audited review RPC and refuses any blocker beyond review', () => {
  assert.match(migration, /public\.workforce_has_permission\('approve_attendance'\)/)
  assert.match(migration, /v_blockers is distinct from array\['review_required'\]::text\[\]/)
  assert.match(migration, /public\.workforce_review_attendance\([\s\S]*'approved'/)
  assert.match(migration, /review_status <> 'approved'/)
  assert.match(migration, /coalesce\(cardinality\(v_blockers\), 0\) <> 0/)
  assert.doesNotMatch(migration, /update public\.attendance/i)
})
