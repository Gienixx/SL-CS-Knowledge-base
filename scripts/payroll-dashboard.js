import { supabase } from './supabaseClient.js?v=10'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const PROCESS_PERMISSIONS = [
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'reopen_payroll'
]

const state = {
  periods: [],
  canCreate: false,
  loading: false,
  checkingOverlap: false,
  overlapRows: [],
  overlapSequence: 0
}

const elements = {
  message: document.getElementById('payrollDashboardMessage'),
  createCard: document.getElementById('createPayrollPeriodCard'),
  form: document.getElementById('createPayrollPeriodForm'),
  start: document.getElementById('payrollPeriodStart'),
  end: document.getElementById('payrollPeriodEnd'),
  payment: document.getElementById('payrollPaymentDate'),
  createButton: document.getElementById('createPayrollPeriodButton'),
  overlap: document.getElementById('payrollOverlapResult'),
  list: document.getElementById('payrollPeriodList'),
  refresh: document.getElementById('refreshPayrollDashboardButton'),
  agentRatesLink: document.getElementById('payrollAgentRatesLink')
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function formatDate(value) {
  return value ? dateFormatter.format(new Date(`${value}T00:00:00`)) : '—'
}

function setMessage(message = '', type = '') {
  elements.message.textContent = message
  elements.message.classList.toggle('error', type === 'error')
  elements.message.classList.toggle('success', type === 'success')
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function statusLabel(status) {
  return String(status || 'draft').replaceAll('_', ' ')
}

function hasProcessingAccess(access) {
  return PROCESS_PERMISSIONS.some(permission =>
    hasWorkforcePermission(access, permission)
  )
}

function renderMetrics() {
  document.getElementById('payrollPeriodCount').textContent = state.periods.length
  document.getElementById('payrollDraftCount').textContent =
    state.periods.filter(period => period.period_status === 'draft').length
  document.getElementById('payrollReviewCount').textContent =
    state.periods.filter(period =>
      ['review', 'approved', 'reopened'].includes(period.period_status)
    ).length
  document.getElementById('payrollFinalizedCount').textContent =
    state.periods.filter(period => period.period_status === 'finalized').length
}

function renderPeriods() {
  const count = document.getElementById('payrollPeriodListCount')
  count.textContent =
    `${state.periods.length} ${state.periods.length === 1 ? 'period' : 'periods'}`

  if (!state.periods.length) {
    elements.list.replaceChildren(
      element('p', 'payroll-empty', 'No payroll periods have been created yet.')
    )
    return
  }

  const fragment = document.createDocumentFragment()

  for (const period of state.periods) {
    const row = element('a', 'payroll-period-row')
    row.href = `./payroll-period.html?id=${encodeURIComponent(period.payroll_period_id)}`

    const dates = element('div')
    dates.append(
      element(
        'strong',
        '',
        `${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
      ),
      element('small', '', `Payment ${formatDate(period.payment_date)}`)
    )

    const employees = element('div', 'payroll-period-meta')
    employees.append(
      element('span', '', `${Number(period.employee_count || 0)} employees`),
      element(
        'small',
        '',
        `${Number(period.ready_record_count || 0)} ready · ${Number(period.exception_record_count || 0)} exceptions`
      )
    )

    const currency = element('div', 'payroll-period-meta')
    currency.append(
      element('span', '', period.currency_code || 'USD'),
      element(
        'small',
        '',
        Number(period.requires_recalculation_count || 0)
          ? `${period.requires_recalculation_count} need recalculation`
          : 'No recalculation flags'
      )
    )

    const badge = element(
      'span',
      `payroll-status-badge ${period.period_status}`,
      statusLabel(period.period_status)
    )

    row.append(dates, employees, currency, badge)
    fragment.append(row)
  }

  elements.list.replaceChildren(fragment)
}

function renderAll() {
  renderMetrics()
  renderPeriods()
}

async function loadPeriods() {
  if (state.loading) return
  state.loading = true
  elements.refresh.disabled = true
  setMessage('Loading payroll periods…')

  const { data, error } = await supabase.rpc('payroll_get_period_dashboard')

  state.loading = false
  elements.refresh.disabled = false

  if (error) {
    setMessage(
      'Payroll periods could not be loaded. Please refresh or contact a system administrator.',
      'error'
    )
    return
  }

  state.periods = data || []
  renderAll()
  setMessage('')
}

function periodPayload() {
  return {
    p_period_start: elements.start.value,
    p_period_end: elements.end.value
  }
}

function validateDates({ includePayment = false } = {}) {
  const start = elements.start.value
  const end = elements.end.value
  const payment = elements.payment.value

  if (!start || !end) return 'Select the payroll start and end dates.'
  if (end < start) return 'Payroll end date cannot be before the start date.'
  if (includePayment && !payment) return 'Select the payment date.'
  if (includePayment && payment < end) {
    return 'Payment date cannot be before the payroll end date.'
  }
  return ''
}

function renderOverlap() {
  elements.createButton.disabled =
    !state.canCreate ||
    state.loading ||
    state.checkingOverlap ||
    state.overlapRows.length > 0

  if (!elements.start.value || !elements.end.value) {
    elements.overlap.className = 'payroll-overlap-result neutral'
    elements.overlap.textContent =
      'Select a start and end date to check for overlapping payroll periods.'
    return
  }

  const validationMessage = validateDates()
  if (validationMessage) {
    elements.overlap.className = 'payroll-overlap-result blocked'
    elements.overlap.textContent = validationMessage
    return
  }

  if (state.checkingOverlap) {
    elements.overlap.className = 'payroll-overlap-result neutral'
    elements.overlap.textContent = 'Checking existing payroll periods…'
    return
  }

  if (state.overlapRows.length) {
    const overlap = state.overlapRows[0]
    elements.overlap.className = 'payroll-overlap-result blocked'
    elements.overlap.textContent =
      `Overlap found: ${formatDate(overlap.period_start)} through ${formatDate(overlap.period_end)} (${statusLabel(overlap.period_status)}). Choose different dates.`
    return
  }

  elements.overlap.className = 'payroll-overlap-result clear'
  elements.overlap.textContent =
    'No overlap found. This date range is available.'
}

async function checkOverlap() {
  const sequence = ++state.overlapSequence
  state.overlapRows = []

  if (validateDates()) {
    state.checkingOverlap = false
    renderOverlap()
    return
  }

  state.checkingOverlap = true
  renderOverlap()

  const { data, error } = await supabase.rpc(
    'payroll_check_period_overlap',
    periodPayload()
  )

  if (sequence !== state.overlapSequence) return

  state.checkingOverlap = false

  if (error) {
    state.overlapRows = [{ period_start: '', period_end: '', period_status: '' }]
    elements.overlap.className = 'payroll-overlap-result blocked'
    elements.overlap.textContent =
      'The overlap check could not be completed. Refresh and try again.'
    elements.createButton.disabled = true
    return
  }

  state.overlapRows = data || []
  renderOverlap()
}

function syncPaymentDate() {
  elements.payment.min = elements.end.value || ''
  if (
    elements.payment.value &&
    elements.end.value &&
    elements.payment.value < elements.end.value
  ) {
    elements.payment.value = elements.end.value
  }
}

async function createPeriod(event) {
  event.preventDefault()

  const validationMessage = validateDates({ includePayment: true })
  if (validationMessage) {
    setMessage(validationMessage, 'error')
    return
  }

  await checkOverlap()
  if (state.overlapRows.length || state.checkingOverlap) {
    setMessage('Resolve the payroll-period overlap before creating this draft.', 'error')
    return
  }

  elements.createButton.disabled = true
  setMessage('Creating the draft period and loading eligible employees…')

  const { data, error } = await supabase.rpc('payroll_create_period', {
    ...periodPayload(),
    p_payment_date: elements.payment.value
  })

  if (error) {
    const safeMessage = String(error.message || '')
    setMessage(
      safeMessage.includes('overlap') ||
      safeMessage.includes('already exists') ||
      safeMessage.includes('Payment date')
        ? safeMessage
        : 'The payroll period could not be created. Refresh and try again.',
      'error'
    )
    elements.createButton.disabled = false
    return
  }

  const periodId = data?.period_id
  setMessage(
    `Draft created with ${Number(data?.eligible_employee_count || 0)} eligible employees.`,
    'success'
  )

  if (periodId) {
    window.location.assign(
      `./payroll-period.html?id=${encodeURIComponent(periodId)}`
    )
  } else {
    await loadPeriods()
  }
}

async function initialize() {
  try {
    const access = await loadCurrentWorkforceAccess(supabase)

    if (!access.authenticated) {
      window.location.replace(
        './login.html?returnTo=payroll-dashboard.html'
      )
      return
    }

    if (!access.allowed || !hasProcessingAccess(access)) {
      window.alert('You do not have permission to access payroll period management.')
      window.location.replace('./home.html')
      return
    }

    state.canCreate = hasWorkforcePermission(access, 'create_payroll')
    elements.createCard.hidden = !state.canCreate
    elements.agentRatesLink.hidden =
      !hasWorkforcePermission(access, 'manage_agent_rates')
    document.body.classList.remove('payroll-access-pending')

    await loadPeriods()
  } catch {
    window.location.replace('./home.html')
  }
}

elements.start.addEventListener('change', checkOverlap)
elements.end.addEventListener('change', () => {
  syncPaymentDate()
  checkOverlap()
})
elements.payment.addEventListener('change', () => setMessage(''))
elements.form.addEventListener('submit', createPeriod)
elements.refresh.addEventListener('click', loadPeriods)
document.addEventListener('DOMContentLoaded', initialize)
