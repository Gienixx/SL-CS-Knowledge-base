import { supabase } from './supabaseClient.js?v=11'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const recordId =
  new URLSearchParams(window.location.search).get('record') || ''
const printRequested =
  new URLSearchParams(window.location.search).get('print') === '1'

const elements = {
  message: document.getElementById('payslipPageMessage'),
  subtitle: document.getElementById('payslipPageSubtitle'),
  sheet: document.getElementById('payslipSheet'),
  backLink: document.getElementById('payslipBackLink'),
  refresh: document.getElementById('refreshPayslipButton'),
  generatePdf: document.getElementById('generatePayslipPdfButton'),
  downloadPdf: document.getElementById('downloadPayslipPdfButton'),
  print: document.getElementById('printPayslipButton'),
  ratesSection: document.getElementById('payslipRatesSection'),
  ratesRestricted: document.getElementById('payslipRatesRestricted'),
  ratesBody: document.getElementById('payslipRatesBody'),
  earningsBody: document.getElementById('payslipEarningsBody'),
  deductionsBody: document.getElementById('payslipDeductionsBody')
}

const state = {
  accessToken: '',
  canGeneratePdf: false,
  preview: null,
  pdfBusy: false,
  printStarted: false
}

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0))
}

function formatDate(value) {
  if (!value) return '—'
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

function formatDateTime(value) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('en-PH', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Manila'
    }).format(new Date(value))
  } catch {
    return '—'
  }
}

