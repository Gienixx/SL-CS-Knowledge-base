import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../supabase/migrations/20260803130122_correct_stale_july_preplots_and_attendance.sql',
  import.meta.url
), 'utf8')

test('seven stale July prepaid snapshots are corrected from validated source windows', () => {
  const rows = [
    ['TRISTAN', 283, '2026, 7, 28, 22, 30', '2026, 7, 29, 14, 30'],
    ['AMOR', 284, '2026, 7, 29, 19, 0', '2026, 7, 30, 9, 0'],
    ['AREZ', 284, '2026, 7, 29, 8, 45', '2026, 7, 30, 2, 45'],
    ['AREZ', 285, '2026, 7, 30, 10, 0', '2026, 7, 31, 2, 0'],
    ['AMOR', 285, '2026, 7, 30, 21, 0', '2026, 7, 31, 5, 0'],
    ['JERSON', 285, '2026, 7, 30, 10, 30', '2026, 7, 31, 2, 30'],
    ['AREZ', 286, '2026, 7, 31, 14, 0', '2026, 8, 1, 2, 0']
  ]

  for (const [sheet, row, start, end] of rows) {
    assert.match(migration, new RegExp(
      `'${sheet}'::text[\\s\\S]*?${row},[\\s\\S]*?make_timestamptz\\(${start}, 0, 'America/New_York'\\)[\\s\\S]*?make_timestamptz\\(${end}, 0, 'America/New_York'\\)`
    ))
  }

  assert.match(migration, /v_old_prepaid\.settled_minutes <> 0/)
  assert.match(migration, /v_old_prepaid\.superseded_by_id <> v_new_prepaid\.id/)
  assert.match(migration, /'payroll_preplot_corrected'/)
  assert.match(migration, /validation-20260803/)
})

test('Arez July 31 is created with the confirmed following-day 2 AM logout', () => {
  assert.match(migration, /date '2026-07-31',[\s\S]*make_timestamptz\(2026, 7, 31, 14, 0, 0, 'America\/New_York'\)[\s\S]*make_timestamptz\(2026, 8, 1, 2, 0, 0, 'America\/New_York'\)/)
  assert.match(migration, /Completed Arez July 31 attendance/)
  assert.match(migration, /perform public\.workforce_recalculate_attendance|from public\.workforce_recalculate_attendance/)
})

test('Arby punches are preserved while the attendance moves to the July 27 rest-day schedule', () => {
  assert.match(migration, /make_timestamptz\(2026, 7, 26, 22, 0, 0, 'America\/New_York'\)/)
  assert.match(migration, /make_timestamptz\(2026, 7, 27, 18, 0, 0, 'America\/New_York'\)/)
  assert.match(migration, /schedule_id = v_arby_target_schedule\.id,[\s\S]*work_date = date '2026-07-27'/)
  assert.match(migration, /review_status = 'corrected'/)
  assert.match(migration, /'attendance_work_date_corrected'/)
  assert.doesNotMatch(migration, /update public\.attendance\s+set[\s\S]{0,500}(clock_in|clock_out)\s*=/i)
})
