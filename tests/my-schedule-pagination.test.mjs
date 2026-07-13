import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('schedule details table is compact and omits sequence display', async () => {
  const [page, script, styles] = await Promise.all([
    read('my-schedule.html'),
    read('scripts/my-schedule-v2.js'),
    read('styles/my-schedule.css')
  ])

  assert.match(page, /class="wf-table wf-schedule-table my-schedule-details-table"/)
  assert.match(styles, /\.my-schedule-details-table th,\.my-schedule-details-table td\{padding:8px 10px\}/)
  assert.doesNotMatch(script, /`Sequence \$\{schedule\.shift_sequence\}`/)
  assert.match(script, /textCell\(formatDate\(schedule\.shift_date\)\)/)
})

test('schedule details paginate after ten entries', async () => {
  const [page, script] = await Promise.all([
    read('my-schedule.html'),
    read('scripts/my-schedule-v2.js')
  ])

  assert.match(page, /id="myScheduleTablePagination"/)
  assert.match(page, /id="previousMyScheduleTablePage"/)
  assert.match(page, /id="nextMyScheduleTablePage"/)
  assert.match(script, /const TABLE_PAGE_SIZE = 10/)
  assert.match(script, /rows\.slice\(pageStart, pageStart \+ TABLE_PAGE_SIZE\)/)
  assert.match(script, /rows\.length <= TABLE_PAGE_SIZE/)
  assert.match(script, /Page \$\{tablePage\} of \$\{pageCount\}/)
})
