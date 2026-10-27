import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/20261027115912_workforce_committed_hours_list_all_targets.sql')

function listTargets({ summary, commitments, profiles, startDate, endDate, employeeUserId = null, teamId = null }) {
  const candidates = [
    ...(summary.payroll_targets || []).map(value => ({ value, sourcePriority: 0 })),
    ...(summary.days || []).flatMap(day => (day.targets || [])
      .filter(target => target.work_date >= startDate && target.work_date <= endDate)
      .map(value => ({ value, sourcePriority: 1 })))
  ]
  const uniqueTargets = new Map()
  for (const candidate of candidates) {
    const commitmentId = candidate.value.commitment_id
    if (!commitmentId) continue
    const existing = uniqueTargets.get(commitmentId)
    if (!existing || candidate.sourcePriority < existing.sourcePriority) {
      uniqueTargets.set(commitmentId, candidate)
    }
  }

  return [...uniqueTargets.values()].flatMap(({ value }) => {
    const commitment = commitments.find(item => item.id === value.commitment_id && item.superseded_at == null)
    const profile = profiles.find(item => item.user_id === commitment?.employee_id)
    if (!commitment || !profile || !profile.is_agent || !['active', 'on_leave'].includes(profile.employment_status)) return []
    if (value.work_date < startDate || value.work_date > endDate) return []
    if (employeeUserId && profile.user_id !== employeeUserId) return []
    if (teamId && profile.team_id !== teamId) return []
    return [{ profile, commitment, target: value }]
  }).sort((left, right) => left.target.work_date.localeCompare(right.target.work_date))
}

test('list RPC includes per-day FIFO targets missing from payroll_targets', () => {
  const row = {
    commitment_id: 'arby-oct27',
    work_date: '2026-10-27',
    expected_minutes: 1080,
    credited_minutes: 0,
    remaining_minutes: 1080,
    attendance_sources: []
  }
  const result = listTargets({
    summary: { payroll_targets: [], days: [{ work_date: '2026-10-27', targets: [row] }] },
    commitments: [{ id: 'arby-oct27', employee_id: 'arby-user', expected_minutes: 1080, work_date: '2026-10-27', superseded_at: null }],
    profiles: [{ user_id: 'arby-user', is_agent: true, employment_status: 'active', team_id: 'support' }],
    startDate: '2026-10-16',
    endDate: '2026-10-31',
    employeeUserId: 'arby-user'
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].profile.user_id, 'arby-user')
  assert.equal(result[0].commitment.work_date, '2026-10-27')
  assert.equal(result[0].target.expected_minutes, 1080)
  assert.equal(result[0].target.remaining_minutes, 1080)
  assert.deepEqual(result[0].target.attendance_sources, [])
})

test('range and employee filters apply to daily targets and payroll targets take precedence on duplicates', () => {
  const daily = (id, date) => ({ commitment_id: id, work_date: date, expected_minutes: 60, remaining_minutes: 60 })
  const result = listTargets({
    summary: {
      payroll_targets: [{ ...daily('in-range', '2026-10-20'), covered_minutes: 15, carryover_minutes: 5 }],
      days: [{ work_date: '2026-10-20', targets: [daily('in-range', '2026-10-20'), daily('before-range', '2026-10-15'), daily('other-agent', '2026-10-20')] }]
    },
    commitments: [
      { id: 'in-range', employee_id: 'arby-user', work_date: '2026-10-20', superseded_at: null },
      { id: 'before-range', employee_id: 'arby-user', work_date: '2026-10-15', superseded_at: null },
      { id: 'other-agent', employee_id: 'other-user', work_date: '2026-10-20', superseded_at: null }
    ],
    profiles: [
      { user_id: 'arby-user', is_agent: true, employment_status: 'active', team_id: 'support' },
      { user_id: 'other-user', is_agent: true, employment_status: 'active', team_id: 'sales' }
    ],
    startDate: '2026-10-16',
    endDate: '2026-10-31',
    employeeUserId: 'arby-user',
    teamId: 'support'
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].target.covered_minutes, 15)
  assert.equal(result[0].target.carryover_minutes, 5)
})

test('superseded commitments are omitted from the visible target list', () => {
  const result = listTargets({
    summary: { payroll_targets: [], days: [{ targets: [{ commitment_id: 'replaced', work_date: '2026-10-27', expected_minutes: 60, remaining_minutes: 60 }] }] },
    commitments: [{ id: 'replaced', employee_id: 'arby-user', work_date: '2026-10-27', superseded_at: '2026-10-28T00:00:00Z' }],
    profiles: [{ user_id: 'arby-user', is_agent: true, employment_status: 'active', team_id: 'support' }],
    startDate: '2026-10-16',
    endDate: '2026-10-31'
  })
  assert.deepEqual(result, [])
})

test('migration keeps the secure RPC contract and adds only read-side target expansion', () => {
  assert.match(migration, /create or replace function public\.workforce_admin_list_committed_hours\s*\(/i)
  assert.match(migration, /language plpgsql\s+stable\s+security definer\s+set search_path to ''/i)
  assert.match(migration, /public\.workforce_current_user_is_active\(\)/)
  assert.match(migration, /public\.workforce_has_permission\('manage_employees'\)/)
  assert.match(migration, /public\.workforce_can_manage_user\(profile\.user_id, 'manage_employees'\)/)
  assert.match(migration, /jsonb_array_elements\([\s\S]*?summary\.value -> 'payroll_targets'/)
  assert.match(migration, /jsonb_array_elements\([\s\S]*?summary\.value -> 'days'/)
  assert.match(migration, /day\.value -> 'targets'/)
  assert.match(migration, /distinct on \(candidate\.value ->> 'commitment_id'\)/)
  assert.match(migration, /candidate\.source_priority/)
  assert.match(migration, /commitment\.superseded_at is null/)
  assert.match(migration, /profile\.user_id = p_employee_user_id/)
  assert.match(migration, /profile\.team_id = p_team_id/)
  assert.doesNotMatch(migration, /\b(insert\s+into|update\s+public\.|delete\s+from)\b/i)
})

test('commitment save uses the selected profile ID and refreshes the filtered table after success', async () => {
  const script = await read('scripts/workforce-committed-hours.js')
  assert.match(script, /p_employee_user_id:\s*elements\.employee\.value/)
  assert.match(script, /p_work_date:\s*elements\.workDate\.value/)
  assert.match(script, /p_expected_minutes:\s*expectedMinutes/)
  assert.match(script, /const expectedMinutes = Math\.round\(targetHours \* 60\)/)
  assert.match(script, /await loadRows\(\)/)
  assert.match(script, /elements\.refreshButton\.addEventListener\('click', loadRows\)/)
  assert.match(script, /elements\.tableBody\.replaceChildren\(fragment\)/)
  assert.match(script, /`\$\{rows\.length\} target\$\{rows\.length === 1 \? '' : 's'\} shown\./)
})
