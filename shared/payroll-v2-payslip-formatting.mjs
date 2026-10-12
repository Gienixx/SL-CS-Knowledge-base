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
