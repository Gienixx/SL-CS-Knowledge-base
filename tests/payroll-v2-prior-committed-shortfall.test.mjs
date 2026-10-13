import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261013120000_reconcile_payroll_v2_prior_committed_shortfall.sql', import.meta.url), 'utf8')

function reconcile({ currentPeriod, priorPeriod, targets, snapshots, paidItems, existingDeductions = new Set() }) {
  if (!currentPeriod || currentPeriod.status === 'void' || currentPeriod.end < '2026-10-01') return []
  if (!priorPeriod || priorPeriod.status === 'void') return []

  const rows = snapshots.flatMap(snapshot => {
    const target = targets.find(candidate => candidate.commitment_id === snapshot.commitment_source_id)
    if (!target) return []
    const paid = paidItems.filter(item => item.commitment_source_id === snapshot.commitment_source_id)
    const minutes = paid.length === 1 ? Math.min(Math.max(target.remaining_minutes, 0), Math.max(paid[0].minutes, 0)) : 0
    if (minutes <= 0 || !paid[0]?.rate || paid[0].rate <= 0) return []
    if (existingDeductions.has(snapshot.commitment_source_id)) return []
    return [{ commitment_source_id: snapshot.commitment_source_id, minutes, amount: Math.round((minutes / 60 * paid[0].rate + Number.EPSILON) * 100) / 100, currency: paid[0].currency ?? 'USD' }]
  })
  if (new Set(rows.map(row => row.currency)).size > 1) return []
  return rows
}

