import { formatPaypalPayout } from '../shared/payroll-v2-payslip-formatting.mjs'

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
  const currencyCode = saved?.currency_code || period?.currency_code || 'USD'
  const grossPay = saved?.gross_pay ?? 0
  const deductions = saved?.total_deductions ?? saved?.deductions?.approved_amount ?? 0
  const committedHours = {
    status: saved?.committed_hours?.status || 'No commitment required',
    monetary_effect: saved?.committed_hours?.monetary_effect ?? 0,
    snapshots: Array.isArray(saved?.committed_hours?.snapshots)
      ? saved.committed_hours.snapshots
      : []
  }
  return {
    employee: saved?.employee?.employee_name || '—',
    period: period ? `${period.period_start}–${period.period_end}` : '—',
    status: saved?.status || saved?.persistence?.record_status || 'Approved',
    paymentDate: period?.payment_date || null,
    calculatedAt: saved?.persistence?.calculated_at || null,
    approvedAt: saved?.persistence?.approved_at || null,
    totalPayableMinutes: saved?.total_payable_minutes ?? 0,
    attendanceEarnings: saved?.attendance_earnings ?? 0,
    paidLeaveEarnings: saved?.paid_leave_earnings ?? 0,
    committedHours,
    committedHoursEarnings: committedHours.monetary_effect ?? 0,
    manualEarnings: saved?.manual_earnings?.approved_amount ?? 0,
    grossPay,
    earningsSubtotal: grossPay,
    deductions,
    deductionsSubtotal: deductions,
    netPay: saved?.net_pay ?? 0,
    currencyCode,
    paypalConversionRate: period?.paypal_conversion_rate ?? null,
    paypalPayout: formatPaypalPayout(saved?.net_pay, currencyCode, period?.paypal_conversion_rate),
    rateBreakdown: Array.isArray(saved?.rate_breakdown) ? saved.rate_breakdown : [],
    items: Array.isArray(saved?.items) ? saved.items : []
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
