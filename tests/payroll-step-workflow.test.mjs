import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Payroll Period exposes six direct-click workflow panels and preserves existing controls', async () => {
  const [page, script, styles] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js'),
    read('styles/payroll-periods.css')
  ])

  for (const step of ['readiness', 'prepaid', 'exceptions', 'payroll', 'adjustments', 'review']) {
    assert.match(page, new RegExp(`data-payroll-step="${step}"`))
    assert.match(page, new RegExp(`data-payroll-step-panel="${step}"`))
  }
  assert.match(page, /data-payroll-step="readiness"[^>]*aria-selected="true"/)
  assert.match(page, /data-payroll-step-panel="prepaid" hidden/)
  assert.match(page, /data-payroll-step-panel="review" hidden/)
  for (const id of [
    'importPayrollAttendanceButton', 'payrollPreplotBody', 'payrollExceptionBody',
    'payrollCalculationBody', 'payrollAdjustmentBody', 'reviewPayrollButton',
    'finalizePayrollButton', 'reopenPayrollButton'
  ]) assert.match(page, new RegExp(`id="${id}"`))

  assert.match(script, /activeStep: 'readiness'/)
  assert.match(script, /function setPayrollStep\(step, options = \{\}\)/)
  assert.match(script, /state\.activeStep = step/)
  assert.match(script, /panel\.hidden = panel\.dataset\.payrollStepPanel !== step/)
  assert.match(script, /function organizePayrollStepPanels\(\)/)
  assert.match(script, /setPayrollStep\(state\.activeStep\)/)
  assert.match(script, /setPayrollStep\('exceptions'/)
  assert.match(script, /target\?\.includes\('payrollPreplot'\)/)
  assert.match(script, /target\?\.includes\('payrollException'\)/)
  assert.match(script, /function renderStepStates\(\)/)
  assert.match(script, /if \(status\.className\) button\?\.classList\.add\(status\.className\)/)
  assert.match(script, /adjustments: \{ label: elements\.adjustmentCount\?\.textContent \|\| '0', className: '' \}/)
  assert.match(script, /review: \{ label: state\.period\?\.period_status \|\| 'Draft', className: '' \}/)
  assert.match(script, /state\.loadSucceeded = false/)
  assert.match(script, /const failedRpcs = rpcResults\.filter/)
  assert.match(script, /state\.sectionErrors = new Map\(\)/)
  assert.match(script, /Payroll exceptions could not be loaded\. Refresh to try again\./)
  assert.match(script, /safePayrollRpc\('exceptions', 'payroll_get_period_exceptions'/)
  assert.match(script, /payroll_import_attendance/)
  assert.match(script, /payroll_calculate_employee_draft/)
  assert.match(script, /payroll_import_employee_attendance/)

  assert.match(styles, /\.payroll-stepper/)
  assert.match(styles, /\.payroll-calculation-table \{[\s\S]*?min-width: 980px/)
  assert.match(styles, /\.payroll-calculation-table th:nth-child\(8\) \{ width: 16%; \}/)
  assert.match(styles, /\.payroll-calculation-table \.payroll-row-action \{[\s\S]*?max-width: 145px/)
  assert.match(styles, /\.payroll-calculation-lines \{[\s\S]*?background: var\(--payroll-surface\)/)
  assert.match(styles, /\.payroll-step-panel\[hidden\]/)
  assert.match(styles, /max-height:min\(58vh,520px\)/)
  assert.match(styles, /\.payroll-stepper \{[\s\S]*?overflow-x:auto/)
  assert.match(styles, /@media \(max-width:700px\)[\s\S]*?\.payroll-step-copy small/)
  assert.match(page, /payroll-period\.js\?v=15/)
  assert.match(page, /id="payrollEmployeeSearch"/)
  assert.match(page, /id="payrollEmployeeSearchCount"/)
  assert.match(script, /payrollEmployeeSearch: ''/)
  assert.match(script, /calculation\.employee_name,\s*calculation\.employee_number,\s*calculation\.employee_email/)
  assert.match(script, /No employees match this search\./)
  assert.match(script, /elements\.calculatedGross\.textContent = formatMoney\(totals\.gross\)/)
  assert.match(script, /elements\.calculationSearch\.addEventListener\('input'/)
  assert.match(script, /async function safePayrollRpc\(name, rpcName, params\)/)
  assert.doesNotMatch(script, /supabase\.rpc\([^;]+\)\.catch\(/)
  assert.match(script, /function clearUnresolvedLoadingStates\(\)/)
  assert.match(script, /async function loadPeriodUnsafe\(\)/)
  assert.match(script, /async function loadPeriod\(\)/)
  assert.match(script, /state\.loading = false/)
})

test('initialization keeps authorized users on the page when frontend loading fails', async () => {
  const script = await read('scripts/payroll-period.js')

  assert.match(script, /catch \(error\) \{[\s\S]*?console\.error\('Payroll Period initialization failed\.', error\)[\s\S]*?setMessage\(/)
  assert.match(script, /async function loadPeriod\(\) \{[\s\S]*?catch \(error\) \{[\s\S]*?clearUnresolvedLoadingStates\(\)/)
  assert.match(script, /if \(!access\.authenticated\)[\s\S]*?window\.location\.replace\([\s\S]*?login\.html/)
  assert.match(script, /if \(!access\.allowed \|\| !hasProcessingAccess\(access\)\)[\s\S]*?window\.alert\([\s\S]*?window\.location\.replace\('\.\/home\.html'\)/)
})
