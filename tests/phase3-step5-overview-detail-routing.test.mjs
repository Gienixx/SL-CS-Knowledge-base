import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('overview dashboard no longer initializes global filters', async () => {
  const html = await read('dashboard.html')

  assert.doesNotMatch(html, /dashboard-global-filters\.js/)
  assert.doesNotMatch(html, /dashboard-period-comparisons\.js/)
  assert.match(html, /dashboard-drilldowns\.js\?v=2/)
  assert.match(html, /latest Google Sheet snapshot/)
})

test('overview chart and KPI clicks route to the reusable report page', async () => {
  const script = await read('scripts/dashboard-drilldowns.js')

  assert.match(script, /report-details\.html/)
  assert.match(script, /new-vs-solved/)
  assert.match(script, /one-touch-resolution/)
  assert.match(script, /agent-productivity/)
  assert.match(script, /report: 'concern'/)
  assert.match(script, /filter: 'agent'/)
  assert.match(script, /filter: 'driver'/)
})

test('report detail page contains date and Zendesk dimension filters', async () => {
  const [html, script] = await Promise.all([
    read('report-details.html'),
    read('scripts/report-details.js')
  ])

  assert.match(html, /id="reportRange"/)
  assert.match(html, /name="app"/)
  assert.match(html, /name="platform"/)
  assert.match(html, /name="country"/)
  assert.match(html, /name="driver"/)
  assert.match(html, /name="agent"/)
  assert.match(html, /name="priority"/)
  assert.match(html, /name="channel"/)
  assert.match(script, /get_dashboard_filtered_data/)
})

test('report source routing keeps unsegmented daily data on Google Sheet', async () => {
  const script = await read('scripts/report-details.js')

  assert.match(script, /function hasDetailedFilters/)
  assert.match(script, /function selectSource/)
  assert.match(
    script,
    /config\.supportsZendesk && hasDetailedFilters\(state\)[\s\S]*\? 'zendesk'[\s\S]*: 'google_sheet'/
  )
  assert.match(script, /Source: Google Sheet daily snapshot/)
  assert.match(script, /Source: Zendesk filtered data/)
})

test('one-touch resolution remains on the daily Google Sheet source', async () => {
  const script = await read('scripts/report-details.js')

  assert.match(
    script,
    /'one-touch-resolution'[\s\S]*supportsZendesk: false/
  )
  assert.match(script, /document\.querySelectorAll\('\[data-dimension-filter\]'\)/)
})
