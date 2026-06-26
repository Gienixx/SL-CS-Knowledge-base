import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(relativePath) {
  const absolutePath = join(ROOT, relativePath)
  assert.ok(existsSync(absolutePath), `${relativePath} must exist`)
  return readFileSync(absolutePath, 'utf8')
}

function assertContainsAll(source, values, label) {
  values.forEach(value => {
    assert.ok(
      source.includes(value),
      `${label} must contain ${JSON.stringify(value)}`
    )
  })
}

test('dashboard wires every live Phase 2 section and health module', () => {
  const dashboardHtml = read('dashboard.html')
  const dashboardJs = read('scripts/dashboard.js')

  assertContainsAll(dashboardHtml, [
    'scripts/dashboard.js',
    'scripts/dashboard-drivers-loader.js',
    'scripts/dashboard-drilldowns.js',
    'scripts/dashboard-accessibility.js',
    'scripts/dashboard-data-consistency.js',
    'dashboard-accessibility.css'
  ], 'dashboard.html')

  assertContainsAll(dashboardJs, [
    'initializePhaseOneDashboard',
    'initializeDistributionDashboard',
    'initializeProductivityDashboard',
    "board.setAttribute('aria-busy', 'false')"
  ], 'scripts/dashboard.js')
})

test('dashboard charts expose keyboard-accessible links for all detail views', () => {
  const drilldowns = read('scripts/dashboard-drilldowns.js')

  assertContainsAll(drilldowns, [
    './data-details.html?',
    'applyAgentLinks(models.agents)',
    'applyDriverLinks(models.drivers)',
    "applyDistributionLinks('app'",
    "applyDistributionLinks('platform'",
    "applyDistributionLinks('country'",
    "element.setAttribute('role', 'link')",
    "element.setAttribute('tabindex', '0')",
    "event.key !== 'Enter'",
    "event.key !== ' '"
  ], 'scripts/dashboard-drilldowns.js')
})

test('detail page supports every view, historical charts, tables, and date filters', () => {
  const detailHtml = read('data-details.html')
  const detailJs = read('scripts/data-details.js')
  const detailUtils = read('scripts/data-details-utils.js')

  assertContainsAll(detailHtml, [
    'value="latest"',
    'value="7d"',
    'value="30d"',
    'value="mtd"',
    'value="custom"',
    'id="trendChart"',
    'id="additionalTrendChart"',
    'id="detailTableScroll"',
    'role="region"',
    'tabindex="0"'
  ], 'data-details.html')

  assertContainsAll(detailJs, [
    "'driver'",
    "'agent'",
    "'app'",
    "'platform'",
    "'country'",
    'parseDateRangeRequest',
    'loadDriverDetail',
    'loadAgentDetail',
    'loadDistributionDetail',
    'requireApprovedUser'
  ], 'scripts/data-details.js')

  assertContainsAll(detailUtils, [
    'resolveDateRange',
    'applyDateRange',
    ".gte('report_date'",
    ".lte('report_date'",
    'fetchAllRows'
  ], 'scripts/data-details-utils.js')
})

test('AHT uses decimal minutes and displays minutes and seconds consistently', () => {
  const productivity = read('scripts/dashboard-productivity-v2.js')
  const detailUtils = read('scripts/data-details-utils.js')

  for (const [label, source] of [
    ['scripts/dashboard-productivity-v2.js', productivity],
    ['scripts/data-details-utils.js', detailUtils]
  ]) {
    assertContainsAll(source, [
      'decimalMinutes',
      'Math.round(decimalMinutes * 60)',
      'Math.floor(totalSeconds / 60)',
      "padStart(2, '0')"
    ], label)
  }

  assertContainsAll(productivity, [
    "const AHT_UNIT = 'minutes.seconds'",
    "createMetric('AHT', formattedAht)"
  ], 'scripts/dashboard-productivity-v2.js')
})

test('database migrations enforce idempotency and read-only browser access', () => {
  const integrityMigration = read(
    'supabase/migrations/20260626_dashboard_sync_integrity_guards.sql'
  )
  const rlsMigration = read(
    'supabase/migrations/20260626_dashboard_metrics_read_only_rls.sql'
  )
  const verification = read(
    'supabase/verification/phase2_step10_integrity_check.sql'
  )

  assertContainsAll(integrityMigration, [
    'daily_ticket_metrics_report_date_uidx',
    'daily_distribution_metrics_key_uidx',
    'agent_productivity_key_uidx',
    'ticket_driver_metrics_key_uidx',
    'daily_ticket_metrics_values_check',
    'agent_productivity_values_check'
  ], 'dashboard sync integrity migration')

  assertContainsAll(rlsMigration, [
    'enable row level security',
    'revoke all privileges',
    'grant select',
    'to authenticated',
    'to service_role',
    'for select'
  ], 'dashboard read-only RLS migration')

  assertContainsAll(verification, [
    'duplicate_rows',
    'invalid_rows',
    'latest_report_date',
    'sheet_sync_runs'
  ], 'Step 10 verification query')
})

test('scheduled synchronization targets one daily version 2 trigger at noon Eastern', () => {
  const triggerHelper = read('apps-script/dashboard-trigger-migration.gs')
  const triggerGuide = read('docs/phase-2-step-7-trigger-migration.md')

  assertContainsAll(triggerHelper, [
    "currentHandler: 'syncAllDashboardData'",
    "legacyHandler: 'syncDashboardData'",
    "timezone: 'America/New_York'",
    'hour: 12',
    '.everyDays(1)',
    'inspectDashboardSyncTriggers',
    'testDashboardSyncV2Now'
  ], 'Apps Script trigger helper')

  assertContainsAll(triggerGuide, [
    'currentTriggerCount',
    'legacyTriggerCount',
    'payloadVersion',
    'sheet_sync_runs'
  ], 'trigger migration guide')
})

test('responsive and accessibility assets cover required acceptance widths', () => {
  const accessibilityCss = read('dashboard-accessibility.css')
  const accessibilityJs = read('scripts/dashboard-accessibility.js')

  assertContainsAll(accessibilityCss, [
    '@media (max-width: 1024px)',
    '@media (max-width: 768px)',
    '@media (max-width: 390px)',
    '.detail-table-scroll:focus-visible',
    'overflow-wrap: anywhere'
  ], 'dashboard-accessibility.css')

  assertContainsAll(accessibilityJs, [
    "element.setAttribute('role', 'link')",
    "element.setAttribute('tabindex', '0')",
    "event.key !== 'Enter'",
    "event.key !== ' '動",
    "setAttribute('aria-busy'",
    "setAttribute('aria-label'"
  ], 'scripts/dashboard-accessibility.js')
})
