import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('dashboard View details affordance is text-only in both themes and interactive states', async () => {
  const [dashboard, drilldowns] = await Promise.all([
    read('dashboard.html'),
    read('scripts/dashboard-drilldowns.js')
  ])

  assert.match(dashboard, /dashboard-drilldowns\.js\?v=3/)
  assert.match(drilldowns, /content: 'View details'/)
  assert.match(drilldowns, /var\(--site-heading/)
  assert.match(drilldowns, /font-size: 0\.62rem/)
  assert.match(drilldowns, /\.dashboard-report-link:hover::after/)
  assert.match(drilldowns, /\.dashboard-report-link:focus-visible::after/)
  assert.match(drilldowns, /\.dashboard-report-link:active::after/)
  assert.match(
    drilldowns,
    /\.dashboard-report-link\[aria-disabled='true'\]::after/
  )
  assert.match(drilldowns, /@media \(prefers-reduced-motion: reduce\)/)

  const labelRule = drilldowns.match(
    /\.dashboard-report-link::after \{([\s\S]*?)\n    \}/
  )?.[1] || ''
  assert.doesNotMatch(
    labelRule,
    /border:|background:|box-shadow:|padding:|text-decoration:|transform:/
  )
})
