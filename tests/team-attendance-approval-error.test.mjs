import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function functionSource(script, name, signature) {
  const source = script.match(new RegExp(`function ${name}\\(${signature}\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(source, `${name} should remain independently inspectable`)
  return source
}

test('approval and correction constraint errors are action-specific', async () => {
  const script = await read('scripts/team-attendance.js')
  const source = functionSource(script, 'reviewActionErrorMessage', 'error, action')
  const fallbackSource = functionSource(script, 'errorMessage', 'error')
  const errorMessage = Function(`${fallbackSource}\n${source}\nreturn reviewActionErrorMessage`)()
  const constraintError = {
    message: 'new row for relation "attendance" violates check constraint "attendance_structured_totals_check"'
  }

  assert.match(errorMessage(constraintError, 'Approve'), /Approval could not be completed/)
  assert.doesNotMatch(errorMessage(constraintError, 'Approve'), /correction could not be applied/i)
  assert.match(errorMessage(constraintError, 'Lock'), /correction could not be applied/i)
})

test('new review action clears the other action surface error', async () => {
  const script = await read('scripts/team-attendance.js')
  const reviewSource = script.match(/async function reviewAttendance\([\s\S]*?\r?\n\}\r?\n\r?\nfunction formatCorrectionDateTime/)?.[0]
  const correctionSource = script.match(/async function handleCorrectionSubmit\([\s\S]*?\r?\n\}\r?\n\r?\nasync function initialize/)?.[0]

  assert.ok(reviewSource)
  assert.ok(correctionSource)
  assert.match(reviewSource, /setMessage\(document\.getElementById\('teamAttendanceCorrectionMessage'\), ''\)/)
  assert.match(correctionSource, /setMessage\(elements\.tableMessage, ''\)/)
})
