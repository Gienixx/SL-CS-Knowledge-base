import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('schedule chooser adds Additional work session before calculating the preferred value', async () => {
  const script = await read('scripts/attendance.js')
  const chooser = script.match(/function renderScheduleChooser\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(chooser)
  assert.ok(chooser.indexOf('ADDITIONAL_WORK_SESSION') < chooser.indexOf('const optionValues'))
  assert.ok(chooser.indexOf('const optionValues') < chooser.indexOf('const preferred'))
})

test('chooser preserves assigned and Additional work session selections across refreshes', async () => {
  const script = await read('scripts/attendance.js')
  const chooser = script.match(/function renderScheduleChooser\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(chooser)
  assert.match(chooser, /const previous = elements\.scheduleSelect\.value/)
  assert.match(chooser, /optionValues\.includes\(previous\) && previous/)
  assert.match(chooser, /new Option\(`\$\{formatDate\(activeLocalDate, false\)\} · Additional work session · Needs review`, ADDITIONAL_WORK_SESSION\)/)
  assert.match(chooser, /elements\.scheduleSelect\.value = preferred/)
})

test('attendance selection change remains syntactically valid', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
})
