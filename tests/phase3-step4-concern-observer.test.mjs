import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('Concern observer only mutates text and attributes when values change', async () => {
  const source = await read('scripts/dashboard-concern-compat.js')

  assert.match(source, /function setTextIfChanged\(element, value\)/)
  assert.match(source, /element\.textContent !== value/)
  assert.match(source, /function setAttributeIfChanged\(element, name, value\)/)
  assert.match(source, /element\.getAttribute\(name\) !== value/)
  assert.match(source, /setTextIfChanged\(caption, 'Concern'\)/)
  assert.match(source, /setTextIfChanged\(allOption, 'All concerns'\)/)

  assert.doesNotMatch(source, /if \(caption\) caption\.textContent = 'Concern'/)
  assert.doesNotMatch(source, /if \(allOption\) allOption\.textContent = 'All concerns'/)
})

test('dashboard cache-busts the corrected Concern compatibility module', async () => {
  const dashboard = await read('dashboard.html')

  assert.match(
    dashboard,
    /scripts\/dashboard-concern-compat\.js\?v=2/
  )
})
