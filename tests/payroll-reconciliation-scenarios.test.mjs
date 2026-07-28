import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const verificationPath =
  'supabase/verification/payroll_prepaid_reconciliation_scenarios.sql'

test('prepaid reconciliation verification is rollback-only', async () => {
  const sql = await read(verificationPath)

  assert.match(sql, /raise exception[\s\S]*?errcode = 'ZX001'/)
  assert.match(sql, /exception\s+when sqlstate 'ZX001'/)
  assert.match(sql, /persistent_test_snapshots_should_be_zero/)
  assert.match(sql, /persistent_test_attendance_should_be_zero/)
})

test('exact and partial work scenarios assert their remaining balances', async () => {
  const sql = await read(verificationPath)

  assert.match(
    sql,
    /where source\.scenario = 'exact_match'[\s\S]*?v_settled <> 480 or v_remaining <> 0/
  )
  assert.match(
    sql,
    /where source\.scenario = 'partial_work'[\s\S]*?v_settled <> 300 or v_remaining <> 180/
  )
})

test('multi-day work settles one balance across three later allocations', async () => {
  const sql = await read(verificationPath)

  assert.match(
    sql,
    /where source\.scenario = 'multi_day_carry_forward'[\s\S]*?array\[180, 180, 120\]/
  )
  assert.match(
    sql,
    /order by attendance_snapshot\.work_date/
  )
})

test('regular time settles before both eligible overtime categories', async () => {
  const sql = await read(verificationPath)

  assert.match(
    sql,
    /where source\.scenario = 'overtime_settlement'[\s\S]*?v_regular <> 480[\s\S]*?v_pre_shift <> 60[\s\S]*?v_post_shift <> 60/
  )
  assert.match(sql, /minute_category = 'regular'/)
  assert.match(sql, /minute_category = 'pre_shift_overtime'/)
  assert.match(sql, /minute_category = 'post_shift_overtime'/)
})

test('rest-day and holiday attendance cannot settle prepaid debt', async () => {
  const sql = await read(verificationPath)

  assert.match(sql, /snapshot\.special_day_type in \('rest_day', 'holiday'\)/)
  assert.match(
    sql,
    /where source\.scenario = 'special_day_exclusion'[\s\S]*?v_settled <> 0[\s\S]*?v_remaining <> 480[\s\S]*?v_line_count <> 0/
  )
})
