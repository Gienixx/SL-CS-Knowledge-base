import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home temporarily hides Leave requests and My payslips from regular agent views', async () => {
  const [page, navigation] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(page, /id="homeLeaveRequestsBtn"[^>]+href="\.\/leave-requests\.html"[^>]+hidden/)
  assert.match(page, /id="homeMyPayslipsBtn"[^>]+href="\.\/my-payslips\.html"[^>]+hidden/)
  assert.match(page, /scripts\/home-workforce-nav\.js\?v=9/)
  assert.match(navigation, /const isRegularAgentView = access\.access_type === 'regular_agent'/)
  assert.match(
    navigation,
    /leaveRequestsButton\.hidden = isRegularAgentView \|\| !access\.allowed/
  )
  assert.match(
    navigation,
    /myPayslipsButton\.hidden = isRegularAgentView \|\| !canViewOwnPayslips/
  )
})

test('the temporary Home restriction preserves administrator access checks and feature pages', async () => {
  const [navigation, leavePage, payslipPage] = await Promise.all([
    read('scripts/home-workforce-nav.js'),
    read('leave-requests.html'),
    read('my-payslips.html')
  ])

  assert.match(navigation, /const canViewOwnPayslips = hasWorkforcePermission\(/)
  assert.match(leavePage, /id="leaveRequestForm"|Leave request/i)
  assert.match(payslipPage, /id="myPayslipsTableBody"|My payslips/i)
})
