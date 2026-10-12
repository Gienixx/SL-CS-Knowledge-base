const completedStatuses = new Set(['approved', 'finalized'])

export function visibleCompletedPayslips(rows) {
  return (Array.isArray(rows) ? rows : []).filter(record =>
    completedStatuses.has(String(record?.status || '').trim().toLowerCase())
      && Boolean(String(record?.payroll_v2_record_id || '').trim())
  )
}
