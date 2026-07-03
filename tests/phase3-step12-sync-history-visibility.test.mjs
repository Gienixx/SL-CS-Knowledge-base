import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('hotfix grants authenticated visibility through the security-invoker sync view', async () => {
  const migration = await read('../supabase/migrations/2026070403_phase3_step12_sync_history_visibility_fix.sql')

  assert.match(migration, /alter table public\.sheet_sync_runs enable row level security/)
  assert.match(migration, /grant select\s+on table public\.sheet_sync_runs\s+to authenticated/is)
  assert.match(migration, /Authenticated users can read sheet synchronization runs/)
  assert.match(migration, /create or replace view public\.dashboard_sync_runs/)
  assert.match(migration, /security_invoker = true/)
})

test('hotfix resolves superseded sync and quality alerts', async () => {
  const migration = await read('../supabase/migrations/2026070403_phase3_step12_sync_history_visibility_fix.sql')

  assert.match(migration, /latest_success/)
  assert.match(migration, /alert\.alert_type = 'sync_failure'/)
  assert.match(migration, /latest_quality/)
  assert.match(migration, /row_number\(\) over/)
  assert.match(migration, /metadata ->> 'checkKey'/)
  assert.match(migration, /create or replace function public\.record_dashboard_quality_operations/)
})

test('hotfix verification checks permissions, row parity, and alert cleanup', async () => {
  const verification = await read('../supabase/verification/phase3_step12_sync_history_visibility_check.sql')

  assert.match(verification, /authenticated_sheet_sync_select/)
  assert.match(verification, /sheet_sync_read_policy/)
  assert.match(verification, /dashboard_sync_view_row_parity/)
  assert.match(verification, /superseded_sync_failures_resolved/)
  assert.match(verification, /single_open_quality_alert_per_check/)
})

test('hotfix rollout documentation describes the observed unavailable-history symptom', async () => {
  const documentation = await read('../docs/phase-3-step-12-sync-history-visibility-fix.md')

  assert.match(documentation, /Latest sync: Unavailable/)
  assert.match(documentation, /security_invoker/)
  assert.match(documentation, /No successful Google Sheet synchronization/)
  assert.match(documentation, /2026070403_phase3_step12_sync_history_visibility_fix\.sql/)
})
