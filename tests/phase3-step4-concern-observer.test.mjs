import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('Concern compatibility only mutates values when they change', async () => {
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

test('Concern compatibility disconnects its initial observer', async () => {
  const source = await read('scripts/dashboard-concern-compat.js')

  assert.match(source, /function observeInitialConcernUi\(timeout = 20000\)/)
  assert.match(source, /observer\.disconnect\(\)/)
  assert.match(source, /window\.clearTimeout\(timer\)/)
  assert.match(source, /window\.addEventListener\('dashboard:filtered-data'/)
  assert.doesNotMatch(source, /characterData:\s*true/)
  assert.doesNotMatch(source, /function observeConcernUi\(/)
})

test('dashboard cache-busts the loop-safe Concern compatibility module', async () => {
  const dashboard = await read('dashboard.html')

  assert.match(
    dashboard,
    /scripts\/dashboard-concern-compat\.js\?v=5/
  )
})
