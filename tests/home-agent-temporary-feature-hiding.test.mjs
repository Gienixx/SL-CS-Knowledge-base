import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home exposes leave requests to agents while My payslips remains temporarily hidden', async () => {
  const [page, navigation] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(page, /id="homeLeaveRequestsBtn"[^>]+href="\.\/leave-requests\.html"[^>]+hidden/)
  assert.match(page, /id="homeLeaveRequestsPendingBadge"/)
  assert.match(page, /id="homeMyPayslipsBtn"[^>]+href="\.\/my-payslips\.html"[^>]+hidden/)
  assert.match(page, /scripts\/home-workforce-nav\.js\?v=10/)
  assert.match(navigation, /const canApproveLeave =/)
  assert.match(navigation, /const canUseLeaveRequests = access\.is_agent === true \|\| canApproveLeave/)
  assert.match(navigation, /leaveRequestsButton\.hidden = !canUseLeaveRequests/)
  assert.match(navigation, /\.eq\('status', 'pending'\)/)
  assert.match(navigation, /leaveRequestsPendingBadge\.hidden = pendingCount === 0/)
  assert.match(navigation, /myPayslipsButton\.hidden = isRegularAgentView \|\| !canViewOwnPayslips/)
})

test('leave access keeps the approval permission boundary and feature page', async () => {
  const [navigation, leavePage, payslipPage] = await Promise.all([
    read('scripts/home-workforce-nav.js'),
    read('leave-requests.html'),
    read('my-payslips.html')
  ])

  assert.match(navigation, /hasWorkforcePermission\(access, 'approve_leave'\)/)
  assert.match(navigation, /const canViewOwnPayslips = hasWorkforcePermission\(/)
  assert.match(leavePage, /id="leaveRequestForm"|Leave request/i)
  assert.match(payslipPage, /id="myPayslipsTableBody"|My payslips/i)
})
