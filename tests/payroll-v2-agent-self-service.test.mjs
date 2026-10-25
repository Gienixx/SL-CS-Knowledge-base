import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home exposes the Payroll V2 self-service payslip page to every permitted active agent', async () => {
  const [home, navigation] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])
  assert.match(home, /id="homeMyPayslipsBtn"[^>]*href="\.\/my-payslips-v2\.html"/)
  assert.match(home, /home-workforce-nav\.js\?v=11/)
  assert.match(navigation, /canViewOwnPayslips = hasWorkforcePermission\(/)
  assert.match(navigation, /myPayslipsButton\.hidden = !canViewOwnPayslips/)
  assert.doesNotMatch(navigation, /myPayslipsButton\.hidden = isRegularAgentView/)
})

test('Payroll V2 self-service uses only employee-scoped RPCs and never admin preview', async () => {
  const [page, list, previewPage, preview] = await Promise.all([
    read('my-payslips-v2.html'),
    read('scripts/my-payslips-v2.js'),
    read('payslip-v2-preview.html'),
    read('scripts/payslip-v2-preview.js')
  ])

  assert.match(page, /My Payslips/)
  assert.match(page, /scripts\/my-payslips-v2\.js\?v=1/)
  assert.match(list, /requireWorkforcePermission\(/)
  assert.match(list, /'view_own_payslips'/)
  assert.match(list, /'payroll_v2_list_my_payslips'/)
  assert.match(list, /payslip-v2-preview\.html\?\$\{params\}/)
  assert.match(list, /params\.set\('print', '1'\)/)
  assert.match(list, /recalculation_pending !== true/)
  assert.doesNotMatch(list, /payroll_list_my_payslips|payroll_v2_list_completed_payslips|admin: '1'/)
  assert.match(preview, /'payroll_v2_get_my_payslip'/)
  assert.match(preview, /elements\.back\.href = '\.\/my-payslips-v2\.html'/)
  assert.match(previewPage, /id="payslipV2BackLink" href="\.\/my-payslips-v2\.html"/)
})
