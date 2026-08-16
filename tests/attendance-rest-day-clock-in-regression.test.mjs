import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

async function loadRestDayEligibility() {
  const script = await read('scripts/attendance.js')
  const match = script.match(/function isUntimedRestDayWithinClockInWindow\(schedule, now = new Date\(\)\) \{([\s\S]*?)\n\}/)

  assert.ok(match, 'the targeted untimed Rest Day eligibility helper must remain present')

  const localDateKey = () => '2026-08-16'
  const offsetDateKey = (dateKey, amount) => amount === 1 ? '2026-08-17' : dateKey
  return new Function('localDateKey', 'offsetDateKey', `return function isEligible(schedule, now = new Date()) {${match[1]}\n}`)(localDateKey, offsetDateKey)
}

test('untimed current-day RDOT is clock-in eligible', async () => {
  const isEligible = await loadRestDayEligibility()

  assert.equal(isEligible({ is_rest_day: true, shift_date: '2026-08-16', shift_start: null, shift_end: null }), true)
})

test('untimed next-day RDOT is eligible without today completion', async () => {
  const isEligible = await loadRestDayEligibility()

  assert.equal(isEligible({ is_rest_day: true, shift_date: '2026-08-17', shift_start: null, shift_end: null }), true)
})

test('ordinary future schedules remain blocked', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /\['next-day-special', 'next-day-overnight', 'special', 'early', 'active'\]\.includes\(availability\.state\)/)
  assert.match(script, /isUntimedRestDayWithinClockInWindow\(schedule\)/)
  assert.match(script, /elements\.clockInButton\.disabled = busy \|\| Boolean\(openRecord\) \|\| selectedCompleted \|\| !hasExplicitSelection \|\| !scheduleClockInOpen/)
  assert.doesNotMatch(script, /availability\.state === 'future'[^\n]*\|\|/)
})

test('untimed Open Schedule remains ineligible', async () => {
  const isEligible = await loadRestDayEligibility()

  assert.equal(isEligible({ is_rest_day: false, shift_date: '2026-08-16', shift_start: null, shift_end: null }), false)
})

test('timed Rest Day remains governed by existing availability states', async () => {
  const isEligible = await loadRestDayEligibility()

  assert.equal(isEligible({ is_rest_day: true, shift_date: '2026-08-16', shift_start: '2026-08-16T09:00:00+08:00', shift_end: '2026-08-16T18:00:00+08:00' }), false)
})

test('attendance client remains valid JavaScript', async () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
