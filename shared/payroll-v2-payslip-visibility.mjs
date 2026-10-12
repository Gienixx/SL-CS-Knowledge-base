export function isVisiblePayrollV2Payslip(payslip) {
  const status = String(payslip?.status || '').trim().toLowerCase()
  if (status === 'finalized') return true
  if (status !== 'approved') return false

  return payslip?.recalculation_pending !== true
    && !payslip?.recalculation_pending_at
    && !payslip?.recalculation_pending_by
    && !payslip?.recalculation_pending_reason
}