function formatHours(minutes) {
  const hours = Number(minutes || 0) / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2)}h`
}

function text(id, value) {
  const node = document.getElementById(id)
  if (node) node.textContent = value
}

function element(tag, className = '', value = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value) node.textContent = value
  return node
}

function setMessage(value = '', type = '') {
  elements.message.textContent = value
  elements.message.classList.toggle('error', type === 'error')
  elements.message.hidden = !value
}

function setPdfBusy(busy) {
  state.pdfBusy = busy
  elements.generatePdf.disabled = busy
  elements.downloadPdf.disabled = busy
  elements.refresh.disabled = busy
}

async function responseJson(response) {
  return response.json().catch(() => null)
}

function earningCategory(code) {
  if (code === 'regular_earnings') return 'Regular'
  if (code === 'prepaid_scheduled_earnings') return 'Prepaid schedule'
  if (['pre_shift_overtime', 'post_shift_overtime'].includes(code)) {
    return 'Overtime'
  }
  if (code.startsWith('rest_day_')) return 'Rest day'
  if (code.startsWith('holiday_')) return 'Holiday'
  if (code === 'manual_earning') return 'Manual earning'
  return 'Other earning'
}

function renderRates(rates, canViewRates) {
  elements.ratesSection.hidden = !canViewRates
  elements.ratesRestricted.hidden = canViewRates
  document.querySelectorAll('.payslip-rate-column').forEach(column => {
    column.hidden = !canViewRates
  })
  if (!canViewRates) return

  text(
    'payslipRateCount',
    `${rates.length} ${rates.length === 1 ? 'rate' : 'rates'}`
  )
  const fragment = document.createDocumentFragment()
  for (const rate of rates) {
    const row = document.createElement('tr')
    row.append(
      element('td', '', formatDate(rate.effective_date)),
      element('td', 'money', formatMoney(rate.hourly_rate)),
      element('td', 'money', formatMoney(rate.daily_rate)),
      element('td', 'money', formatMoney(rate.monthly_rate)),
      element('td', 'money', formatMoney(rate.overtime_rate)),
      element('td', 'money', formatMoney(rate.holiday_rate))
    )
    fragment.append(row)
  }
  if (!rates.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payslip-table-empty',
      'No rate detail was stored for this finalized payslip.'
    )
    cell.colSpan = 6
    row.append(cell)
    fragment.append(row)
  }
  elements.ratesBody.replaceChildren(fragment)
}

function renderEarnings(items, canViewRates) {
  const fragment = document.createDocumentFragment()
  for (const item of items) {
    const row = document.createElement('tr')
    const description = document.createElement('td')
    description.append(
      element('strong', '', item.description || 'Earning'),
      item.is_manual ? element('small', '', 'Manual earning') : document.createTextNode('')
    )
    const rate = element(
      'td',
      'money payslip-rate-column',
      item.unit_rate == null ? '—' : formatMoney(item.unit_rate)
    )
    rate.hidden = !canViewRates
    row.append(
      element('td', '', earningCategory(item.item_code || '')),
      description,
      element('td', '', formatDate(item.work_date)),
      element('td', 'money', item.quantity == null ? '—' : `${Number(item.quantity).toFixed(2)}h`),
      rate,
      element('td', 'money', formatMoney(item.amount))
    )
    fragment.append(row)
  }
  if (!items.length) {
    const row = document.createElement('tr')
    const cell = element('td', 'payslip-table-empty', 'No earnings.')
    cell.colSpan = canViewRates ? 6 : 5
    row.append(cell)
    fragment.append(row)
  }
  elements.earningsBody.replaceChildren(fragment)
}

function renderDeductions(items, canViewRates) {
  const fragment = document.createDocumentFragment()
  for (const item of items) {
    const row = document.createElement('tr')
    const description = document.createElement('td')
    description.append(
      element('strong', '', item.description || 'Deduction'),
      item.informational_only
        ? element('small', '', 'Informational only — already excluded from paid time')
        : item.is_manual
          ? element('small', '', 'Manual deduction')
          : document.createTextNode('')
    )
    const rate = element(
      'td',
      'money payslip-rate-column',
      item.unit_rate == null ? '—' : formatMoney(item.unit_rate)
    )
    rate.hidden = !canViewRates
    row.append(
      description,
      element('td', '', formatDate(item.work_date)),
      element('td', 'money', item.quantity == null ? '—' : `${Number(item.quantity).toFixed(2)}h`),
      rate,
      element('td', 'money', formatMoney(item.amount))
    )
    fragment.append(row)
  }
  if (!items.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payslip-table-empty',
      'No employee deductions for this payroll.'
    )
    cell.colSpan = canViewRates ? 5 : 4
    row.append(cell)
    fragment.append(row)
  }
  elements.deductionsBody.replaceChildren(fragment)
}

function renderPreview(preview) {
  const employee = preview.employee || {}
  const period = preview.period || {}
  const totals = preview.totals || {}
  const prepaid = preview.prepaid_summary || {}
  const approval = preview.approval || {}
  const rates = Array.isArray(preview.rates_used)
    ? preview.rates_used
    : []
  const earnings = Array.isArray(preview.earnings)
    ? preview.earnings
    : []
  const deductions = Array.isArray(preview.deductions)
    ? preview.deductions
    : []
  const pdf = preview.pdf || {}

  state.preview = preview

  document.title = `${employee.full_name || 'Employee'} Payslip | SocialLoop CS Base`
  elements.subtitle.textContent =
    `${employee.full_name || 'Employee'} · ${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
  text('payslipNumber', preview.payslip_number || '—')
  text('payslipEmployeeName', employee.full_name || '—')
  text('payslipEmployeeNumber', employee.employee_number || '—')
  text('payslipEmployeeEmail', employee.email || '—')
  text(
    'payslipPeriod',
    `${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
  )
  text('payslipPaymentDate', formatDate(period.payment_date))
  text('payslipCurrency', period.currency_code || 'USD')
  text(
    'payslipPdfStatus',
    pdf.generated
      ? `Private PDF stored${pdf.generated_at ? ` · ${formatDateTime(pdf.generated_at)}` : ''}`
      : 'PDF not generated'
  )

  renderRates(rates, Boolean(preview.can_view_rates))
  renderEarnings(earnings, Boolean(preview.can_view_rates))
  renderDeductions(deductions, Boolean(preview.can_view_rates))

  text('payslipPrepaidOpening', formatHours(prepaid.opening_minutes))
  text('payslipPrepaidAdded', formatHours(prepaid.added_minutes))
  text('payslipPrepaidApplied', formatHours(prepaid.applied_minutes))
  text('payslipPrepaidClosing', formatHours(prepaid.closing_minutes))

  text('payslipRegularTotal', formatMoney(totals.regular_earnings))
  text(
    'payslipPrepaidTotal',
    formatMoney(totals.prepaid_scheduled_earnings)
  )
  text(
    'payslipSpecialTotal',
    formatMoney(
      Number(totals.overtime_earnings || 0) +
        Number(totals.rest_day_earnings || 0) +
        Number(totals.holiday_earnings || 0)
    )
  )
  text('payslipOtherTotal', formatMoney(totals.other_earnings))
  text('payslipGrossTotal', formatMoney(totals.gross_pay))
  text('payslipDeductionTotal', formatMoney(totals.total_deductions))
  text('payslipNetTotal', formatMoney(totals.net_pay))

  text('payslipReviewedBy', approval.reviewed_by_name || '—')
  text('payslipReviewedAt', formatDateTime(approval.reviewed_at))
  text('payslipApprovedBy', approval.approved_by_name || '—')
  text('payslipApprovedAt', formatDateTime(approval.approved_at))
  text('payslipFinalizedBy', approval.finalized_by_name || '—')
  text('payslipFinalizedAt', formatDateTime(approval.finalized_at))

  elements.backLink.href =
    preview.viewer_scope === 'payroll' && period.payroll_period_id
      ? `./payroll-period.html?id=${encodeURIComponent(period.payroll_period_id)}`
      : './my-payslips.html'
  elements.backLink.textContent =
    preview.viewer_scope === 'payroll'
      ? '← Payroll period'
      : '← My payslips'
  elements.sheet.hidden = false
  elements.print.hidden = false
  elements.generatePdf.hidden = !state.canGeneratePdf
  elements.generatePdf.textContent = pdf.generated
    ? 'Generate new PDF version'
    : 'Generate PDF'
  elements.downloadPdf.hidden = !pdf.generated
  setMessage()

  if (printRequested && !state.printStarted) {
    state.printStarted = true
    window.requestAnimationFrame(() => window.print())
  }
}

async function loadPayslip() {
  elements.refresh.disabled = true
  elements.print.disabled = true
  setMessage('Loading finalized payslip preview…')

  const { data, error } = await supabase.rpc(
    'payroll_get_payslip_preview',
    { p_payroll_record_id: recordId }
  )

  elements.refresh.disabled = false
  elements.print.disabled = false
  if (error) {
    elements.sheet.hidden = true
    elements.print.hidden = true
    setMessage(
      error.message || 'The finalized payslip could not be loaded.',
      'error'
    )
    return
  }
  renderPreview(data || {})
}

async function generatePdf() {
  if (state.pdfBusy || !state.canGeneratePdf || !state.accessToken) return

  if (
    state.preview?.pdf?.generated &&
    !window.confirm(
      'Generate a new immutable PDF version for this finalized payslip?'
    )
  ) {
    return
  }

  setPdfBusy(true)
  setMessage('Generating and storing the private A4 payslip PDF…')
  try {
    const response = await fetch('./api/payslips/generate', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payrollRecordId: recordId }),
      cache: 'no-store'
    })
    const result = await responseJson(response)

    if (!response.ok) {
      throw new Error(
        result?.error || 'The payslip PDF could not be generated.'
      )
    }

    setMessage(
      `Private PDF version ${result.documentVersion} was generated successfully.`
    )
    await loadPayslip()
  } catch (error) {
    setMessage(
      error?.message || 'The payslip PDF could not be generated.',
      'error'
    )
  } finally {
    setPdfBusy(false)
  }
}

async function downloadPdf() {
  if (state.pdfBusy || !state.accessToken) return

  setPdfBusy(true)
  setMessage('Creating a temporary private download…')
  try {
    const response = await fetch('./api/payslips/signed-url', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payrollRecordId: recordId }),
      cache: 'no-store'
    })
    const result = await responseJson(response)

    if (!response.ok || !result?.signedUrl) {
      throw new Error(
        result?.error || 'The temporary PDF download is unavailable.'
      )
    }

    setMessage(
      `Opening private PDF version ${result.documentVersion}. The link expires in ${result.expiresIn} seconds.`
    )
    window.location.assign(result.signedUrl)
  } catch (error) {
    setMessage(
      error?.message || 'The temporary PDF download is unavailable.',
      'error'
    )
  } finally {
    setPdfBusy(false)
  }
}

async function initialize() {
  if (!isValidUuid(recordId)) {
    window.location.replace('./payroll-dashboard.html')
    return
  }
  try {
    const access = await loadCurrentWorkforceAccess(supabase)
    if (!access.authenticated) {
      window.location.replace(
        `./login.html?returnTo=${encodeURIComponent(`payslip-preview.html?record=${recordId}`)}`
      )
      return
    }
    state.accessToken = access.session?.access_token || ''
    state.canGeneratePdf = hasWorkforcePermission(
      access,
      'export_payslips'
    )
    document.body.classList.remove('payslip-access-pending')
    await loadPayslip()
  } catch {
    document.body.classList.remove('payslip-access-pending')
    setMessage(
      'The payslip preview could not be opened. Sign in again or contact a payroll administrator.',
      'error'
    )
  }
}

elements.refresh.addEventListener('click', loadPayslip)
elements.generatePdf.addEventListener('click', generatePdf)
elements.downloadPdf.addEventListener('click', downloadPdf)
elements.print.addEventListener('click', () => window.print())

initialize()
