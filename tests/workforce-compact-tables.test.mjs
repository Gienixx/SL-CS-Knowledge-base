import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles/workforce-admin.css', import.meta.url), 'utf8')

test('employee profiles and schedule management use the compact table design', () => {
  assert.match(page, /class="wf-table wf-compact-table wf-employee-table"/)
  assert.match(page, /class="wf-table wf-schedule-table wf-compact-table"/)
  assert.match(page, /workforce-admin\.css\?v=4/)
})

test('compact workforce tables tighten cells, supporting text, badges, and actions', () => {
  assert.match(styles, /\.wf-compact-table th,\.wf-compact-table td\{padding:8px 10px\}/)
  assert.match(styles, /\.wf-compact-table td\{font-size:\.86rem\}/)
  assert.match(styles, /\.wf-compact-table \.wf-subtext\{margin-top:1px;font-size:\.72rem\}/)
  assert.match(styles, /\.wf-compact-table \.wf-badge\{padding:4px 8px;font-size:\.7rem\}/)
  assert.match(styles, /\.wf-compact-table \.wf-row-btn\{min-height:28px;padding:0 10px;font-size:\.76rem\}/)
})
