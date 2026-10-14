export function formatPayrollWorkDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').slice(0, 10))
  return match ? `${match[2]}/${match[3]}/${match[1]}` : '—'
}

export function formatPayrollHours(minutes) {
  if (minutes == null) return '—'
  const hours = Number(minutes) / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2)}h`
}

export function formatPayrollMoney(value, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0))
}

export function payrollV2ItemGroup(item) {
  return String(item?.item_type || '').toLowerCase() === 'deduction'
    ? 'deductions'
    : 'earnings'
}

export function payrollV2ItemTypeLabel(item) {
  const type = String(item?.item_type || '').toLowerCase()
  const description = String(item?.description || '').toLowerCase()
  if (type === 'attendance') return 'Attendance'
  if (type === 'committed_hours') return 'Committed Hours'
  if (type === 'paid_leave') return 'Paid VL'
  if (type === 'manual_earning' || type === 'bonus') {
    return /\bbonus\b/.test(description) || type === 'bonus' ? 'Bonus' : 'Manual Earnings'
  }
  if (type === 'deduction') {
    if (/cash\s+advance/.test(description)) return 'Cash Advance'
    if (/hour\s+offset/.test(description)) return 'Hour Offset'
    if (/previous\s+cutoff|prior\s+cutoff|committed hours shortfall/.test(description)) {
      return 'Previous Cutoff Shortfall'
    }
    return 'Other deduction'
  }
  return String(item?.item_type || 'Payroll item').replaceAll('_', ' ')
}

export function calculatePaypalPayout(netPay, payrollCurrencyCode, conversionRate) {
  if (netPay === null || netPay === undefined || String(netPay).trim() === '') return null
  const net = Number(netPay)
  const rate = Number(conversionRate)
  if (String(payrollCurrencyCode || '').toUpperCase() !== 'USD'
      || !Number.isFinite(net) || !Number.isFinite(rate) || rate <= 0) return null
  return Math.round((net * rate + Number.EPSILON) * 100) / 100
}

export function formatPaypalPayout(netPay, payrollCurrencyCode, conversionRate) {
  const converted = calculatePaypalPayout(netPay, payrollCurrencyCode, conversionRate)
  return converted === null
    ? '—'
    : new Intl.NumberFormat('en-PH', {
        style: 'currency',
        currency: 'PHP',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(converted)
}

export function formatPayrollV2HourlyRate(items, currencyCode = 'USD') {
  const savedRates = [...new Set(
    (Array.isArray(items) ? items : [])
      .filter(item => String(item?.item_type || '').toLowerCase() === 'attendance')
      .filter(item => item?.rate != null && item.rate !== '')
      .map(item => Number(item?.rate))
      .filter(Number.isFinite)
      .map(rate => rate.toFixed(2))
  )]

  if (savedRates.length !== 1) return savedRates.length > 1 ? 'Varies' : '—'
  return formatPayrollMoney(Number(savedRates[0]), currencyCode)
}

function attendanceDescription(classification) {
  if (!classification) return '—'
  const normalized = String(classification).replace(/[^a-z]/gi, '').toLowerCase()
  return normalized.includes('restday') || normalized.includes('rdot')
    ? 'RDOT'
    : 'Regular'
}

export function createPayrollV2PayslipRow(item, attendanceSnapshot, currencyCode) {
  const isAttendance = String(item.item_type || '').toLowerCase() === 'attendance'
  const amount = Number(item.amount || 0)
  const isDeduction = String(item.item_type || '').toLowerCase() === 'deduction'

  return {
    description: isAttendance
      ? attendanceDescription(attendanceSnapshot?.classification)
      : item.description || 'Payroll item',
    date: isAttendance ? formatPayrollWorkDate(item.work_date) : '—',
    regular: isAttendance
      ? formatPayrollHours(attendanceSnapshot?.regular_minutes)
      : '—',
    additional: isAttendance
      ? formatPayrollHours(attendanceSnapshot?.additional_minutes)
      : '—',
    total: isAttendance
      ? formatPayrollHours(attendanceSnapshot?.payable_minutes)
      : '—',
    rate: isAttendance && item.rate != null
      ? `${formatPayrollMoney(item.rate, currencyCode)}/h`
      : '—',
    amount: isDeduction
      ? `−${formatPayrollMoney(Math.abs(amount), currencyCode)}`
      : formatPayrollMoney(amount, currencyCode)
  }
}
