import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('dashboard hides Reporting Operations until administrator access is verified', async () => {
  const [html, script] = await Promise.all([
    read('dashboard.html'),
    read('scripts/dashboard.js')
  ])

  assert.match(
    html,
    /id="reportingOperationsBtn"[^>]*style="display:none;"/
  )
  assert.match(script, /access\.is_admin\s*===\s*true/)
  assert.match(script, /view_workforce_reports/)
  assert.match(script, /reportingOperationsBtn\.style\.display/)
})

test('Reporting Operations loads only after the browser administrator gate passes', async () => {
  const [html, entry] = await Promise.all([
    read('reporting-operations.html'),
    read('scripts/reporting-operations-entry.js')
  ])

  assert.match(html, /scripts\/reporting-operations-entry\.js/)
  assert.doesNotMatch(html, /src="\.\/scripts\/reporting-operations\.js/)
  assert.match(entry, /requireApprovedUser/)
  assert.match(entry, /loadCurrentWorkforceAccess/)
  assert.match(entry, /access\.is_admin\s*===\s*true/)
  assert.match(entry, /view_workforce_reports/)
  assert.match(entry, /import\('\.\/reporting-operations\.js\?v=1'\)/)
})

test('Supabase protects Reporting Operations records and export auditing', async () => {
  const migration = await read(
    'supabase/migrations/2026070607_reporting_operations_admin_access.sql'
  )
  const verification = await read(
    'supabase/verification/reporting_operations_admin_access_check.sql'
  )

  for (const table of [
    'dashboard_audit_events',
    'dashboard_alert_events',
    'dashboard_data_quality_results',
    'sheet_sync_runs'
  ]) {
    assert.match(migration, new RegExp(`on public\\.${table}`))
  }

  assert.match(migration, /workforce_is_admin\(\)/)
  assert.match(migration, /workforce_has_permission\('view_workforce_reports'\)/)
  assert.match(migration, /reporting_operations_admin_required/)
  assert.match(migration, /revoke all[\s\S]+from public, anon;/i)
  assert.match(verification, /Missing administrator-scoped Reporting Operations policy/)
  assert.match(verification, /anon must not execute record_dashboard_export/)
})
