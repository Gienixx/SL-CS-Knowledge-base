import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../scripts/workforce.js', import.meta.url), 'utf8')

test('Employee Profiles provides accessible pagination controls', () => {
  assert.match(page, /id="employeeTablePagination"[^>]*aria-label="User profile pages"[^>]*hidden/)
  assert.match(page, /id="employeeTablePageInfo"/)
  assert.match(page, /id="previousEmployeeTablePage"/)
  assert.match(page, /id="nextEmployeeTablePage"/)
  assert.match(page, /scripts\/workforce\.js\?v=7/)
})

test('Employee Profiles displays five filtered entries per page', () => {
  assert.match(script, /const EMPLOYEE_PAGE_SIZE = 5/)
  assert.match(script, /const pageRows = rows\.slice\(pageStart, pageStart \+ EMPLOYEE_PAGE_SIZE\)/)
  assert.match(script, /pageRows\.forEach\(profile =>/)
  assert.match(script, /tablePagination\.hidden = rows\.length <= EMPLOYEE_PAGE_SIZE/)
  assert.match(script, /tablePageInfo\.textContent = `Page \$\{employeePage\} of \$\{pageCount\}`/)
})

test('Employee Profiles resets pagination when data or filters change', () => {
  assert.match(script, /async function loadWorkforceData\(\) \{\s*employeePage = 1/)
  assert.match(script, /searchInput\.addEventListener\('input',[\s\S]*?employeePage = 1/)
  assert.match(script, /statusFilter\.addEventListener\('change',[\s\S]*?employeePage = 1/)
  assert.match(script, /teamFilter\.addEventListener\('change',[\s\S]*?employeePage = 1/)
})
