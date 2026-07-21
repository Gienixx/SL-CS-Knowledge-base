import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260721153218_harden_attendance_write_boundaries.sql'

test('attendance browser writes are restricted to audited RPCs', async () => {
  const migration = await read(migrationPath)

  for (const policy of ['insert', 'update', 'delete']) {
    assert.match(migration, new RegExp(`drop policy if exists "Authorized users can ${policy} attendance"`, 'i'))
  }

  assert.match(migration, /revoke all on table public\.attendance from anon/)
  assert.match(migration, /revoke insert, update, delete, truncate, references, trigger\s+on table public\.attendance from authenticated/)
  assert.match(migration, /grant select on table public\.attendance to authenticated/)
})

test('correction history is read-only for browser roles and protected from parent deletion', async () => {
  const migration = await read(migrationPath)

  for (const action of ['insert', 'update', 'delete']) {
    assert.match(migration, new RegExp(`drop policy if exists "Admins can ${action} attendance correction history"`, 'i'))
  }

  assert.match(migration, /for select\s+to authenticated/)
  assert.match(migration, /revoke all on table public\.attendance_corrections from anon/)
  assert.match(migration, /revoke insert, update, delete, truncate, references, trigger\s+on table public\.attendance_corrections from authenticated/)
  assert.match(migration, /on delete restrict/)
  assert.match(migration, /Attendance with correction history cannot be deleted\./)
})

test('anonymous users cannot execute payroll-sensitive security-definer RPCs', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /revoke all on function public\.workforce_delete_attendance\(uuid, text\)\s+from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_delete_attendance\(uuid, text\)\s+to authenticated, service_role/)
  assert.match(migration, /revoke all on function public\.workforce_cancel_leave_request\(uuid\)\s+from public, anon/)
  assert.match(migration, /grant execute on function public\.workforce_cancel_leave_request\(uuid\)\s+to authenticated, service_role/)
})
