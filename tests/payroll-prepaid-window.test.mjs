import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260826170750_expand_prepaid_eligibility_window.sql'

function addCalendarDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function isEligible(cutoff, workDate) {
  const start = addCalendarDays(cutoff, -10)
  return workDate >= start && workDate <= cutoff
}

test('prepaid date boundaries are inclusive at ten days before cutoff and cutoff date', () => {
  const cutoff = '2026-09-30'

  assert.equal(isEligible(cutoff, addCalendarDays(cutoff, -10)), true)
  assert.equal(isEligible(cutoff, addCalendarDays(cutoff, -9)), true)
  assert.equal(isEligible(cutoff, addCalendarDays(cutoff, -11)), false)
  assert.equal(isEligible(cutoff, cutoff), true)
})

test('backend single and bulk paths use the shared ten-day cutoff boundary', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_prepaid_eligibility_start\(\s*p_period_end date\s*\)[\s\S]*?select p_period_end - 10/
  )
  assert.equal((migration.match(/chr\(13\)/g) || []).length, 4)
  assert.match(migration, /E'    3,\\n    v_override_reason,'/)
  assert.match(
    migration,
    /payroll_get_preplot_candidates\(uuid\)[\s\S]*?schedule\.shift_date > v_period\.payment_date[\s\S]*?schedule\.shift_date >= public\.payroll_prepaid_eligibility_start\(v_period\.period_end\)/
  )
  assert.match(
    migration,
    /payroll_approve_preplots\(uuid,uuid\[\],text\)[\s\S]*?schedule\.shift_date <= v_period\.payment_date[\s\S]*?schedule\.shift_date < public\.payroll_prepaid_eligibility_start\(v_period\.period_end\)/
  )
  assert.match(
    migration,
    /payroll_save_and_approve_prepaid_schedule\(uuid,uuid,date,time without time zone,time without time zone,text,text,boolean\)[\s\S]*?p_work_date <= v_period\.payment_date[\s\S]*?p_work_date < public\.payroll_prepaid_eligibility_start\(v_period\.period_end\)/
  )
})

test('frontend date boundaries and messages match the backend window', async () => {
  const [periodScript, periodPage, dashboardScript, dashboardPage] =
    await Promise.all([
      read('scripts/payroll-period.js'),
      read('payroll-period.html'),
      read('scripts/payroll-dashboard.js'),
      read('payroll-dashboard.html')
    ])

  assert.match(periodScript, /const PREPAID_ELIGIBILITY_WINDOW_DAYS = 10/)
  assert.match(
    periodScript,
    /function prepaidEligibilityStart\(periodEnd\)[\s\S]*?addCalendarDays\(periodEnd, -PREPAID_ELIGIBILITY_WINDOW_DAYS\)/
  )
  assert.match(periodScript, /prepaidDate\.min = prepaidEligibilityStart\(state\.period\.period_end\)/)
  assert.match(periodPage, /within 10 calendar days before the payroll cutoff, through the cutoff date/)
  assert.match(periodPage, /10-calendar-day prepaid window/)
  assert.match(dashboardScript, /const STANDARD_EARLY_PAYMENT_DAYS = 10/)
  assert.match(dashboardPage, /up to 10 calendar days early/)
})