test('prior cutoff deduction uses live FIFO coverage matched to original commitment IDs', () => {
  assert.match(migration, /payroll_get_expected_committed_hours_summary\s*\(/)
  assert.match(migration, /target\.value ->> 'commitment_id' = snapshot\.commitment_source_id::text/)
  assert.match(migration, /live\.target ->> 'remaining_minutes'/)
  assert.match(migration, /least\(source\.remaining_minutes, greatest\(source\.paid_minutes, 0\)\)/)
  assert.match(migration, /source_attendance_ids/)
  assert.match(migration, /attendance_sources/)
  assert.match(migration, /'covered_minutes'/)
})

test('late approvals reconcile stale September snapshots to the verified 1,800-minute shortfall', () => {
  const snapshots = Array.from({ length: 27 }, (_, index) => ({
    commitment_source_id: `commitment-${index + 1}`,
    stale_remaining_minutes: index < 2 ? 900 : index < 22 ? 725 : 724
  }))
  assert.equal(snapshots.reduce((sum, item) => sum + item.stale_remaining_minutes, 0), 19_920)

  const targets = snapshots.map((snapshot, index) => ({
    commitment_id: snapshot.commitment_source_id,
    remaining_minutes: index < 2 ? 900 : 0,
    covered_minutes: index < 2 ? 0 : snapshot.stale_remaining_minutes,
    source_attendance_ids: index < 2 ? [] : [`attendance-${index + 1}`]
  }))
  const paidItems = snapshots.map((snapshot, index) => ({
    commitment_source_id: snapshot.commitment_source_id,
    minutes: snapshot.stale_remaining_minutes,
    rate: index === 0 ? 3.7 : index === 1 ? 3.75 : 3.5,
    currency: 'USD'
  }))
  const rows = reconcile({
    currentPeriod: { start: '2026-10-01', end: '2026-10-15', status: 'draft' },
    priorPeriod: { start: '2026-09-16', end: '2026-09-30', status: 'draft' },
    targets,
    snapshots,
    paidItems
  })

  assert.equal(targets.reduce((sum, item) => sum + item.covered_minutes, 0), 18_120)
  assert.equal(rows.reduce((sum, item) => sum + item.minutes, 0), 1_800)
  assert.deepEqual(rows.map(({ minutes, amount }) => ({ minutes, amount })), [
    { minutes: 900, amount: 55.5 },
    { minutes: 900, amount: 56.25 }
  ])
})

test('full and partial fulfillment are capped by original paid minutes and priced at original rates', () => {
  const snapshots = [
    { commitment_source_id: 'full' },
    { commitment_source_id: 'partial' },
    { commitment_source_id: 'paid-cap' }
  ]
  const rows = reconcile({
    currentPeriod: { end: '2026-10-15', status: 'draft' },
    priorPeriod: { status: 'approved' },
    snapshots,
    targets: [
      { commitment_id: 'full', remaining_minutes: 0 },
      { commitment_id: 'partial', remaining_minutes: 30 },
      { commitment_id: 'paid-cap', remaining_minutes: 90 }
    ],
    paidItems: [
      { commitment_source_id: 'full', minutes: 60, rate: 4 },
      { commitment_source_id: 'partial', minutes: 60, rate: 6 },
      { commitment_source_id: 'paid-cap', minutes: 45, rate: 8 }
    ]
  })
  assert.deepEqual(rows, [
    { commitment_source_id: 'partial', minutes: 30, amount: 3, currency: 'USD' },
    { commitment_source_id: 'paid-cap', minutes: 45, amount: 6, currency: 'USD' }
  ])
})

test('FIFO attribution follows commitment source IDs and never substitutes a date match', () => {
  const rows = reconcile({
    currentPeriod: { end: '2026-10-15', status: 'draft' },
    priorPeriod: { status: 'approved' },
    snapshots: [{ commitment_source_id: 'first' }, { commitment_source_id: 'second' }, { commitment_source_id: 'missing' }],
    targets: [
      { commitment_id: 'first', work_date: '2026-09-20', remaining_minutes: 15 },
      { commitment_id: 'second', work_date: '2026-09-20', remaining_minutes: 45 }
    ],
    paidItems: [
      { commitment_source_id: 'first', minutes: 60, rate: 4 },
      { commitment_source_id: 'second', minutes: 60, rate: 8 },
      { commitment_source_id: 'missing', minutes: 60, rate: 2 }
    ]
  })
  assert.deepEqual(rows.map(({ commitment_source_id, minutes }) => ({ commitment_source_id, minutes })), [
    { commitment_source_id: 'first', minutes: 15 },
    { commitment_source_id: 'second', minutes: 45 }
  ])
})

test('cutoff boundaries, void or missing periods, duplicates, and unsafe rates fail closed', () => {
  const base = {
    snapshots: [{ commitment_source_id: 'one' }],
    targets: [{ commitment_id: 'one', remaining_minutes: 60 }],
    paidItems: [{ commitment_source_id: 'one', minutes: 60, rate: 10 }]
  }
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-09-30', status: 'draft' }, priorPeriod: { status: 'draft' } }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'void' }, priorPeriod: { status: 'draft' } }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'draft' } }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'draft' }, priorPeriod: { status: 'void' } }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'draft' }, priorPeriod: { status: 'approved' }, existingDeductions: new Set(['one']) }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'draft' }, priorPeriod: { status: 'approved' }, paidItems: [{ ...base.paidItems[0], rate: null }] }), [])
  assert.deepEqual(reconcile({ ...base, currentPeriod: { end: '2026-10-15', status: 'draft' }, priorPeriod: { status: 'approved' }, paidItems: [...base.paidItems, { ...base.paidItems[0] }] }), [])
  assert.deepEqual(reconcile({
    ...base,
    currentPeriod: { end: '2026-10-15', status: 'draft' },
    priorPeriod: { status: 'approved' },
    snapshots: [{ commitment_source_id: 'one' }, { commitment_source_id: 'two' }],
    targets: [{ commitment_id: 'one', remaining_minutes: 60 }, { commitment_id: 'two', remaining_minutes: 60 }],
    paidItems: [{ commitment_source_id: 'one', minutes: 60, rate: 10, currency: 'USD' }, { commitment_source_id: 'two', minutes: 60, rate: 10, currency: 'PHP' }]
  }), [])
})

test('SQL stays read-only and preserves approval, finalization, service-role, and duplicate guards', () => {
  assert.match(migration, /language plpgsql\s+stable\s+security definer/i)
  assert.doesNotMatch(migration, /\b(insert\s+into|update\s+public\.|delete\s+from)\b/i)
  assert.match(migration, /record\.status <> 'void'/)
  assert.match(migration, /revoke all on function public\.payroll_v2_prior_committed_hours_shortfall\(uuid, uuid\) from public/i)
  assert.match(migration, /grant all on function public\.payroll_v2_prior_committed_hours_shortfall\(uuid, uuid\) to service_role/i)
  assert.match(migration, /source_snapshots', v_source_rows/)
})
