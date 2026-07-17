import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles/workforce-admin.css', import.meta.url), 'utf8')

test('Schedule Management provides accessible pagination controls', () => {
  assert.match(page, /id="scheduleTablePagination"[^>]*aria-label="Schedule management pages"[^>]*hidden/)
  assert.match(page, /id="scheduleTablePageInfo"/)
  assert.match(page, /id="previousScheduleTablePage"/)
  assert.match(page, /id="nextScheduleTablePage"/)
  assert.match(page, /workforce-admin\.css\?v=4/)
  assert.match(page, /workforce-schedules-entry\.js\?v=3/)
  assert.match(styles, /\.wf-table-pagination\{/)
  assert.match(styles, /\.wf-table-pagination\[hidden\]\{display:none\}/)
})

test('Schedule Management displays ten filtered entries per page', () => {
  assert.match(script, /const TABLE_PAGE_SIZE = 10/)
  assert.match(script, /const pageRows = rows\.slice\(pageStart, pageStart \+ TABLE_PAGE_SIZE\)/)
  assert.match(script, /pageRows\.forEach\(schedule =>/)
  assert.match(script, /tablePagination\.hidden = rows\.length <= TABLE_PAGE_SIZE/)
  assert.match(script, /tablePageInfo\.textContent = `Page \$\{schedulePage\} of \$\{pageCount\}`/)
})

test('Schedule Management resets pagination when data or filters change', () => {
  assert.match(script, /async function loadScheduleData\(\) \{\s*schedulePage = 1/)
  assert.match(script, /teamFilter\.addEventListener\('change',[\s\S]*?schedulePage = 1/)
  assert.match(script, /employeeFilter\.addEventListener\('change',[\s\S]*?schedulePage = 1/)
  assert.match(script, /statusFilter\.addEventListener\('change',[\s\S]*?schedulePage = 1/)
})
