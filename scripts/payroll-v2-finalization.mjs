export function canFinalizeEmployeeAction(persistence, context = {}) {
  return Boolean(
    persistence?.saved === true
    && String(persistence.record_status || '').toLowerCase() === 'approved'
    && persistence.payroll_v2_record_id
    && persistence.approved_at
    && persistence.approved_by
    && context.canFinalize === true
    && context.recalculationPending !== true
    && String(context.periodStatus || '').toLowerCase() !== 'void'
  )
}

export function finalizeEmployeeSummary(saved, period) {
  return {
    employee: saved?.employee?.employee_name || '—',
    period: period ? `${period.period_start}–${period.period_end}` : '—',
    paymentDate: period?.payment_date || null,
    calculatedAt: saved?.persistence?.calculated_at || null,
    approvedAt: saved?.persistence?.approved_at || null,
    totalPayableMinutes: saved?.total_payable_minutes ?? 0,
    attendanceEarnings: saved?.attendance_earnings ?? 0,
    paidLeaveEarnings: saved?.paid_leave_earnings ?? 0,
    committedHoursEarnings: saved?.committed_hours?.monetary_effect ?? 0,
    manualEarnings: saved?.manual_earnings?.approved_amount ?? 0,
    grossPay: saved?.gross_pay ?? 0,
    deductions: saved?.deductions?.approved_amount ?? saved?.total_deductions ?? 0,
    netPay: saved?.net_pay ?? 0
  }
}

export async function submitEmployeeFinalization(recordId, state, finalize) {
  if (!recordId || state.finalizing) return { skipped: true }

  state.finalizing = true
  try {
    return await finalize(recordId)
  } catch (error) {
    return { error }
  } finally {
    state.finalizing = false
  }
}
