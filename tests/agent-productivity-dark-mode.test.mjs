import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Agent Productivity uses readable dark-mode surfaces and states', async () => {
  const [dashboard, productivityStyles, reportPage, reportStyles] =
    await Promise.all([
      read('dashboard.html'),
      read('styles/dashboard-productivity.css'),
      read('report-details.html'),
      read('styles/report-details.css')
    ])

  assert.match(dashboard, /dashboard-productivity\.css\?v=4/)
  assert.match(
    productivityStyles,
    /html\[data-site-theme="dark"\] \.productivity-row/
  )
  assert.match(productivityStyles, /var\(--site-surface-solid\)/)
  assert.match(productivityStyles, /\.productivity-bar-track/)
  assert.match(productivityStyles, /\.productivity-state-error/)
  assert.match(
    productivityStyles,
    /\.productivity-row\.dashboard-detail-link:hover/
  )

  assert.match(reportPage, /report-details\.css\?v=3/)
  assert.match(
    reportStyles,
    /html\[data-site-theme="dark"\] \.report-details-shell/
  )
  assert.match(reportStyles, /\.report-chart-label/)
  assert.match(reportStyles, /\.report-breakdown-row:hover/)
  assert.match(reportStyles, /\.detail-table tbody tr:hover/)
  assert.match(reportStyles, /\.detail-status-error/)
  assert.match(reportStyles, /var\(--site-muted\)/)
})
