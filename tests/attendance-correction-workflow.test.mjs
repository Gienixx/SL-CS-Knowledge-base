import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/2026070904_attendance_correction_workflow.sql'

test('Step 12 migration creates the correction history table and correction RPC', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create table if not exists public\.attendance_corrections/)
  assert.match(migration, /create or replace function public\.workforce_correct_attendance\(/)
  assert.match(migration, /reason_code/)
  assert.match(migration, /insert into public\.attendance_corrections/)
  assert.match(migration, /review_status = 'corrected'/)
})
