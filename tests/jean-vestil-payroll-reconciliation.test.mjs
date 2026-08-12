import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Jean July 16–31 reconciliation documents the accepted legacy variance', async () => {
  const document = await read('docs/jean-vestil-july-2026-payroll-reconciliation.md')

  assert.match(document, /10,136 min \(168h 56m\)/)
  assert.match(document, /10,080 min \(168h\)/)
  assert.match(document, /\+56 minutes \/ \+\$2\.99/)
  assert.match(document, /not an exact acceptance\s+target/)
  assert.match(document, /legacy comparison\s+values/)
  assert.match(document, /Future controlled payroll periods/)
  assert.match(document, /Jul 17[\s\S]*prior-cutoff offset/)
  assert.match(document, /Jul 27[\s\S]*actual prepaid source is 840 minutes/)
  assert.match(document, /Jul 28[\s\S]*approved 8-minute attendance/)
  assert.match(document, /Jul 30[\s\S]*original prepaid source is 960 minutes/)
  assert.match(document, /Jul 31[\s\S]*420-minute offset/)
  assert.match(document, /Do not introduce payroll adjustments solely/)
  assert.match(document, /No payroll, attendance, prepaid data, or calculation logic was changed/)
})
